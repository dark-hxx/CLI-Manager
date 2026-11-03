import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
function load(path, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast)).join("\n");
  const exports = {};
  runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, ...globals });
  return exports;
}
const models = load("../src/features/files/lib/editorModelResidency.ts");
const contents = load("../src/features/files/lib/fileContentResidency.ts", { fileOperationRootKey: p => p });
const project = { id: "synthetic", path: "/synthetic" };
const file = (path, content = "text", savedContent = content) => ({ path, content, savedContent, image: null });
function harness(state) {
  let subscriber, updates = 0;
  const api = load("../src/features/files/api/fileEditorModels.ts", { ...models, ...contents,
    useFileExplorerStore: { getState: () => state, subscribe: fn => { subscriber = fn; },
      setState: patch => { Object.assign(state, patch); updates++; subscriber(); } },
  });
  return { ...api, state, updates: () => updates };
}
test("current workspace mirror releases stale closed-file references without losing current drafts", () => {
  const openFiles = [file("draft", "dirty", "saved")];
  const h = harness({ project, openFiles, activeFilePath: "draft", editorWorkspaces: [
    { project, openFiles: [file("closed")], activeFilePath: "closed" },
  ] });
  h.syncFileEditorModels();
  assert.ok(h.state.editorWorkspaces[0].openFiles === openFiles);
  assert.equal(h.state.editorWorkspaces[0].activeFilePath, "draft");
  assert.equal(h.state.openFiles[0].content, "dirty");
  assert.equal(h.updates(), 1, "store synchronization must not recurse");
  h.syncFileEditorModels();
  assert.equal(h.updates(), 1, "an unchanged mirror must not churn the store");
});
test("payload reclamation retains tabs and synchronizes both references to the pruned file array", () => {
  const payload = "x".repeat(1024 * 1024);
  const openFiles = Array.from({ length: 20 }, (_, n) => file(String(n), payload));
  const h = harness({ project, openFiles, activeFilePath: "19", editorWorkspaces: [{ project, openFiles, activeFilePath: "19" }] });
  h.syncFileEditorModels();
  assert.equal(h.state.openFiles.length, 20);
  assert.ok(h.state.editorWorkspaces[0].openFiles === h.state.openFiles);
  assert.ok(h.state.openFiles[19].content === payload);
  assert.ok(h.state.openFiles.some(f => f.dehydrated));
  const bytes = h.state.openFiles.reduce((sum, f) => sum + (f.content.length + f.savedContent.length) * 2, 0);
  assert.ok(bytes <= 32 * 1024 * 1024);
});
