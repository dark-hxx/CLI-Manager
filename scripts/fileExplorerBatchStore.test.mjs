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
const residencySource = readFileSync(new URL("../src/features/files/lib/fileContentResidency.ts", import.meta.url), "utf8");
const residencyCode = ts.transpileModule(residencySource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const residency = { exports: {} };
vm.runInNewContext(`(function(require, module, exports) { ${residencyCode}\n})`)(
  (name) => { assert.equal(name, "./fileExplorerOperations"); return operations; }, residency, residency.exports,
);

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
    "../lib/fileContentResidency": residency.exports,
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
  return { store, calls, mutations: () => calls.filter((call) => ["file_delete", "file_copy", "file_move", "file_import_external", "file_import_image"].includes(call.command)) };
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

test("menu copy publishes native files and keeps the matching internal snapshot", async () => {
  const h = harness(async (command) => {
    if (command === "file_clipboard_write") return 42;
    if (command === "file_clipboard_read") return { unchanged: true, entries: [] };
  });
  assert.equal(await h.store.getState().copyEntries("copy", [entry("src/a"), entry("src/b")]), true);
  const write = h.calls.find((call) => call.command === "file_clipboard_write");
  assert.equal(write.args.rootPath, project().path);
  assert.deepEqual([...write.args.paths], ["src/a", "src/b"]);
  assert.equal(write.args.mode, "copy");
  assert.equal((await h.store.getState().readPasteClipboard()).mode, "copy");
  assert.equal(h.calls.find((call) => call.command === "file_clipboard_read").args.knownRevision, 42);
});

test("unavailable native clipboard preserves app-only copy and WSL does not publish fake paths", async () => {
  const h = harness(async (command) => {
    if (command === "file_clipboard_write") throw new Error("clipboard_busy");
    if (command === "clipboard_get_revision") return 7;
    if (command === "file_clipboard_read") return { unchanged: true, entries: [] };
  });
  assert.equal(await h.store.getState().copyEntries("move", [entry("a")]), false);
  assert.equal((await h.store.getState().readPasteClipboard()).mode, "move");
  h.store.setState({ project: { ...project(), environment_type: "wsl", path: "/home/user/repo" } });
  const before = h.calls.length;
  assert.equal(await h.store.getState().copyEntries("copy", [entry("b")]), false);
  assert.equal(h.calls.slice(before).some((call) => call.command === "file_clipboard_write"), false);
});

test("mixed-parent Shell cut failure keeps an app-only move snapshot", async () => {
  const h = harness(async (command) => {
    if (command === "file_clipboard_write") throw new Error("clipboard_move_mixed_parents_unsupported");
    if (command === "clipboard_get_revision") return 7;
    if (command === "file_clipboard_read") return { unchanged: true, entries: [] };
  });
  assert.equal(await h.store.getState().copyEntries("move", [entry("left/a"), entry("right/b")]), false);
  const clipboard = await h.store.getState().readPasteClipboard();
  assert.equal(clipboard.mode, "move");
  assert.deepEqual(clipboard.entries.map((item) => item.path), ["left/a", "right/b"]);
});

test("invalid native source does not leave a clipboard snapshot that can later paste", async () => {
  const h = harness(async (command) => {
    if (command === "file_clipboard_write") throw new Error("path_is_symlink");
  });
  await assert.rejects(h.store.getState().copyEntries("copy", [entry("link")]), /path_is_symlink/);
  assert.equal(h.store.getState().clipboard, null);
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

test("successful rename migrates selected paths and names", async () => {
  const h = harness();
  const selected = entry("src/old.txt");
  h.store.getState().selectEntry(selected);
  await h.store.getState().renameEntry(selected.path, "new.txt", false);
  const [renamed] = h.store.getState().selectedEntries;
  assert.equal(renamed.path, "src/new.txt");
  assert.equal(renamed.name, "new.txt");
  assert.equal(renamed.kind, "file");
  const renameCall = h.calls.find((call) => call.command === "file_rename");
  assert.equal(renameCall?.args.rootPath, "E:\\one");
  assert.equal(renameCall?.args.relativePath, "src/old.txt");
  assert.equal(renameCall?.args.newName, "new.txt");
  assert.equal(renameCall?.args.overwrite, false);
});

test("failed rename preserves the selected path", async () => {
  const h = harness(async (command) => {
    if (command === "file_rename") throw new Error("target_exists");
  });
  const selected = entry("src/old.txt");
  h.store.getState().selectEntry(selected);
  await assert.rejects(h.store.getState().renameEntry(selected.path, "new.txt", false), /target_exists/);
  assert.deepEqual(h.store.getState().selectedEntries, [selected]);
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

// System clipboard import regressions; native clipboard is mocked, never overwritten.
const nativeFile = (path, kind = 'file') => ({ ...entry(path, kind), dataBase64: null });
const imageEntry = () => ({ ...entry('clipboard-image:one'), name: 'screenshot-one.png', dataBase64: 'PNG_SNAPSHOT' });
function clipboardHarness(entries, options = {}) {
  return harness(async (command, args, store) => {
    const custom = await options.invoke?.(command, args, store);
    if (custom !== undefined) return custom;
    if (command === 'clipboard_get_revision') return 10;
    if (command === 'file_clipboard_read') return { unchanged: options.unchanged ?? false, entries };
  });
}

test('OS files paste into the captured directory as copies and refresh that exact parent', async () => {
  const h = clipboardHarness([nativeFile('C:/downloads/中文 file.txt'), nativeFile('C:/downloads/folder', 'directory')]);
  const snapshot = await h.store.getState().readPasteClipboard();
  assert.equal(snapshot.mode, 'copy');
  const result = await h.store.getState().pasteInto('images', false, snapshot);
  assert.equal(result.succeeded.length, 2);
  assert.deepEqual(h.mutations().map(x => x.command), ['file_import_external', 'file_import_external']);
  assert.equal(h.mutations()[0].args.rootPath, 'E:\\one');
  assert.equal(h.mutations()[0].args.targetParentPath, 'images');
  assert.equal(h.mutations()[0].args.name, '中文 file.txt');
  assert.equal(h.mutations()[0].args.overwrite, false);
  assert.ok(h.calls.some(x => x.command === 'file_list_dir' && x.args.relativePath === 'images'));
  assert.equal(h.calls.filter(x => x.command === 'git_get_changes').length, 1);
});

test('screenshot bytes are snapshotted and sent to project image import, not terminal attachments', async () => {
  const original = imageEntry(); const h = clipboardHarness([original]);
  const snapshot = await h.store.getState().readPasteClipboard();
  original.dataBase64 = 'NEW_CLIPBOARD';
  await h.store.getState().pasteInto('', false, snapshot);
  assert.equal(h.mutations()[0].command, 'file_import_image');
  assert.equal(h.mutations()[0].args.dataBase64, 'PNG_SNAPSHOT');
  assert.equal(h.mutations()[0].args.name, 'screenshot-one.png');
  assert.equal(h.calls.some(x => x.command === 'file_attach_data'), false);
});

test('new external clipboard replaces stale internal cut; unchanged revision keeps internal copy/cut', async () => {
  for (const mode of ['copy', 'move']) {
    const external = clipboardHarness([nativeFile('C:/external/new.txt')]);
    external.store.getState().setClipboard({ mode, entries: [entry('old.txt')] });
    const snapshot = await external.store.getState().readPasteClipboard();
    assert.equal(snapshot.mode, 'copy');
    assert.equal(snapshot.entries[0].name, 'new.txt');
    assert.equal(external.calls.find(x => x.command === 'file_clipboard_read').args.knownRevision, 10);
    const internal = clipboardHarness([], { unchanged: true });
    internal.store.getState().setClipboard({ mode, entries: [entry('old.txt')] });
    assert.equal(await internal.store.getState().readPasteClipboard(), internal.store.getState().clipboard);
  }
});

test('text-only / empty changed clipboard never replays stale internal selection', async () => {
  const h = clipboardHarness([]);
  h.store.getState().setClipboard({ mode: 'move', entries: [entry('old.txt')] });
  assert.equal(await h.store.getState().readPasteClipboard(), null);
  assert.equal(h.mutations().length, 0);
});

test('clipboard read errors propagate and release read lock for retry', async () => {
  let fail = true;
  const h = clipboardHarness([], { invoke: (command) => {
    if (command === 'file_clipboard_read' && fail) { fail = false; throw new Error('clipboard_busy'); }
  } });
  await assert.rejects(h.store.getState().readPasteClipboard(), /clipboard_busy/);
  assert.equal(await h.store.getState().readPasteClipboard(), null);
});

test('switching project / away and back / changing clipboard during read cancels before mutation', async () => {
  for (const change of ['project', 'roundtrip', 'clipboard', 'clear']) {
    const h = clipboardHarness([nativeFile('C:/external/a')], { invoke: async (command, _args, store) => {
      if (command !== 'file_clipboard_read') return;
      if (change === 'project' || change === 'roundtrip') await store.getState().openProject(project('two'));
      if (change === 'roundtrip') await store.getState().openProject(project());
      if (change === 'clipboard') store.getState().setClipboard({ mode: 'copy', entries: [entry('new')] });
      if (change === 'clear') store.getState().setClipboard(null);
    } });
    await assert.rejects(h.store.getState().readPasteClipboard(), /context_changed/);
    assert.equal(h.mutations().length, 0);
  }
});

test('simultaneous panels cannot read/paste overlapping snapshots, SSH never reads clipboard', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = clipboardHarness([], { invoke: async command => { if (command === 'file_clipboard_read') await waiting; } });
  const first = h.store.getState().readPasteClipboard();
  await assert.rejects(h.store.getState().readPasteClipboard(), /file_operation_busy/);
  release(); await first;
  h.store.setState({ project: { ...project(), environment_type: 'ssh' } });
  const before = h.calls.length;
  await assert.rejects(h.store.getState().readPasteClipboard(), /remote_project_read_only/);
  assert.equal(h.calls.length, before);
});

test('external overwrite guards dirty targets and preserves buffers edited during awaited copy', async () => {
  const h = clipboardHarness([nativeFile('C:/external/dirty.txt')]);
  const snapshot = await h.store.getState().readPasteClipboard();
  h.store.setState({ openFiles: [buffer('dest/dirty.txt', true)] });
  const result = await h.store.getState().pasteInto('dest', true, snapshot);
  assert.match(result.failures[0].error, /unsaved/);
  assert.equal(h.mutations().length, 0);
  const pending = clipboardHarness([nativeFile('C:/external/a')], { invoke: (command, _args, store) => {
    if (command === 'file_import_external') store.setState({ openFiles: [buffer('dest/a', true)] });
  } });
  const image = await pending.store.getState().readPasteClipboard();
  await pending.store.getState().pasteInto('dest', true, image);
  assert.equal(pending.store.getState().openFiles[0].content, 'edited');
});

test('external conflict retry only copies conflicts and retains every protected source path', async () => {
  const h = clipboardHarness([nativeFile('C:/external/good'), nativeFile('C:/external/conflict')], { invoke: (command, args) => {
    if (command === 'file_import_external' && args.name === 'conflict' && !args.overwrite) throw new Error('target_exists');
  } });
  const snapshot = await h.store.getState().readPasteClipboard();
  const first = await h.store.getState().pasteInto('dest', false, snapshot);
  assert.equal(first.succeeded.length, 1); assert.equal(first.conflicts.length, 1);
  h.store.getState().setClipboard({ mode: 'move', entries: [entry('new-private')] });
  const newer = h.store.getState().clipboard;
  const second = await h.store.getState().pasteInto('dest', true, { ...snapshot, entries: first.conflicts });
  assert.equal(second.succeeded.length, 1);
  assert.deepEqual(h.mutations().map(x => x.args.name), ['good', 'conflict', 'conflict']);
  assert.deepEqual([...h.mutations()[2].args.protectedSourcePaths], ['C:/external/good', 'C:/external/conflict']);
  assert.equal(h.store.getState().clipboard, newer);
  assert.equal(h.calls.filter(x => x.command === 'file_clipboard_read').length, 1);
});

test('case-distinct WSL sources are not silently collapsed for a Windows destination', async () => {
  const h = clipboardHarness([nativeFile('//wsl.localhost/Ubuntu/home/a'), nativeFile('//wsl.localhost/Ubuntu/home/A')]);
  const snapshot = await h.store.getState().readPasteClipboard();
  const result = await h.store.getState().pasteInto('dest', false, snapshot);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.every(x => x.error.includes('batch_duplicate_target')));
  assert.equal(h.mutations().length, 0);
});
