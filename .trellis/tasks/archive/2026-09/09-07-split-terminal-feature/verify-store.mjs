import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const parse = (file, text) => ts.createSourceFile(file, text.replaceAll("\r\n", "\n"), ts.ScriptTarget.Latest, true);
const before = parse("terminalStore.ts", execFileSync("git", ["show", "fc92405e:src/stores/terminalStore.ts"], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
const files = ["store/terminalStore.ts", "store/terminalRuntime.ts", "types/terminalStoreTypes.ts",
  "lib/terminalLaunch.ts", "lib/terminalStatus.ts", "lib/terminalStoreLayout.ts", "lib/subagentTranscriptModel.ts"];
const sources = files.map(name => {
  const file = `src/features/terminal/${name}`;
  return parse(file, readFileSync(file, "utf8"));
});
const nameOf = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText() : node.name?.text;
const originals = before.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExpressionStatement(node));
const currentTop = sources.flatMap(source => [...source.statements]);
const runtime = currentTop.find(node => nameOf(node) === "createTerminalRuntime");
const current = [...currentTop, ...runtime.body.statements];
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const canonical = node => printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()).replace(/^export\s+/, "");
for (const node of originals.filter(node => nameOf(node) !== "useTerminalStore")) {
  const matches = current.filter(other => nameOf(other) === nameOf(node));
  assert.equal(matches.length, 1, nameOf(node));
  assert.equal(canonical(matches[0]), canonical(node), nameOf(node));
}
const oldStore = originals.find(node => nameOf(node) === "useTerminalStore");
const oldObject = oldStore.declarationList.declarations[0].initializer.arguments[0].body.expression;
const store = currentTop.find(node => nameOf(node) === "useTerminalStore");
const initializer = store.declarationList.declarations[0].initializer.arguments[0];
const object = initializer.body.statements.at(-1).expression;
const actions = runtime.body.statements.find(node => nameOf(node) === "actions").declarationList.declarations[0].initializer;
assert.deepEqual(oldObject.properties.map(node => node.name.getText()), object.properties.map(node => node.name.getText()));
for (const node of oldObject.properties) {
  const replacement = actions.properties.find(other => other.name.getText() === node.name.getText())
    ?? object.properties.find(other => other.name.getText() === node.name.getText());
  assert.equal(canonical(replacement), canonical(node), node.name.getText());
}
assert.deepEqual(initializer.parameters.map(node => node.name.getText()), ["set", "get", "api"]);
assert.match(initializer.body.statements[0].getText(), /createTerminalRuntime\(set, get, api\)/);
assert.equal(sources.map(source => source.text).join("\n").match(/create<TerminalStore>/g)?.length, 1);
assert.equal(sources[0].statements.at(-1).getText(), "startPtyOrphanReconcileHeartbeat();");
console.log(`${originals.length - 1} declarations and ${oldObject.properties.length} state/action properties match fc92405e; one Store and heartbeat retained.`);
