import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isSameProjectFileLocation } from "../src/features/terminal/api/terminalProject.ts";
const source = readFileSync(new URL("../src/features/files/api/fileExplorerStore.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("files.ts", source, ts.ScriptTarget.Latest, true);
const methods = new Map();
function visit(node) {
  if (ts.isPropertyAssignment(node) && ["openFile", "setActiveFilePath", "openFileAtSearchMatch"].includes(node.name.getText(ast))) methods.set(node.name.getText(ast), node.initializer.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const file = (path, dehydrated = false) => ({ path, name: path, previewKind: "text", content: dehydrated ? "" : path,
  savedContent: dehydrated ? "" : path, image: null, encoding: "utf-8", hasBom: false, sizeBytes: 80, dehydrated });
function harness(loadProjectFile) {
  const state = { project: { id: "synthetic", path: "/synthetic" }, openFiles: [file("A", true), file("B")],
    activeFilePath: "B", activeFile: file("B"), remoteFileContext: null, editorWorkspaces: [], loading: false };
  const code = ts.transpileModule(`let openFileRequestSeq = 0, openProjectRequestSeq = 0;
    Object.assign(state, {${[...methods].map(([key, value]) => `${key}: ${value}`).join(",")}});
    exports.advanceProjectGeneration = () => openProjectRequestSeq++;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const warnings = [];
  const exports = {};
  runInNewContext(code, { exports, state, Object, get: () => state, set: patch => Object.assign(state, typeof patch === "function" ? patch(state) : patch),
    loadProjectFile, activateProjectFileSurface: () => {}, recordCrashActivity: () => {}, extension: () => "ts", isImage: () => false, isMarkdown: () => false,
    isSameProjectFileLocation, findEditorWorkspace: (workspaces, project) => workspaces.find(item => isSameProjectFileLocation(item.project, project)),
    translateCurrent: key => key, fileReadErrorMessage: String,
    toast: { warning: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
  });
  return { state, warnings, ...exports };
}
test("hydration replaces only the payload and a late read does not steal a newer selection", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  const first = h.state.openFile({ path: "A", name: "A", kind: "file" });
  h.state.setActiveFilePath("B");
  pending.resolve({ file: file("A"), errorMessage: null });
  await first;
  assert.equal(h.state.activeFilePath, "B");
  assert.equal(h.state.openFiles[0].dehydrated, false);
  assert.equal(h.state.openFiles.length, 2);
});
test("closing a tab while hydration runs prevents its late result from reopening the tab", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  const first = h.state.openFile({ path: "A", name: "A", kind: "file" });
  h.state.openFiles = h.state.openFiles.filter(f => f.path !== "A");
  pending.resolve({ file: file("A"), errorMessage: null });
  await first;
  assert.equal(h.state.openFiles.length, 1);
  assert.equal(h.state.activeFilePath, "B");
  assert.equal(h.state.loading, false);
});
test("a failed reload retains the original dehydrated tab and can retry successfully", async () => {
  let fail = true;
  const h = harness(async () => ({ file: file("A"), errorMessage: fail ? "synthetic_read_failure" : null }));
  await h.state.openFile({ path: "A", name: "A", kind: "file" });
  assert.equal(h.state.openFiles[0].dehydrated, true);
  assert.equal(h.warnings.length, 1);
  fail = false;
  await h.state.openFile({ path: "A", name: "A", kind: "file" });
  assert.equal(h.state.activeFilePath, "A");
  assert.equal(h.state.activeFile.content, "A");
});

test("a prior project generation cannot populate the current cold payload after switching away and back", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  const first = h.state.openFile({ path: "A", name: "A", kind: "file" });
  h.advanceProjectGeneration();
  pending.resolve({ file: file("A"), errorMessage: null });
  await first;
  assert.equal(h.state.openFiles[0].dehydrated, true);
  assert.equal(h.state.activeFilePath, "B");
});

test("late search hydration cannot replace the navigation target after another file selection", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  const first = h.state.openFileAtSearchMatch({ path: "A", name: "A", lineNumber: 10 });
  h.state.setActiveFilePath("B");
  pending.resolve({ file: file("A"), errorMessage: null });
  await first;
  assert.equal(h.state.searchNavigationTarget, undefined);
  assert.equal(h.state.activeFilePath, "B");
});

test("late WSL hydration cannot fill a case-distinct file workspace", async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  h.state.project = { ...h.state.project, environment_type: "wsl", path: "/home/user/Repo" };
  const first = h.state.openFile({ path: "A", name: "A", kind: "file" });
  h.state.project = { ...h.state.project, path: "/home/user/repo" };
  pending.resolve({ file: file("A"), errorMessage: null });
  await first;
  assert.equal(h.state.openFiles[0].dehydrated, true);
  assert.equal(h.state.activeFilePath, "B");
});
