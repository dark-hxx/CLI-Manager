import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const file = "src/stores/terminalStore.ts";
export const original = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const host = ts.createCompilerHost({ noResolve: true });
const read = host.readFile.bind(host);
host.readFile = name => path.resolve(name) === path.resolve(file) ? original : read(name);
export const program = ts.createProgram([file], { noResolve: true, target: ts.ScriptTarget.Latest }, host);
export const source = program.getSourceFile(file);
export const checker = program.getTypeChecker();
export const imports = source.statements.filter(ts.isImportDeclaration);
export const nodes = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExpressionStatement(node));
export const nameNode = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name : node.name;
export const nameOf = node => nameNode(node).getText(source);
const symbols = new Map(nodes.map(node => [checker.getSymbolAtLocation(nameNode(node)), nameOf(node)]));
export const references = node => {
  const result = new Set();
  const visit = child => {
    if (ts.isIdentifier(child)) {
      const symbol = ts.isShorthandPropertyAssignment(child.parent)
        ? checker.getShorthandAssignmentValueSymbol(child.parent) : checker.getSymbolAtLocation(child);
      if (symbol) result.add(symbol);
    }
    ts.forEachChild(child, visit);
  };
  visit(node); return result;
};
export const localReferences = node => [...references(node)].map(symbol => symbols.get(symbol)).filter(Boolean);
export const store = nodes.find(node => nameOf(node) === "useTerminalStore");
export const initializer = store.declarationList.declarations[0].initializer.arguments[0];
assert.ok(ts.isArrowFunction(initializer) && ts.isParenthesizedExpression(initializer.body));
export const stateObject = initializer.body.expression;
assert.ok(ts.isObjectLiteralExpression(stateObject));
export const actionNames = new Set([
  "markAttentionInputHandled", "handleCliHookEvent", "handleShellRuntimeEvent",
  "openSubagentTranscript", "finishSubagentTranscript", "appendSubagentTranscript",
]);
export const actionNodes = stateObject.properties.filter(node => actionNames.has(node.name.getText(source)));
assert.equal(actionNodes.length, actionNames.size);
export const assignments = new Map(nodes.map(node => {
  const name = nameOf(node);
  if (name === "useTerminalStore" || name === "restoreInProgress" || name === "startPtyOrphanReconcileHeartbeat") return [name, "store"];
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return [name, "types"];
  if (ts.isVariableStatement(node) && !(node.declarationList.flags & ts.NodeFlags.Const)) return [name, "runtime"];
  if (["subagentCloseTimers", "subagentDiscoveryTimers", "subagentTranscriptRetryTimers", "subagentTranscriptRetryDiagnostics", "hookRunningTimeouts"].includes(name)) return [name, "runtime"];
  return [name, "helpers"];
}));
let changed = true;
while (changed) {
  changed = false;
  for (const node of nodes) {
    const name = nameOf(node);
    if (assignments.get(name) !== "helpers") continue;
    if (localReferences(node).some(dependency => dependency === "useTerminalStore" || assignments.get(dependency) === "runtime")) {
      assignments.set(name, "runtime"); changed = true;
    }
  }
}
export const groups = Object.fromEntries(["store", "types", "helpers", "runtime"].map(name => [name, nodes.filter(node => assignments.get(nameOf(node)) === name)]));
// Pure helpers are further organized by domain; dependencies may point inward to these modules.
const launchStart = nodes.findIndex(node => nameOf(node) === "supportsShellRuntimeInjection");
const launchEnd = nodes.findIndex(node => nameOf(node) === "createDetachedPtyProcess");
const subagentStart = nodes.findIndex(node => nameOf(node) === "trimOptional");
const subagentEnd = nodes.findIndex(node => nameOf(node) === "findSubagentSessionId");
const layoutNames = new Set(["buildWorkspanMirror", "persistWorkspanState", "createFileEditorSessionId",
  "clearProjectEditorWorkspacesIfUnused", "isPersistableSession", "hasBackendPty", "createSplitSessionTitle", "releaseRemoteHistoryConsumer"]);
for (const node of groups.helpers) {
  const name = nameOf(node), index = nodes.indexOf(node);
  const group = layoutNames.has(name) ? "layout"
    : (index >= subagentStart && index <= subagentEnd) || name === "hasCodexTerminalEvent" ? "subagent"
    : index >= launchStart && index <= launchEnd && !name.startsWith("apply") ? "launch" : "status";
  assignments.set(name, group);
}
delete groups.helpers;
for (const group of ["layout", "subagent", "launch", "status"]) groups[group] = nodes.filter(node => assignments.get(nameOf(node)) === group);
export const edges = new Map(Object.entries(groups).map(([name, items]) => [name,
  new Set([...items, ...(name === "runtime" ? actionNodes : [])].flatMap(localReferences)
    .filter(dependency => !(name === "runtime" && dependency === "useTerminalStore"))
    .map(dependency => assignments.get(dependency)).filter(dependency => dependency !== name))]));
// The store consumes factory outputs, not an import from its own runtime implementation back to the store.
function checkCycles(name, stack = []) {
  if (name === "types") return; // All imports emitted by the type-only module are type imports.
  assert.ok(!stack.includes(name), `cycle: ${[...stack, name].join(" -> ")}`);
  for (const dependency of edges.get(name)) checkCycles(dependency, [...stack, name]);
}
for (const name of edges.keys()) checkCycles(name);
const lines = node => node.getText(source).split("\n").length;
const report = Object.fromEntries(Object.entries(groups).map(([name, nodes]) => [name, {
  lines: nodes.reduce((sum, node) => sum + lines(node) + 1, 0), names: nodes.map(nameOf),
}]));
report.runtime.lines += actionNodes.reduce((sum, node) => sum + lines(node), 0);
report.store.lines -= actionNodes.reduce((sum, node) => sum + lines(node), 0);
const publicRuntime = groups.runtime.filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).map(nameOf);
if (process.argv[1]?.endsWith("plan-terminal-store.mjs")) console.log(JSON.stringify({ groups: report, publicRuntime, actions: [...actionNames], symbols: nodes.filter(node => nameOf(node) !== "restoreInProgress").map(nameOf) }));
