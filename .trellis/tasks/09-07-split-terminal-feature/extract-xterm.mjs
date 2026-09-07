import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const file = "src/components/XTermTerminal.tsx";
const original = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const host = ts.createCompilerHost({ noResolve: true, jsx: ts.JsxEmit.ReactJSX });
host.readFile = name => name.replaceAll("\\", "/").endsWith(file) ? original : ts.sys.readFile(name);
const program = ts.createProgram([file], { noResolve: true, jsx: ts.JsxEmit.ReactJSX }, host);
const source = program.getSourceFile(file);
const checker = program.getTypeChecker();
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === "XTermTerminal");
assert.ok(component);
const returned = component.body.statements.at(-1);
assert.ok(ts.isReturnStatement(returned));
const imports = source.statements.filter(ts.isImportDeclaration);
const helpers = source.statements.filter(node => !ts.isImportDeclaration(node) && node !== component);
const nameOf = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText(source) : node.name.text;
const flag = helpers.find(node => nameOf(node) === "terminalImageAddonFallbackLogged");
const diagnosticNames = new Set([
  "TextDiagnosticSummary", "CodexImeDebugState", "TerminalSubsystemDisposable", "summarizeTextForDiagnostics",
  "disposeTerminalSubsystem", "lineHasVisibleTextAfterColumn", "canShowSuggestionAtCurrentInputEnd",
  "withVisibleSelectionTheme", "serializeBufferPlainText",
]);
const linkNames = new Set([
  "getTerminalRenderedCellSize", "TerminalLinkIconKind", "TerminalPathKind", "TerminalLinkHoverIcon",
  "createTerminalLinkHoverIcon", "expiredAttachmentsCleanup", "cleanupExpiredAttachmentsOnce", "openHttpUrl",
  "getTerminalFileLinkContext", "resolveRelativeTerminalSystemPath", "openTerminalFilePath", "openTerminalRelativeFilePath",
]);
const root = "src/features/terminal";
const groups = [
  { file: `${root}/lib/xTermDiagnostics.ts`, nodes: helpers.filter(node => diagnosticNames.has(nameOf(node))) },
  { file: `${root}/lib/xTermLinks.ts`, nodes: helpers.filter(node => linkNames.has(nameOf(node))) },
  { file: `${root}/types/xTermModel.ts`, nodes: helpers.filter(node => node !== flag && !diagnosticNames.has(nameOf(node)) && !linkNames.has(nameOf(node))) },
];
const parse = text => ts.createSourceFile("generated.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function identifiers(node) {
  const result = new Set();
  const visit = current => { if (ts.isIdentifier(current)) result.add(current.text); ts.forEachChild(current, visit); };
  visit(node);
  return result;
}
const viewNames = new Set();
const visit = current => {
  if (ts.isIdentifier(current)) {
    const symbol = ts.isShorthandPropertyAssignment(current.parent)
      ? checker.getShorthandAssignmentValueSymbol(current.parent) : checker.getSymbolAtLocation(current);
    const declaration = symbol?.valueDeclaration;
    if (declaration && (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration) || ts.isParameter(declaration))
      && declaration.getSourceFile() === source && declaration.pos >= component.pos
      && declaration.end < returned.getStart(source)) viewNames.add(current.text);
  }
  ts.forEachChild(current, visit);
};
visit(returned);
const relative = (from, to) => {
  const result = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, "");
  return result.startsWith(".") ? result : `./${result}`;
};
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
function prefix(destination, body) {
  const refs = identifiers(parse(body));
  const result = [];
  for (const item of imports) {
    const clause = item.importClause;
    assert.ok(clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name);
    const names = clause.namedBindings.elements.filter(binding => refs.has(binding.name.text));
    if (!names.length) continue;
    const specifier = item.moduleSpecifier.text;
    const target = specifier.startsWith(".")
      ? relative(destination, path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))) : specifier;
    const updated = ts.factory.updateImportDeclaration(item, item.modifiers,
      ts.factory.updateImportClause(clause, clause.isTypeOnly, undefined, ts.factory.updateNamedImports(clause.namedBindings, names)),
      ts.factory.createStringLiteral(target), item.attributes);
    result.push(printer.printNode(ts.EmitHint.Unspecified, updated, source));
  }
  for (const group of groups.filter(group => group.file !== destination)) {
    const names = group.nodes.filter(node => refs.has(nameOf(node))).map(node =>
      `${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)}`);
    if (names.length) result.push(`import { ${names.join(", ")} } from "${relative(destination, group.file)}";`);
  }
  return result.join("\n");
}
const outputs = new Map();
for (const group of groups) {
  const body = group.nodes.map(node => `export ${node.getText(source)}`).join("\n\n") + "\n";
  outputs.set(group.file, `${prefix(group.file, body)}\n\n${body}`);
}
const controllerFile = `${root}/hooks/useXTermController.ts`;
const viewFile = `${root}/components/XTermView.tsx`;
const head = component.getText(source).slice(0, component.body.getStart(source) - component.getStart(source))
  .replace("function XTermTerminal(", "function useXTermController(");
const statements = original.slice(component.body.getStart(source) + 1, returned.getStart(source));
const controller = `${flag.getText(source)}\n\n${head}{${statements}return {\n${[...viewNames].map(name => `    ${name},`).join("\n")}\n  };\n}\n`;
const view = `export function XTermView({\n${[...viewNames].map(name => `  ${name},`).join("\n")}\n}: ReturnType<typeof useXTermController>) {\n  ${returned.getText(source)}\n}\n`;
outputs.set(controllerFile, `${prefix(controllerFile, controller)}\n\n${controller}`);
outputs.set(viewFile, `import type { useXTermController } from "../hooks/useXTermController";\n${prefix(viewFile, view)}\n\n${view}`);
outputs.set(`${root}/components/XTermTerminal.tsx`, 'import { useXTermController } from "../hooks/useXTermController";\nimport { XTermView } from "./XTermView";\nimport type { Props } from "../types/xTermModel";\n\nexport function XTermTerminal(props: Props) {\n  return <XTermView {...useXTermController(props)} />;\n}\n');
outputs.set(`${root}/index.ts`, 'export { XTermTerminal } from "./components/XTermTerminal";\n');

// Wrap import bindings only; leave declaration bodies byte-for-byte intact.
for (const [destination, output] of outputs) {
  const formatted = output.replace(/^(import(?: type)? \{ )([^\n]+)( \} from [^\n]+)$/gm, (line, start, middle, end) => {
    if (line.length <= 120) return line;
    const rows = [];
    let row = " ";
    for (const item of middle.split(", ")) {
      if (row.length + item.length > 100) { rows.push(row); row = " "; }
      row += ` ${item},`;
    }
    rows.push(row);
    return `${start.trimEnd()}\n${rows.join("\n")}\n${end.trimStart()}`;
  });
  assert.ok(!existsSync(destination), destination);
  assert.equal(parse(formatted).parseDiagnostics.length, 0, destination);
  assert.ok(formatted.trimEnd().split("\n").length <= 2000, destination);
  outputs.set(destination, formatted);
}
for (const node of helpers) {
  assert.equal([...outputs.values()].filter(output => output.includes(node.getText(source))).length, 1, nameOf(node));
}
assert.ok(outputs.get(controllerFile).includes(statements));
assert.ok(outputs.get(viewFile).includes(returned.getText(source)));
console.log(JSON.stringify({ files: [...outputs].map(([file, text]) => ({ file, lines: text.trimEnd().split("\n").length })), viewNames: [...viewNames] }));
if (process.argv.includes("--write")) {
  for (const [destination, output] of outputs) {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, output);
  }
  writeFileSync(file, 'export { XTermTerminal } from "@/features/terminal";\n');
}
