import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// 仅静态求值默认值引用的字面量与常量，不加载 Zustand、Tauri 或任何运行时模块。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = new Map();
function sourceModule(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const ast = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  const imports = new Map();
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration.initializer);
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const binding of statement.importClause.namedBindings.elements) {
        if (statement.importClause.isTypeOnly || binding.isTypeOnly) continue;
        imports.set(binding.name.text, {
          module: statement.moduleSpecifier.text,
          name: binding.propertyName?.text ?? binding.name.text,
        });
      }
    }
  }
  const module = { ast, declarations, imports, values: new Map() };
  cache.set(filename, module);
  return module;
}

function constant(filename, name, visiting = new Set()) {
  const module = sourceModule(filename);
  if (module.values.has(name)) return module.values.get(name);
  const key = `${filename}:${name}`;
  if (visiting.has(key)) throw new Error(`循环默认值引用: ${key}`);
  const next = new Set(visiting).add(key);
  let value;
  if (module.declarations.has(name)) {
    value = evaluate(filename, module.declarations.get(name), next);
  } else if (module.imports.has(name)) {
    const imported = module.imports.get(name);
    if (!imported.module.startsWith(".")) throw new Error(`默认值依赖外部模块: ${key}`);
    const base = path.resolve(path.dirname(filename), imported.module);
    const target = [base, `${base}.ts`, path.join(base, "index.ts")].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!target) throw new Error(`无法解析 ${imported.module}`);
    value = constant(target, imported.name, next);
  } else throw new Error(`未知默认值常量: ${key}`);
  module.values.set(name, value);
  return value;
}

function evaluate(filename, expression, visiting) {
  if (!expression) throw new Error(`默认值缺少初始化: ${filename}`);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expression)) return constant(filename, expression.text, visiting);
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return evaluate(filename, expression.expression, visiting);
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken) {
    return -evaluate(filename, expression.operand, visiting);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const result = {};
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) Object.assign(result, evaluate(filename, property.expression, visiting));
      else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
        result[property.name.text] = evaluate(filename, property.initializer, visiting);
      } else throw new Error(`不支持的默认值属性: ${property.getText()}`);
    }
    return result;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap(element => ts.isSpreadElement(element)
      ? evaluate(filename, element.expression, visiting)
      : [evaluate(filename, element, visiting)]);
  }
  throw new Error(`不支持的默认值表达式: ${expression.getText()} (${filename})`);
}

const defaults = constant(path.join(root, "src/shared/preferences/settingsStore.ts"), "DEFAULTS");
const output = `${JSON.stringify(defaults, null, 2)}\n`;
const target = path.join(root, "crates/core-prefs/fixtures/settings-defaults.json");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== output) {
    throw new Error("Rust 设置默认值已过期，请运行 node scripts/export-settings-defaults.mjs");
  }
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output);
}
console.log(`Settings defaults: ${Object.keys(defaults).length} fields${process.argv.includes("--check") ? " checked" : " exported"}.`);
