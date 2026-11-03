import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../src/features/files/lib/fileContentResidency.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("cache.ts", source, ts.ScriptTarget.Latest, true);
const body = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast)).join("\n");
const exports = {};
runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, fileOperationRootKey: path => path });
const candidate = (key, active = false, protectedValue = false) => ({ key, active, protected: protectedValue, bytes: 80 });
test("clean payload LRU releases bytes, not tab identities; active/draft/undo payloads survive", () => {
  const cache = new exports.FileContentResidency(180, 5);
  cache.reclaim([candidate("A", true), candidate("B")]);
  const selected = cache.reclaim([candidate("A"), candidate("B", true), candidate("draft", false, true)]);
  assert.deepEqual([...selected], ["A"]);
  assert.equal(selected.has("B"), false);
  assert.equal(selected.has("draft"), false);
  assert.equal(cache.reclaim([candidate("B", true), candidate("draft", false, true)]).size, 0);
});
test("file count budget reclaims clean idle payloads without discarding protected over-budget data", () => {
  const cache = new exports.FileContentResidency(10000, 1);
  assert.deepEqual([...cache.reclaim([candidate("A"), candidate("B", true)])], ["A"]);
  const protectedCache = new exports.FileContentResidency(1, 0);
  assert.equal(protectedCache.reclaim([candidate("draft", false, true)]).size, 0);
});
test("overlapping saves keep protection until the last save exits; releases are idempotent", () => {
  const first = exports.protectFileSave("A"), second = exports.protectFileSave("A");
  first(); first();
  assert.equal(exports.pendingFileSaves.get("A"), 1);
  second();
  assert.equal(exports.pendingFileSaves.has("A"), false);
});

test("SSH root identity ignores harmless trailing separators but preserves host and Linux case", () => {
  const root = remote_path => exports.fileContentRoot({ environment_type: "ssh", ssh_host_id: "host-1", remote_path, path: "" });
  assert.equal(root(" /repo/// "), root("/repo"));
  assert.notEqual(root(""), root("/"));
  assert.notEqual(root("/Repo"), root("/repo"));
  assert.notEqual(root("/repo"), exports.fileContentRoot({ environment_type: "ssh", ssh_host_id: "host-2", remote_path: "/repo", path: "" }));
});
