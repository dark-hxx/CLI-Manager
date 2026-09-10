import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createGitModuleLoader } from "./helpers/loadGitModule.mjs";

const load = createGitModuleLoader();
const model = load("src/features/git/lib/gitTreeModel.ts");
const builder = load("src/features/git/lib/gitTreeBuilder.ts");
const { summarizeGitChanges } = load("src/features/git/lib/gitChangesSummary.ts");
const change = (path, status = "M", staged = false) => ({ path, status, staged, added: 2, deleted: 1 });
const complete = generator => { let step; do { step = generator.next(); } while (!step.done); return step.value; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// 验证实际算法覆盖 issue 规模，不以截断变更或折叠目录替代完整结果。
test("64887 changes remain reachable for flat, wide and deep trees", () => {
  for (const shape of ["flat", "wide", "deep"]) {
    const changes = Array.from({ length: 64887 }, (_, i) => change(
      shape === "flat" ? `file-${i}.ts` : shape === "wide" ? `module-${i % 100}/file-${i}.ts` : `root/a/b/module-${i % 100}/src/file-${i}.ts`,
    ));
    const { tree, untrackedTree } = complete(model.buildGitChangeTrees(changes, "all", "directory"));
    const rows = model.flattenGitRows(tree, untrackedTree, new Set());
    assert.equal(rows.filter(row => row.kind === "node" && row.node.change).length, changes.length);
    const paths = tree.flatMap(model.collectFileChanges).map(file => file.path);
    assert.deepEqual([...paths].sort(), changes.map(file => file.path).sort());
    const summaries = model.summarizeGitDirectories(tree, new Set(), new Set());
    if (shape === "deep") assert.equal(summaries.get(tree[0]).total, changes.length);
  }
});

// 比较分组、压缩路径、筛选及分区 key，保证目录批量操作仍包含不可见后代。
test("collapsed rows preserve full operation scope and tracked/untracked isolation", () => {
  const changes = [change("root/a/b/m.ts", "M", true), change("root/a/b/a.ts", "A", true), change("root/a/b/u.ts", "??")];
  const { tree, untrackedTree } = complete(model.buildGitChangeTrees(changes, "all", "module"));
  assert.equal(tree[0].isModuleRoot, true);
  const rows = model.flattenGitRows(tree, untrackedTree, new Set(["tracked:root"]));
  assert.equal(rows.filter(row => row.kind === "node" && row.treeId === "tracked").length, 1);
  assert.ok(rows.some(row => row.kind === "node" && row.node.path.endsWith("u.ts")));
  assert.equal(model.collectFileChanges(tree[0]).length, 2);
  const summaries = model.summarizeGitDirectories([...tree, ...untrackedTree], new Set([changes[2].path]), new Set([changes[1].path]));
  assert.deepEqual(summaries.get(tree[0]), { total: 2, untracked: 0, checked: 1 });
  assert.deepEqual(summaries.get(untrackedTree[0]), { total: 1, untracked: 1, checked: 1 });
  const filtered = complete(model.buildGitChangeTrees(changes, "M", "directory"));
  assert.deepEqual(filtered.tree.flatMap(model.collectFileChanges).map(file => file.status), ["M"]);
  assert.equal(filtered.untrackedTree.flatMap(model.collectFileChanges).length, 1);
});

test("snapshot comparison and summary preserve all Git status semantics", () => {
  const changes = [change("a", "A", true), change("b", "M", true), change("c", "??"), change("d", "D"), change("e", "C")];
  assert.equal(model.sameGitChanges(changes, structuredClone(changes)), true);
  for (const patch of [{ path: "other" }, { status: "R" }, { staged: false }, { added: 0 }, { deleted: 0 }]) {
    assert.equal(model.sameGitChanges(changes, [{ ...changes[0], ...patch }, ...changes.slice(1)]), false);
  }
  const summary = summarizeGitChanges(changes, new Set(["a"]));
  assert.equal(summary.stagedCount - summary.deselectedAddedCount + 1, 2);
  assert.equal(summary.hasConflicts, true);
  assert.deepEqual(summary.trackedModPaths, ["b", "d", "e"]);
});

// Worker 完成、失败及取消都必须终止实例；失败使用同一个分批算法，不丢文件。
test("Worker success terminates once; failure falls back; abort never falls back", async t => {
  const changes = Array.from({ length: 5001 }, (_, i) => change(`f-${i}`));
  const original = globalThis.Worker;
  t.after(() => { globalThis.Worker = original; });
  let terminations = 0;
  globalThis.Worker = class {
    postMessage(input) { queueMicrotask(() => this.onmessage({ data: complete(model.buildGitChangeTrees(input.changes, input.filter, input.groupBy)) })); }
    terminate() { terminations++; }
  };
  assert.equal((await builder.buildGitTreesAsync(changes, "all", "directory", new AbortController().signal)).tree.length, 5001);
  assert.equal(terminations, 1);
  globalThis.Worker = class {
    postMessage() { queueMicrotask(() => this.onerror()); }
    terminate() { terminations++; }
  };
  let heartbeat = false;
  setTimeout(() => { heartbeat = true; }, 0);
  assert.equal((await builder.buildGitTreesAsync(changes, "all", "directory", new AbortController().signal)).tree.length, 5001);
  assert.equal(heartbeat, true);
  assert.equal(terminations, 2);
  globalThis.Worker = class { postMessage() {} terminate() { terminations++; } };
  const controller = new AbortController();
  const pending = builder.buildGitTreesAsync(changes, "all", "directory", controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(terminations, 3);
});

// 每个测试新建真实 Zustand store；Transport 为可控延迟，避免源码正则镜像代替行为验证。
function createStore() {
  const settings = { gitGroupBy: "directory" };
  const load = createGitModuleLoader({
    [resolve("src/shared/preferences/settingsStore.ts")]: { useSettingsStore: { getState: () => settings } },
    [resolve("src/shared/platform/debugConsole.ts")]: { debugConsoleLog() {}, debugConsoleWarn() {} },
  });
  const store = load("src/features/git/store/gitStore.ts").useGitStore;
  return { store, settings };
}
function transport(contextKey, getChanges) {
  return { contextKey, remote: false, getChanges, getBranchStatus: async () => ({ value: null }), listBranches: async () => ({ value: [] }) };
}

test("real store coalesces refresh bursts and waits for the post-write snapshot", async () => {
  const { store } = createStore();
  const first = deferred(), second = deferred();
  let calls = 0, concurrent = 0, maxConcurrent = 0;
  const adapter = transport("local:A", async () => {
    calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    const result = await (calls === 1 ? first.promise : second.promise);
    concurrent--; return { value: result };
  });
  adapter.stage = async () => {};
  store.getState().setTransport(adapter);
  const initial = store.getState().fetchChanges("A");
  await Promise.resolve();
  let mutationRefreshFinished = false;
  const pending = Array.from({ length: 20 }, () => store.getState().fetchChanges("A", true));
  const postWrite = store.getState().stageFile("before").then(() => { mutationRefreshFinished = true; });
  first.resolve([change("before")]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.equal(mutationRefreshFinished, false);
  second.resolve([change("after")]);
  await Promise.all([initial, postWrite, ...pending]);
  assert.equal(maxConcurrent, 1);
  assert.equal(store.getState().changes[0].path, "after");
});

test("real store reuses identical snapshots and rejects A to B to A stale results", async () => {
  const { store } = createStore();
  let data = [change("same")];
  const local = transport("local:A", async () => ({ value: structuredClone(data) }));
  store.getState().setTransport(local);
  await store.getState().fetchChanges("A");
  const before = store.getState();
  await store.getState().fetchChanges("A", true);
  assert.equal(store.getState().changes, before.changes);
  assert.equal(store.getState().tree, before.tree);
  assert.equal(store.getState().selectedUntracked, before.selectedUntracked);
  const old = deferred();
  local.getChanges = async () => old.promise;
  const previous = store.getState().fetchChanges("A", true);
  await Promise.resolve();
  store.getState().reset();
  store.getState().setTransport(transport("local:B", async () => ({ value: [change("B")] })));
  await store.getState().fetchChanges("B");
  store.getState().setTransport(transport("local:A", async () => ({ value: [change("new-A")] })));
  const latest = store.getState().fetchChanges("A");
  old.resolve({ value: [change("old-A")] });
  await Promise.all([previous, latest]);
  assert.equal(store.getState().changes[0].path, "new-A");
});

test("real store preserves selection and applies filter changed while fetching", async () => {
  const { store } = createStore();
  const response = deferred();
  store.getState().setTransport(transport("local:A", async () => response.promise));
  const pending = store.getState().fetchChanges("A");
  store.getState().setStatusFilter("D");
  response.resolve({ value: [change("deleted", "D"), change("modified", "M"), change("untracked", "U")] });
  await pending;
  assert.deepEqual(store.getState().tree.map(node => node.path), ["deleted"]);
  assert.equal(store.getState().untrackedTree[0].path, "untracked");
  store.getState().setUntrackedSelection(["untracked"], true);
  await store.getState().fetchChanges("A", true);
  assert.equal(store.getState().selectedUntracked.has("untracked"), true);
});

test("closing the panel invalidates late results", async () => {
  const { store } = createStore();
  const response = deferred();
  store.getState().setTransport(transport("local:A", async () => response.promise));
  const pending = store.getState().fetchChanges("A");
  await Promise.resolve();
  store.getState().setTransport(null);
  response.resolve({ value: [change("late")] });
  await pending;
  assert.equal(store.getState().changes.length, 0);
});

test("root files named section have unique row keys and Windows paths retain operation identity", () => {
  const changes = [change("section"), change("folder\\子目录\\file.ts"), change("a.ts")];
  const forest = complete(model.buildGitChangeTrees(changes, "all", "module"));
  const rows = model.flattenGitRows(forest.tree, forest.untrackedTree, new Set());
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  assert.deepEqual(forest.tree.map(node => node.name), ["a.ts", "folder", "section"]);
  assert.equal(forest.tree[1].isModuleRoot, true);
  assert.equal(model.collectFileChanges(forest.tree[1])[0].path, "folder\\子目录\\file.ts");
  const replacement = complete(model.buildGitChangeTrees([change("foo/old.ts", "D"), change("foo", "A")], "all", "module"));
  assert.equal(replacement.tree.length, 1);
  assert.equal(replacement.tree[0].type, "directory");
  assert.equal(replacement.tree[0].children.length, 2);
  const replacementRows = model.flattenGitRows(replacement.tree, [], new Set());
  assert.equal(new Set(replacementRows.map(row => row.key)).size, replacementRows.length);
  assert.equal(model.collectFileChanges(replacement.tree[0]).length, 2);
});

test("real store silent failure preserves data, explicit failure clears it and recovery releases queue", async t => {
  t.mock.method(console, "error", () => {});
  const { store } = createStore();
  let fail = false;
  store.getState().setTransport(transport("local:A", async () => {
    if (fail) throw new Error("status_failed");
    return { value: [change("ok")] };
  }));
  await store.getState().fetchChanges("A");
  const tree = store.getState().tree;
  fail = true;
  await store.getState().fetchChanges("A", true);
  assert.equal(store.getState().tree, tree);
  assert.equal(store.getState().error, null);
  await store.getState().fetchChanges("A");
  assert.equal(store.getState().error, "status_failed");
  assert.equal(store.getState().tree.length, 0);
  fail = false;
  await store.getState().fetchChanges("A");
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().tree[0].path, "ok");
});

test("SSH empty repository ID and subrepository switching keep independent fresh results", async () => {
  const { store } = createStore();
  const old = deferred();
  const ids = [];
  const adapter = transport("ssh:host:project", async repoId => {
    ids.push(repoId);
    return repoId === "" ? old.promise : { value: [change("subrepo")] };
  });
  adapter.remote = true;
  store.getState().setTransport(adapter, true);
  const pending = store.getState().fetchChanges("/project");
  await Promise.resolve();
  store.getState().setActiveRepo("/project/sub");
  await store.getState().fetchChanges("/project", true);
  old.resolve({ value: [change("old-root")] });
  await pending;
  assert.equal(ids[0], "");
  assert.ok(ids.includes("/project/sub"));
  assert.equal(store.getState().changes[0].path, "subrepo");
});

test("Worker constructor, postMessage, decode and timeout failures all use bounded fallback", async t => {
  const originalWorker = globalThis.Worker;
  const originalTimer = globalThis.setTimeout;
  t.after(() => { globalThis.Worker = originalWorker; globalThis.setTimeout = originalTimer; });
  const changes = Array.from({ length: 5001 }, (_, i) => change(`f-${i}`));
  const expected = complete(model.buildGitChangeTrees(changes, "all", "module"));
  for (const failure of ["constructor", "post", "decode", "timeout"]) {
    let terminations = 0;
    globalThis.setTimeout = (callback, delay, ...args) => originalTimer(callback, delay === 15000 ? 0 : delay, ...args);
    globalThis.Worker = class {
      constructor() { if (failure === "constructor") throw new Error("unavailable"); }
      postMessage() {
        if (failure === "post") throw new Error("clone_failed");
        if (failure === "decode") queueMicrotask(() => this.onmessageerror());
      }
      terminate() { terminations++; }
    };
    assert.deepEqual(await builder.buildGitTreesAsync(changes, "all", "module", new AbortController().signal), expected);
    assert.equal(terminations, failure === "constructor" ? 0 : 1);
  }
});
