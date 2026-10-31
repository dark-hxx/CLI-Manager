import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const messages = path.join(root, "src/shared/i18n/messages");
function read(locale) {
  const result = {};
  for (const filename of fs.readdirSync(messages).filter(name => name.endsWith(`.${locale}.ts`))) {
    const ast = ts.createSourceFile(filename, fs.readFileSync(path.join(messages, filename), "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        let initializer = declaration.initializer;
        while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
        if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue;
        for (const property of initializer.properties) {
          if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isStringLiteral(property.initializer)) {
            result[property.name.text] = property.initializer.text;
          }
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
const zh = read("zh-CN");
const en = read("en-US");
if (JSON.stringify(Object.keys(zh)) !== JSON.stringify(Object.keys(en))) throw new Error("zh-CN/en-US key sets differ");
for (const [key, value] of Object.entries(zh)) {
  const placeholders = value.match(/\{\w+\}/g) ?? [];
  const english = en[key].match(/\{\w+\}/g) ?? [];
  if (placeholders.toSorted().join("\0") !== english.toSorted().join("\0")) throw new Error(`placeholder mismatch: ${key}`);
}
for (const [locale, values] of Object.entries({ "zh-CN": zh, "en-US": en })) {
  const content = `${JSON.stringify(values, null, 2)}\n`;
  const target = path.join(root, "apps/desktop-gpui/assets/i18n", `${locale}.json`);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) throw new Error(`i18n asset out of date: ${locale}`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
console.log(`GPUI i18n: ${Object.keys(zh).length} keys${process.argv.includes("--check") ? " checked" : " exported"}.`);
