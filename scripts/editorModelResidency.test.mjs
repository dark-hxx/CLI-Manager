import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { URI } from "../node_modules/monaco-editor/esm/vs/base/common/uri.js";
const exports = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/features/files/lib/editorModelResidency.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
function model(bytes, undo = false, redo = false) {
  return { disposed: false, isDisposed() { return this.disposed; }, getValueLength: () => bytes / 2,
    canUndo: () => undo, canRedo: () => redo, dispose() { this.disposed = true; } };
}
test("idle clean models obey LRU byte/count budget without releasing visible models", () => {
  const r = new exports.EditorModelResidency(100, 2), a = model(80), b = model(80), c = model(80);
  const releaseA = r.acquire("A", a); releaseA();
  const releaseB = r.acquire("B", b); releaseB();
  assert.equal(a.disposed, true);
  const releaseC = r.acquire("C", c);
  r.sync(new Map([["B", false], ["C", false]]));
  assert.equal(b.disposed, true);
  assert.equal(c.disposed, false);
  releaseC(); releaseC();
  assert.equal(r.diagnostics().models, 1);
});
test("dirty, undo and redo are protected even over budget; explicitly closed models are released", () => {
  const r = new exports.EditorModelResidency(1, 0);
  for (const [key, m] of [["dirty", model(100)], ["undo", model(100, true)], ["redo", model(100, false, true)]]) {
    const release = r.acquire(key, m);
    r.sync(new Map([[key, key === "dirty"], ...["dirty", "undo", "redo"].filter(k => k !== key).map(k => [k, true])]));
    release();
    assert.equal(m.disposed, false, key);
  }
  r.sync(new Map());
  assert.equal(r.diagnostics().models, 0);
});
test("distinct projects, remote hosts and slash boundaries cannot share a Monaco model", () => {
  const path = exports.editorModelPath;
  assert.notEqual(path("C:/one", "src/main.ts"), path("C:/two", "src/main.ts"));
  assert.notEqual(path("ssh:one:/repo", "a"), path("ssh:two:/repo", "a"));
  assert.notEqual(path("/a/b", "c"), path("/a", "b/c"));
  assert.equal(path("/repo", "src\\main.ts"), path("/repo", "src/main.ts"));
});

test("Monaco URI canonicalization cannot collapse a nested root into a file path", () => {
  const path = exports.editorModelPath;
  const nested = URI.parse(path("/a/b", "c.ts")).toString();
  const parent = URI.parse(path("/a", "b/c.ts")).toString();
  assert.notEqual(nested, parent);
  assert.equal(URI.parse(nested).toString(), nested);
  assert.notEqual(URI.parse(path("/a%2Fb", "c.ts")).toString(), nested);
});
