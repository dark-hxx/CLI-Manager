import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const originalFile = "src/components/settings/pages/HookSettingsPage.tsx";
const original = readFileSync(originalFile, "utf8").replaceAll("\r\n", "\n");
const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const source = parse(originalFile, original);
const imports = source.statements.filter(ts.isImportDeclaration);
const declarations = source.statements.filter(node => !ts.isImportDeclaration(node));
const nameOf = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText(source) : node.name?.getText(source);
const controlStart = declarations.findIndex(node => nameOf(node) === "PathRow");
const pageStart = declarations.findIndex(node => nameOf(node) === "HookSettingsPage");
assert.ok(controlStart > 0 && pageStart > controlStart && pageStart === declarations.length - 1);
const modules = [
  { file: "src/features/settings/lib/hookSettingsModel.ts", nodes: declarations.slice(0, controlStart) },
  { file: "src/features/settings/components/HookSettingsControls.tsx", nodes: declarations.slice(controlStart, pageStart) },
  { file: "src/features/settings/components/HookSettingsPage.tsx", nodes: declarations.slice(pageStart) },
];
function identifiers(nodes) {
  const names = new Set();
  const visit = node => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, visit); };
  nodes.forEach(visit);
  return names;
}
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const relative = (from, to) => {
  const specifier = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, "");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
};
const outputs = new Map();
for (const module of modules) {
  assert.ok(!existsSync(module.file), module.file);
  const refs = identifiers(module.nodes);
  const localNames = new Set(module.nodes.map(nameOf));
  const prefix = [];
  for (const item of imports) {
    const clause = item.importClause;
    assert.ok(clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name);
    const bindings = clause.namedBindings.elements.filter(binding => refs.has(binding.name.text) && !localNames.has(binding.name.text));
    if (!bindings.length) continue;
    const specifier = item.moduleSpecifier.text;
    const target = specifier.startsWith(".") ? relative(module.file, path.posix.normalize(path.posix.join(path.posix.dirname(originalFile), specifier))) : specifier;
    const updated = ts.factory.updateImportDeclaration(item, item.modifiers,
      ts.factory.updateImportClause(clause, clause.isTypeOnly, undefined, ts.factory.updateNamedImports(clause.namedBindings, bindings)),
      ts.factory.createStringLiteral(target), item.attributes);
    prefix.push(printer.printNode(ts.EmitHint.Unspecified, updated, source));
  }
  for (const dependency of modules.filter(other => other !== module)) {
    const required = dependency.nodes.filter(node => refs.has(nameOf(node)));
    if (!required.length) continue;
    const bindings = required.map(node => `${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)}`);
    prefix.push(`import { ${bindings.join(", ")} } from "${relative(module.file, dependency.file)}";`);
  }
  const body = module.nodes.map(node => {
    const text = node.getText(source);
    return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? text : `export ${text}`;
  }).join("\n\n");
  const output = `${prefix.join("\n")}\n\n${body}\n`;
  assert.ok(output.split("\n").length <= 2000, module.file);
  const extracted = parse(module.file, output).statements.filter(node => !ts.isImportDeclaration(node));
  assert.deepEqual(extracted.map(node => node.getText().replace(/^export /, "")), module.nodes.map(node => node.getText(source).replace(/^export /, "")));
  outputs.set(module.file, output);
}
const entry = "src/features/settings/index.ts";
assert.ok(!existsSync(entry));
outputs.set(entry, 'export { HookSettingsPage } from "./components/HookSettingsPage";\n');
outputs.set(originalFile, 'export { HookSettingsPage } from "@/features/settings";\n');
for (const [file, content] of outputs) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`Extracted ${declarations.length} declarations with exact bodies into model, controls and feature page; legacy export preserved.`);
