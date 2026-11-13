import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { isSameProjectFileContext, isSameProjectFileLocation } from "../src/features/terminal/api/terminalProject.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/features/files/api/fileExplorerStore.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const entry = (name) => ({ name, path: name, kind: "directory", sizeBytes: 0 });
const change = (path) => ({ path, status: "M", staged: false, added: 1, deleted: 0 });
const project = (id, overrides = {}) => ({
  id, name: id, path: `E:/${id}`, environment_type: "local", remote_path: "", ssh_host_id: null, ...overrides,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Load the complete production store; only IPC/platform dependencies are replaced.
function harness(invoke, remote = {}) {
  const calls = [], errors = [], releases = [];
  const dependencies = {
    "zustand": require("zustand"),
    "@tauri-apps/api/core": { invoke: async (command, args) => {
      calls.push({ command, args });
      return invoke(command, args);
    } },
    "sonner": { toast: { error: (...args) => errors.push(args) } },
    "../../../shared/platform/logger": { logError() {}, recordCrashActivity() {} },
    "../../../shared/i18n/index": { translateCurrent: key => key },
    "../../terminal/api/terminalProject": { isSameProjectFileLocation, isSameProjectFileContext },
    "../../projects/api/projectCapabilities": { projectSupportsCapability: () => true },
    "../lib/fileExplorerIgnore": {},
    "../lib/fileExplorerOperations": {},
    "../lib/fileContentResidency": {},
    "../../git/api/gitDiffWorkspaceStore": {},
    "../../remote/api/sshRemoteFiles": {
      buildSshRemoteFileContext: async p => ({ launch: { hostId: p.ssh_host_id }, consumerId: p.id }),
      releaseSshRemoteFileContext: async context => { releases.push(context); },
      ...remote,
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`, {
    setTimeout, clearTimeout, console, Set, Map,
  })(name => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return { store: module.exports.useFileExplorerStore, calls, errors, releases };
}

for (const environment_type of ["local", "wsl"]) {
  test(`${environment_type}: the first directory and openProject complete while Git is pending`, async () => {
    const git = deferred(), files = [entry("src")], changes = [change("src/a.ts")];
    const h = harness(command => command === "file_list_dir" ? files : git.promise);
    const p = project("one", { environment_type, path: environment_type === "wsl" ? "\\\\wsl.localhost\\Ubuntu\\work\\one" : "E:/one" });
    let completed = false;
    const opening = h.store.getState().openProject(p).then(() => { completed = true; });
    await tick();
    assert.equal(h.store.getState().tree[0]?.name, "src");
    assert.equal(h.store.getState().loading, false);
    assert.equal(completed, true);
    assert.equal(h.store.getState().gitChanges.length, 0);
    git.resolve(changes);
    await opening;
    await tick();
    assert.equal(h.store.getState().gitChanges[0]?.path, "src/a.ts");
  });
}

test("an empty directory leaves the loading state without waiting for Git", async () => {
  const git = deferred();
  const h = harness(command => command === "file_list_dir" ? [] : git.promise);
  void h.store.getState().openProject(project("empty"));
  await tick();
  assert.equal(h.store.getState().loading, false);
  assert.equal(h.store.getState().tree.length, 0);
  git.resolve([]);
  await tick();
});

test("Git cannot finish directory loading before the directory response arrives", async () => {
  const directory = deferred();
  const h = harness(command => command === "file_list_dir" ? directory.promise : []);
  const opening = h.store.getState().openProject(project("slow-directory"));
  await tick();
  assert.equal(h.store.getState().loading, true);
  assert.equal(h.store.getState().tree.length, 0);
  directory.resolve([entry("ready")]);
  await opening;
  assert.equal(h.store.getState().tree[0]?.name, "ready");
  assert.equal(h.store.getState().loading, false);
});

test("a rejected Git query does not clear a displayed tree or show a directory error", async () => {
  const git = deferred();
  const h = harness(command => command === "file_list_dir" ? [entry("src")] : git.promise);
  void h.store.getState().openProject(project("one"));
  await tick();
  assert.equal(h.store.getState().tree[0]?.name, "src");
  git.reject(new Error("synthetic Git failure"));
  await tick();
  assert.equal(h.store.getState().tree[0]?.name, "src");
  assert.equal(h.store.getState().loading, false);
  assert.equal(h.errors.length, 0);
});

test("a directory failure ends loading without starting optional Git work", async () => {
  const h = harness(async command => {
    if (command === "file_list_dir") throw new Error("synthetic directory failure");
    return [];
  });
  await h.store.getState().openProject(project("failed"));
  assert.equal(h.store.getState().loading, false);
  assert.equal(h.store.getState().tree.length, 0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.calls.filter(call => call.command === "git_get_changes").length, 0);
});

for (const [label, first, second] of [
  ["another project", project("one"), project("two")],
  ["a Worktree of the same project", project("one"), project("one", { path: "E:/one-worktree" })],
  ["a case-distinct WSL root", project("one", { path: "\\\\wsl.localhost\\Ubuntu\\work\\Repo" }),
    project("one", { path: "\\\\wsl.localhost\\Ubuntu\\work\\repo" })],
]) {
  test(`late Git results cannot overwrite ${label}`, async () => {
    const firstGit = deferred(), secondGit = deferred();
    const h = harness((command, args) => command === "file_list_dir"
      ? [entry(args.rootPath)] : args.projectPath === first.path ? firstGit.promise : secondGit.promise);
    void h.store.getState().openProject(first);
    await tick();
    void h.store.getState().openProject(second);
    await tick();
    secondGit.resolve([change("new.ts")]);
    await tick();
    firstGit.resolve([change("stale.ts")]);
    await tick();
    assert.equal(h.store.getState().project.path, second.path);
    assert.equal(h.store.getState().tree[0]?.name, second.path);
    assert.equal(h.store.getState().gitChanges[0]?.path, "new.ts");
    assert.equal(h.store.getState().loading, false);
  });
}

test("closing the panel rejects a late initial Git result", async () => {
  const git = deferred();
  const h = harness(command => command === "file_list_dir" ? [entry("src")] : git.promise);
  void h.store.getState().openProject(project("one"));
  await tick();
  h.store.getState().closeProject();
  git.resolve([change("stale.ts")]);
  await tick();
  assert.equal(h.store.getState().project, null);
  assert.equal(h.store.getState().tree.length, 0);
  assert.equal(h.store.getState().gitChanges.length, 0);
});

test("switching away and back applies a shared pending Git request only to the new generation", async () => {
  const git = deferred(), first = project("one"), second = project("two");
  const h = harness((command, args) => command === "file_list_dir"
    ? [entry(args.rootPath)] : args.projectPath === first.path ? git.promise : []);
  void h.store.getState().openProject(first);
  await tick();
  void h.store.getState().openProject(second);
  await tick();
  void h.store.getState().openProject(first);
  await tick();
  assert.equal(h.store.getState().loading, false);
  assert.equal(h.store.getState().tree[0]?.name, first.path);
  git.resolve([change("current.ts")]);
  await tick();
  assert.equal(h.store.getState().gitChanges[0]?.path, "current.ts");
  assert.equal(h.calls.filter(call => call.command === "git_get_changes" && call.args.projectPath === first.path).length, 1);
});

test("a late directory failure cannot clear a newly opened project's tree", async () => {
  const directory = deferred();
  const h = harness((command, args) => command === "file_list_dir"
    ? args.rootPath === "E:/one" ? directory.promise : [entry("new")] : []);
  const previous = h.store.getState().openProject(project("one"));
  await tick();
  await h.store.getState().openProject(project("two"));
  directory.reject(new Error("synthetic stale directory failure"));
  await previous;
  assert.equal(h.store.getState().tree[0]?.name, "new");
  assert.equal(h.store.getState().loading, false);
  assert.equal(h.errors.length, 0);
});

test("SSH opens through its remote context without local directory or Git requests", async () => {
  const h = harness(() => { throw new Error("unexpected local IPC"); }, {
    sshRemoteListDir: async () => [entry("remote")],
  });
  await h.store.getState().openProject(project("remote", { environment_type: "ssh", ssh_host_id: "synthetic-host" }));
  assert.equal(h.store.getState().tree[0]?.name, "remote");
  assert.equal(h.store.getState().loading, false);
  assert.equal(h.store.getState().gitChanges.length, 0);
  assert.equal(h.calls.length, 0);
});

test("clean restored file hydration starts while initial Git is still pending", async () => {
  const git = deferred(), p = project("one");
  const h = harness(command => command === "file_list_dir" ? [entry("src")] : git.promise);
  const restored = { path: "restored.ts", name: "restored.ts", content: "", savedContent: "", dehydrated: true };
  const opened = [];
  h.store.setState({
    editorWorkspaces: [{ project: p, openFiles: [restored], activeFilePath: restored.path }],
    openFile: async value => { opened.push(value.path); },
  });
  void h.store.getState().openProject(p);
  await tick();
  assert.deepEqual(opened, ["restored.ts"]);
  assert.equal(h.store.getState().loading, false);
  git.resolve([]);
  await tick();
});
