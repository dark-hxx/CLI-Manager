import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { file, source, checker, imports, nodes, nameNode, nameOf, references, localReferences,
  store, initializer, stateObject, actionNames, actionNodes, assignments, groups } from "./plan-terminal-store.mjs";

const root = "src/features/terminal";
const files = {
  store: `${root}/store/terminalStore.ts`, runtime: `${root}/store/terminalRuntime.ts`,
  types: `${root}/types/terminalStoreTypes.ts`, layout: `${root}/lib/terminalStoreLayout.ts`,
  subagent: `${root}/lib/subagentTranscriptModel.ts`, launch: `${root}/lib/terminalLaunch.ts`,
  status: `${root}/lib/terminalStatus.ts`,
};
const relative = (from, to) => {
  const result = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, "");
  return result.startsWith(".") ? result : `./${result}`;
};
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const runtimeNames = groups.runtime.map(nameOf);
const remainingActions = stateObject.properties.filter(node => !actionNames.has(node.name.getText(source)));
const rootRuntimeNames = [...new Set(remainingActions.flatMap(localReferences))].filter(name => runtimeNames.includes(name));
assert.ok(!groups.runtime.some(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)));
function prefix(group, items) {
  const dependencies = new Set(items.flatMap(node => [...references(node)]));
  const result = [];
  for (const item of imports) {
    const clause = item.importClause;
    assert.ok(clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name);
    const names = clause.namedBindings.elements.filter(binding => dependencies.has(checker.getSymbolAtLocation(binding.name)))
      .map(binding => group === "types" ? ts.factory.updateImportSpecifier(binding, false, binding.propertyName, binding.name) : binding);
    if (!names.length) continue;
    const specifier = item.moduleSpecifier.text;
    const target = specifier.startsWith(".")
      ? relative(files[group], path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))) : specifier;
    result.push(printer.printNode(ts.EmitHint.Unspecified, ts.factory.updateImportDeclaration(item, item.modifiers,
      ts.factory.updateImportClause(clause, group === "types" || clause.isTypeOnly, undefined, ts.factory.updateNamedImports(clause.namedBindings, names)),
      ts.factory.createStringLiteral(target), item.attributes), source));
  }
  for (const [other, items] of Object.entries(groups)) {
    if (other === group || other === "store" || other === "runtime") continue;
    const required = items.filter(node => dependencies.has(checker.getSymbolAtLocation(nameNode(node))));
    if (!required.length) continue;
    const names = required.map(node => `${group !== "types" && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) ? "type " : ""}${nameOf(node)}`);
    result.push(`import ${group === "types" ? "type " : ""}{ ${names.join(", ")} } from "${relative(files[group], files[other])}";`);
  }
  return result.join("\n");
}
const outputs = new Map();
for (const group of ["types", "layout", "subagent", "launch", "status"]) {
  const body = groups[group].map(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ? node.getText(source) : `export ${node.getText(source)}`).join("\n\n");
  outputs.set(files[group], `${prefix(group, groups[group])}\n\n${body}\n`);
}
const actionType = `Pick<TerminalStore, ${[...actionNames].map(name => JSON.stringify(name)).join(" | ")}>`;
const runtimeBody = `export function createTerminalRuntime(\n  set: StoreApi<TerminalStore>["setState"],\n  get: StoreApi<TerminalStore>["getState"],\n  useTerminalStore: StoreApi<TerminalStore>,\n) {\n`
  + `${groups.runtime.map(node => node.getText(source)).join("\n\n")}\n\n`
  + `const actions: ${actionType} = {\n${actionNodes.map(node => node.getText(source) + ",").join("\n\n")}\n};\n\n`
  + `return { actions,\n${rootRuntimeNames.map(name => `  ${name},`).join("\n")}\n};\n}\n`;
outputs.set(files.runtime, `import type { StoreApi } from "zustand";\nimport type { TerminalStore } from "../types/terminalStoreTypes";\n${prefix("runtime", [...groups.runtime, ...actionNodes])}\n\n${runtimeBody}`);

let objectText = stateObject.getText(source);
for (const node of [...actionNodes].sort((a, b) => b.pos - a.pos)) {
  const start = node.getStart(source) - stateObject.getStart(source), end = node.end - stateObject.getStart(source);
  objectText = objectText.slice(0, start) + `${node.name.getText(source)}: runtimeActions.${node.name.getText(source)}` + objectText.slice(end);
}
const newInitializer = `(set, get, api) => {\n  const { actions: runtimeActions,\n${rootRuntimeNames.map(name => `    ${name},`).join("\n")}\n  } = createTerminalRuntime(set, get, api);\n  return ${objectText};\n}`;
const storeText = store.getText(source).replace(initializer.getText(source), newInitializer);
outputs.set(files.store, `${prefix("store", [...groups.store.filter(node => node !== store), ...remainingActions])}\nimport { create } from "zustand";\nimport { createTerminalRuntime } from "./terminalRuntime";\n\n`
  + `${groups.store.filter(node => node !== store).map(node => node.getText(source)).join("\n\n")}\n\n${storeText}\n\nstartPtyOrphanReconcileHeartbeat();\n`);

const publicNodes = nodes.filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
const entry = `${root}/state.ts`;
const publicExports = Object.entries(groups).flatMap(([group, items]) => {
  const exposed = items.filter(node => publicNodes.includes(node));
  return exposed.length ? [`export {\n${exposed.map(node => `  ${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)},`).join("\n")}\n} from "${relative(entry, files[group])}";`] : [];
});
outputs.set(entry, publicExports.join("\n") + "\n");

// TypeScript's formatter preserves multiline literals and only edits whitespace.
function format(file, text) {
  const service = ts.createLanguageService({
    getCompilationSettings: () => ({ target: ts.ScriptTarget.Latest }), getScriptFileNames: () => [file],
    getScriptVersion: () => "0", getScriptSnapshot: name => name === file ? ts.ScriptSnapshot.fromString(text) : undefined,
    getCurrentDirectory: () => process.cwd(), getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile,
  });
  const edits = service.getFormattingEditsForDocument(file, {
    indentSize: 2, tabSize: 2, convertTabsToSpaces: true, newLineCharacter: "\n",
    insertSpaceAfterCommaDelimiter: true, insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true, insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
  });
  for (const edit of edits.sort((a, b) => b.span.start - a.span.start)) text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
  service.dispose();
  return text.replace(/^(import(?: type)? \{)\s*([^{}]+?)\s*(\} from [^\n]+)$/gm, (line, start, middle, end) => {
    if (line.length <= 120) return line;
    const rows = []; let row = " ";
    for (const name of middle.split(",").map(name => name.trim()).filter(Boolean)) {
      if (row.length + name.length > 100) { rows.push(row); row = " "; }
      row += ` ${name},`;
    }
    rows.push(row);
    return `${start.trimEnd()}\n${rows.join("\n")}\n${end.trimStart()}`;
  });
}
for (const [destination, text] of outputs) {
  assert.ok(!existsSync(destination), destination);
  const formatted = format(destination, text);
  assert.ok(formatted.trimEnd().split("\n").length <= 2000, destination);
  outputs.set(destination, formatted);
}
const parsedFiles = new Map([...outputs].map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]));
for (const parsed of parsedFiles.values()) assert.equal(parsed.parseDiagnostics.length, 0, parsed.fileName);
const runtimeFunction = parsedFiles.get(files.runtime).statements.find(node => node.name?.text === "createTerminalRuntime");
const topDeclarations = [...parsedFiles.values()].flatMap(parsed => [...parsed.statements]);
const generatedDeclarations = [...topDeclarations, ...runtimeFunction.body.statements];
const getName = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText() : node.name?.text;
const canonicalPrinter = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const canonical = node => canonicalPrinter.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()).replace(/^export\s+/, "");
for (const node of nodes.filter(node => node !== store)) {
  const matches = generatedDeclarations.filter(other => getName(other) === nameOf(node));
  assert.equal(matches.length, 1, nameOf(node));
  assert.equal(canonical(matches[0]), canonical(node), nameOf(node));
}
const generatedStore = parsedFiles.get(files.store).statements.find(node => getName(node) === "useTerminalStore");
const generatedInitializer = generatedStore.declarationList.declarations[0].initializer.arguments[0];
const generatedObject = generatedInitializer.body.statements.at(-1).expression;
const generatedActions = runtimeFunction.body.statements.find(node => getName(node) === "actions").declarationList.declarations[0].initializer;
assert.deepEqual(generatedObject.properties.map(node => node.name.getText()), stateObject.properties.map(node => node.name.getText()));
for (const node of stateObject.properties) {
  const name = node.name.getText();
  const owner = actionNames.has(name) ? generatedActions : generatedObject;
  assert.equal(canonical(owner.properties.find(node => node.name.getText() === name)), canonical(node), name);
}
assert.deepEqual(generatedInitializer.parameters.map(node => node.name.getText()), ["set", "get", "api"]);
console.log(JSON.stringify({ files: [...outputs].map(([file, text]) => ({ file, lines: text.trimEnd().split("\n").length })), rootRuntimeNames }));
if (process.argv.includes("--write")) {
  for (const [destination, text] of outputs) { mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, text); }
  writeFileSync(file, `export {\n${publicNodes.map(node => `  ${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)},`).join("\n")}\n} from "@/features/terminal/state";\n`);
}
