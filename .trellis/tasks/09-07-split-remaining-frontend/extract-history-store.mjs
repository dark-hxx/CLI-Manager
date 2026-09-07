import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const file = "src/stores/historyStore.ts";
const original = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const host = ts.createCompilerHost({ noResolve: true });
const originalRead = host.readFile.bind(host);
host.readFile = name => path.resolve(name) === path.resolve(file) ? original : originalRead(name);
const program = ts.createProgram([file], { noResolve: true, target: ts.ScriptTarget.Latest, skipLibCheck: true }, host);
const source = program.getSourceFile(file);
const checker = program.getTypeChecker();
const imports = source.statements.filter(ts.isImportDeclaration);
const nodes = source.statements.filter(node => !ts.isImportDeclaration(node));
const nameNode = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name : node.name;
const nameOf = node => nameNode(node).getText(source);
const symbols = new Map(nodes.map(node => [checker.getSymbolAtLocation(nameNode(node)), nameOf(node)]));
const references = node => {
  const found = new Set();
  const visit = child => { if (ts.isIdentifier(child)) { const symbol = checker.getSymbolAtLocation(child); if (symbol) found.add(symbol); } ts.forEachChild(child, visit); };
  visit(node);
  found.delete(checker.getSymbolAtLocation(nameNode(node)));
  return found;
};
const refs = new Map(nodes.map(node => [nameOf(node), references(node)]));
const localRefs = node => [...refs.get(nameOf(node))].map(symbol => symbols.get(symbol)).filter(Boolean);
const groupOf = node => {
  const name = nameOf(node);
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return "types";
  if (/^(useHistoryStore|historyMeta|historyOpenRequestSeq|sessionListRequestSeq|sessionDetailRequestSeq|globalSearchRequestSeq|historyIndex|statsRequestSeq|automaticTitle|smartTitleRequestKinds|MAX_AUTOMATIC)/.test(name)) return "store";
  if (/^(normalize|asString$|asNumber$|parseTags$|makeSessionKey$|summarySessionKey$|hitSessionKey$|claudeProjectKeyFromPath$|projectLastSegment$|getHistoryPathCacheKey$|makeStats|effectiveProjectPathFilter$|findHistoryProject$|remoteSourceMatchesFilter$|snapshotMatchesFilters$)/.test(name)) return "normalization";
  if (/^(statsCache|statsProjectOptionsCache|STATS_|DEFAULT_|SESSION_PAGE_|MIN_GLOBAL_)/.test(name)) return "cache";
  if (/^(fetch|syncHistory|syncRemote|requestRemote|remoteHistorySyncRequests$|requestLogSync|invalidate)/.test(name)) return "requests";
  if (/^(read|writeFavorite|deleteFavorite|toViewWithGeneratedTitle$|applyMeta$|sortSessionViews$|viewToSummary$|snapshotToSummary$|insertEditAuditRecord$|mergeDetailIntoSessions$|applyFavoriteSnapshots$|titleSourceIdentity$|generatedTitleView$)/.test(name)) return "metadata";
  return "store";
};
const assignments = new Map(nodes.map(node => [nameOf(node), groupOf(node)]));
// Keep every helper that closes over the Store or its request counters beside it.
let changed = true;
while (changed) {
  changed = false;
  for (const node of nodes) {
    const name = nameOf(node);
    if (assignments.get(name) !== "store" && localRefs(node).some(dependency => assignments.get(dependency) === "store")) {
      assignments.set(name, "store"); changed = true;
    }
  }
}
const files = {
  store: "src/features/history/store/historyStore.ts",
  types: "src/features/history/types/historyStoreTypes.ts",
  normalization: "src/features/history/lib/historyNormalization.ts",
  cache: "src/features/history/lib/historyCache.ts",
  requests: "src/features/history/lib/historyRequests.ts",
  metadata: "src/features/history/lib/historyMetadata.ts",
};
const groups = Object.keys(files).map(name => ({ name, file: files[name], nodes: nodes.filter(node => assignments.get(nameOf(node)) === name) }));
const edges = new Map(groups.map(group => [group.name, new Set(group.nodes.flatMap(localRefs).map(name => assignments.get(name)).filter(name => name !== group.name))]));
function checkCycles(name, stack = []) {
  assert.ok(!stack.includes(name), `cycle: ${[...stack, name].join(" -> ")}`);
  for (const next of edges.get(name)) checkCycles(next, [...stack, name]);
}
for (const group of groups) checkCycles(group.name);
const relative = (from, to) => {
  const value = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, "");
  return value.startsWith(".") ? value : `./${value}`;
};
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const outputs = new Map();
for (const group of groups) {
  assert.ok(group.nodes.length && !existsSync(group.file), group.file);
  const dependencies = new Set(group.nodes.flatMap(node => [...refs.get(nameOf(node))]));
  const prefix = [];
  for (const item of imports) {
    const clause = item.importClause;
    assert.ok(clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name);
    const bindings = clause.namedBindings.elements.filter(binding => dependencies.has(checker.getSymbolAtLocation(binding.name)));
    if (!bindings.length) continue;
    const specifier = item.moduleSpecifier.text;
    const target = specifier.startsWith(".") ? relative(group.file, path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))) : specifier;
    const updated = ts.factory.updateImportDeclaration(item, item.modifiers,
      ts.factory.updateImportClause(clause, clause.isTypeOnly, undefined, ts.factory.updateNamedImports(clause.namedBindings, bindings)),
      ts.factory.createStringLiteral(target), item.attributes);
    prefix.push(printer.printNode(ts.EmitHint.Unspecified, updated, source));
  }
  for (const other of groups.filter(other => other !== group)) {
    const required = other.nodes.filter(node => dependencies.has(checker.getSymbolAtLocation(nameNode(node))));
    if (required.length) prefix.push(`import { ${required.map(node => `${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)}`).join(", ")} } from "${relative(group.file, other.file)}";`);
  }
  const body = group.nodes.map(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? node.getText(source) : `export ${node.getText(source)}`).join("\n\n");
  const text = `${prefix.join("\n")}\n\n${body}\n`;
  assert.ok(text.split("\n").length <= 2000, `${group.file}: ${text.split("\n").length}`);
  const parsed = ts.createSourceFile(group.file, text, ts.ScriptTarget.Latest, true);
  assert.deepEqual(parsed.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText().replace(/^export /, "")), group.nodes.map(node => node.getText(source).replace(/^export /, "")));
  outputs.set(group.file, text);
}
const publicNodes = nodes.filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
const entry = "src/features/history/index.ts";
assert.ok(!existsSync(entry));
const publicExports = groups.flatMap(group => {
  const exposed = publicNodes.filter(node => assignments.get(nameOf(node)) === group.name);
  return exposed.length ? [`export { ${exposed.map(node => `${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)}`).join(", ")} } from "${relative(entry, group.file)}";`] : [];
});
outputs.set(entry, publicExports.join("\n") + "\n");
outputs.set(file, `export { ${publicNodes.map(node => `${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)}`).join(", ")} } from "@/features/history";\n`);
if (!process.argv.includes("--write")) console.log(JSON.stringify({ groups: groups.map(group => ({ name: group.name, lines: outputs.get(group.file).split("\n").length, dependencies: [...edges.get(group.name)] })), symbols: nodes.filter(node => assignments.get(nameOf(node)) !== "store").map(nameOf) }));
else {
  for (const [target, content] of outputs) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); }
  console.log(`Moved ${nodes.length} declarations into ${groups.length} acyclic history modules; single Store and declaration bodies preserved.`);
}
