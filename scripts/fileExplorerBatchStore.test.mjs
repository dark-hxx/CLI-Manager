import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import * as operations from "../src/features/files/lib/fileExplorerOperations.ts";
import { isFileExplorerIgnoreCaseInsensitive } from "../src/features/files/lib/fileExplorerIgnore.ts";
import { isSameProjectFileContext, isSameProjectFileLocation } from "../src/features/terminal/api/terminalProject.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/features/files/api/fileExplorerStore.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const project = (id = "one") => ({ id, name: id, path: `E:\\${id}`, environment_type: "local", remote_path: "", ssh_host_id: null });
const entry = (path, kind = "file") => ({ path, name: path.split("/").pop(), kind, sizeBytes: 4, modifiedMs: 1 });
const buffer = (path, dirty = false) => ({ ...entry(path), content: dirty ? "edited" : "disk", savedContent: "disk", previewKind: "text" });

function harness(customInvoke) {
  const calls = [];
  let store;
  const dependencies = {
    "zustand": require("zustand"),
    "@tauri-apps/api/core": { invoke: async (command, args) => {
      calls.push({ command, args });
      if (customInvoke) {
        const result = await customInvoke(command, args, store);
        if (result !== undefined) return result;
      }
      if (command === "file_list_dir" || command === "git_get_changes") return [];
      if (command === "file_read_project_text") return { content: "disk", encoding: "utf-8", hasBom: false, sizeBytes: 4 };
      return null;
    } },
    "sonner": { toast: { success() {}, error() {} } },
    "../../../shared/platform/logger": { logError() {}, recordCrashActivity() {} },
    "../../../shared/i18n/index": { translateCurrent: (key) => key },
    "../../terminal/api/terminalProject": { isSameProjectFileLocation, isSameProjectFileContext },
    "../../projects/api/projectCapabilities": { projectSupportsCapability: () => true },
    "../lib/fileExplorerIgnore": { isFileExplorerIgnoreCaseInsensitive },
    "../lib/fileExplorerOperations": operations,
    "../../git/api/gitDiffWorkspaceStore": { activateProjectFileSurface() {} },
    "../../remote/api/sshRemoteFiles": {},
  };
  const module = { exports: {} };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`, { setTimeout, clearTimeout, console, Set, Map })(
    (name) => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    }, module, module.exports,
  );
  store = module.exports.useFileExplorerStore;
  store.setState({ project: project() });
  return { store, calls, mutations: () => calls.filter((call) => ["file_delete", "file_copy", "file_move"].includes(call.command)) };
}

test("batch deletion deduplicates parent/child and refreshes Git once", async () => {
  const h = harness();
  const result = await h.store.getState().deleteEntries([entry("src/a"), entry("src", "directory"), entry("b")], project());
  assert.equal(result.succeeded.length, 2);
  assert.deepEqual(h.mutations().map((call) => call.args.relativePath), ["src", "b"]);
  assert.equal(h.calls.filter((call) => call.command === "git_get_changes").length, 1);
  assert.equal(h.store.getState().mutationBusy, false);
});

test("nested moves refresh both exact parents and expanded overwritten destinations", async () => {
  const h = harness();
  h.store.setState({ expandedPaths: new Set(["", "target", "target/folder", "target/folder/nested"]) });
  h.store.getState().setClipboard({ mode: "move", entries: [entry("source/folder", "directory")] });
  await h.store.getState().pasteInto("target", true);
  const paths = h.calls.filter((call) => call.command === "file_list_dir").map((call) => call.args.relativePath);
  for (const path of ["source", "target", "target/folder", "target/folder/nested"]) assert.ok(paths.includes(path), `not refreshed: ${path}`);
});

test("watcher events during a batch cause one full visible refresh afterwards", async () => {
  const h = harness(async (command, _args, store) => {
    if (command === "file_delete") await store.getState().refreshVisibleState(["unrelated/changed"]);
  });
  h.store.setState({ expandedPaths: new Set(["", "unrelated"]) });
  await h.store.getState().deleteEntries([entry("source/a")], project());
  assert.ok(h.calls.some((call) => call.command === "file_list_dir" && call.args.relativePath === "unrelated"));
  assert.equal(h.calls.filter((call) => call.command === "git_get_changes").length, 1);
});

test("dirty source and dirty overwrite target are protected before IPC", async () => {
  const h = harness();
  h.store.setState({ openFiles: [buffer("src/dirty", true)] });
  const deletion = await h.store.getState().deleteEntries([entry("src", "directory")], project());
  assert.match(deletion.failures[0].error, /file_operation_unsaved/);
  assert.equal(h.mutations().length, 0);
  h.store.setState({ openFiles: [buffer("dest/a", true)] });
  h.store.getState().setClipboard({ mode: "copy", entries: [entry("a")] });
  const paste = await h.store.getState().pasteInto("dest", true);
  assert.match(paste.failures[0].error, /file_operation_unsaved/);
  assert.equal(h.mutations().length, 0);
});

test("partial move retains only pending clipboard entries; confirmed conflicts do not replay successes", async () => {
  const h = harness(async (command, args) => {
    if (command === "file_move" && args.name === "b" && !args.overwrite) throw new Error("target_exists");
  });
  h.store.getState().setClipboard({ mode: "move", entries: [entry("a"), entry("b")] });
  const original = h.store.getState().clipboard;
  const first = await h.store.getState().pasteInto("dest", false, original);
  assert.equal(first.succeeded.length, 1);
  assert.deepEqual(h.store.getState().clipboard.entries.map((item) => item.path), ["b"]);
  const retry = { ...original, entries: first.conflicts };
  await h.store.getState().pasteInto("dest", true, retry);
  assert.equal(h.store.getState().clipboard, null);
  assert.deepEqual(h.mutations().map((call) => [call.args.name, call.args.overwrite]), [["a", false], ["b", false], ["b", true]]);
});

test("confirming an older conflict does not clear a newly copied selection", async () => {
  const h = harness();
  h.store.getState().setClipboard({ mode: "move", entries: [entry("a")] });
  const previous = h.store.getState().clipboard;
  h.store.getState().setClipboard({ mode: "move", entries: [entry("new")] });
  const next = h.store.getState().clipboard;
  await h.store.getState().pasteInto("dest", true, previous);
  assert.equal(h.store.getState().clipboard, next);
});

test("SSH, overlapping operations and old-project snapshots cannot mutate", async () => {
  const h = harness();
  const remote = { ...project(), environment_type: "ssh", remote_path: "/repo", ssh_host_id: "host" };
  h.store.setState({ project: remote });
  await assert.rejects(h.store.getState().deleteEntries([entry("a")], remote), /remote_project_read_only/);
  h.store.setState({ project: project(), mutationBusy: true });
  await assert.rejects(h.store.getState().deleteEntries([entry("a")], project()), /file_operation_busy/);
  h.store.setState({ mutationBusy: false });
  h.store.getState().setClipboard({ mode: "move", entries: [entry("a")] });
  const snapshot = h.store.getState().clipboard;
  await h.store.getState().openProject(project("two"));
  await assert.rejects(h.store.getState().pasteInto("dest", false, snapshot), /context_changed/);
  assert.equal(h.mutations().length, 0);
});

test("switching away and back invalidates the original clipboard generation", async () => {
  const h = harness();
  h.store.getState().setClipboard({ mode: "move", entries: [entry("a")] });
  const snapshot = h.store.getState().clipboard;
  await h.store.getState().openProject(project("two"));
  await h.store.getState().openProject(project());
  await assert.rejects(h.store.getState().pasteInto("dest", false, snapshot), /context_changed/);
  assert.equal(h.mutations().length, 0);
});

test("case-distinct WSL roots cannot reuse an old mutation snapshot", async () => {
  const h = harness();
  const originalProject = { ...project(), environment_type: "wsl", path: "\\\\wsl.localhost\\Ubuntu\\home\\A" };
  h.store.setState({ project: originalProject });
  h.store.getState().setClipboard({ mode: "move", entries: [entry("a")] });
  const snapshot = h.store.getState().clipboard;
  h.store.setState({ project: { ...originalProject, path: "\\\\wsl.localhost\\Ubuntu\\home\\a" } });
  await assert.rejects(h.store.getState().pasteInto("dest", false, snapshot), /context_changed/);
  assert.equal(h.mutations().length, 0);
});

test("mid-batch project switch cancels remaining files without touching the new editor", async () => {
  const h = harness(async (command, _args, store) => {
    if (command === "file_delete") {
      await store.getState().openProject(project("two"));
      store.setState({ openFiles: [buffer("a", true)], activeFilePath: "a" });
    }
  });
  const result = await h.store.getState().deleteEntries([entry("a"), entry("b")], project());
  assert.equal(result.succeeded.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(h.mutations().length, 1);
  assert.equal(h.store.getState().openFiles[0].content, "edited");
  assert.equal(h.store.getState().project.id, "two");
});

test("buffers edited during awaited mutation are retained, not discarded", async () => {
  const h = harness(async (command, _args, store) => {
    if (command === "file_delete") store.setState({ openFiles: [buffer("a", true)] });
  });
  h.store.setState({ openFiles: [buffer("a")] });
  await h.store.getState().deleteEntries([entry("a")], project());
  assert.equal(h.store.getState().openFiles[0].content, "edited");
});

test("search view changes clear selection; refresh of the same query does not", async () => {
  const h = harness();
  h.store.getState().selectEntry(entry("a"));
  h.store.getState().setSearchMode("content");
  assert.equal(h.store.getState().selectedEntries.length, 0);
  h.store.getState().selectEntry(entry("a"));
  await h.store.getState().setSearchQuery("");
  assert.equal(h.store.getState().selectedEntries.length, 1);
  h.store.getState().closeProject();
  assert.equal(h.store.getState().selectedEntries.length, 0);
});
