import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function moduleBody(file) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
  return ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}

function harness({ snapshots = 0, read = async () => ({ content: "patch" }), readSession = null, extraPayload = "" } = {}) {
  let state, reads = 0;
  const exports = {};
  const create = initializer => {
    const set = update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
    state = initializer(set, () => state);
    return { getState: () => state, setState: set };
  };
  const session = key => ({ session_key: key, tab_id: key, title: key, started_at: "2026-11-01", updated_at: "2026-11-01", status: "saved" });
  const context = {
    exports, create, Blob, TextEncoder, Map, setTimeout, clearTimeout,
    getDb: async () => ({
      execute: async () => {},
      select: async (sql, params) => sql.includes("COUNT") ? [{ total: snapshots }]
        : sql.includes("ai_replay_events") ? Array.from({ length: snapshots }, (_, i) => ({
          id: i, session_key: params[0], event_index: i + 1, kind: "snapshot", title: "snapshot",
          tags_json: "[]", payload_json: JSON.stringify({ patchPath: `replay-snapshots/s/${i}.patch`, extraPayload }),
        })).reverse() : readSession ? await readSession(params[0], session) : [session(params[0])],
    }),
    invoke: async (command, args) => { reads++; return read(command, args); },
    getCliManagerDataPaths: async () => ({ dataDir: "synthetic" }),
    debugConsoleInfo() {}, debugConsoleWarn() {}, logWarn() {}, logError() {},
    translateCurrent: key => key,
  };
  // Test the public store while replacing only persistence and IPC boundaries.
  try {
    const cacheExports = {};
    runInNewContext(moduleBody("../src/features/terminal/api/replayMemory.ts"), { ...context, exports: cacheExports });
    Object.assign(context, cacheExports);
  } catch (err) { if (err.code !== "ENOENT") throw err; }
  runInNewContext(moduleBody("../src/features/terminal/api/replayStore.ts"), context);
  return { store: exports.useReplayStore, reads: () => reads, PatchCache: context.ReplayPatchCache };
}

test("visiting thirty replay sessions does not retain thirty event caches", async () => {
  const h = harness({ snapshots: 1 });
  for (let i = 0; i < 30; i++) await h.store.getState().loadSession(`session-${i}`);
  assert.ok(Object.keys(h.store.getState().eventsBySession).length <= 12);
  assert.equal(h.store.getState().selectedSessionKey, "session-29");
});

test("opening a replay loads metadata without reading any patch files", async () => {
  const h = harness({ snapshots: 16 });
  await h.store.getState().loadSession("session");
  assert.equal(h.reads(), 0);
  assert.equal(h.store.getState().eventsBySession.session.length, 16);
});

test("demand patch reads are single-flight and limited to two concurrent files", async () => {
  let active = 0, peak = 0;
  const h = harness({ snapshots: 16, read: async command => {
    assert.equal(command, "file_read_replay_patch");
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { content: "patch" };
  } });
  await h.store.getState().loadSession("session");
  const state = h.store.getState(), events = state.eventsBySession.session;
  await Promise.all([...events, events[0]].map(event => state.loadSnapshotPatch(event)));
  assert.equal(peak, 2);
  assert.equal(h.reads(), 16);
  await state.loadSnapshotPatch(events[0]);
  assert.equal(h.reads(), 16);
});

test("patch read failures remain visible to the action and can be retried", async () => {
  let fail = true;
  const h = harness({ snapshots: 1, read: async () => {
    if (fail) throw new Error("file_too_large");
    return { content: "recovered" };
  } });
  await h.store.getState().loadSession("session");
  const state = h.store.getState(), event = state.eventsBySession.session[0];
  await assert.rejects(state.loadSnapshotPatch(event), /file_too_large/);
  fail = false;
  assert.equal(await state.loadSnapshotPatch(event), "recovered");
  assert.equal(h.reads(), 2);
});

test("late session loading cannot override a newer selection", async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const h = harness({ readSession: async (key, session) => {
    if (key === "slow") { started(); await new Promise(resolve => { release = resolve; }); }
    return [session(key)];
  } });
  const slow = h.store.getState().loadSession("slow");
  await waiting;
  await h.store.getState().loadSession("newer");
  release(); await slow;
  assert.equal(h.store.getState().selectedSessionKey, "newer");
});

test("event residency is byte bounded even before reaching twelve sessions", async () => {
  const h = harness({ snapshots: 20, extraPayload: "x".repeat(100_000) });
  for (let i = 0; i < 10; i++) await h.store.getState().loadSession(`session-${i}`);
  const cached = h.store.getState().eventsBySession;
  assert.ok(Object.keys(cached).length < 12);
  assert.ok(JSON.stringify(cached).length * 2 < 16 * 1024 * 1024);
  assert.equal(cached["session-9"].length, 20);
});

test("patch LRU budget evicts older files without deleting persisted events", async () => {
  const h = harness();
  const calls = [];
  const cache = new h.PatchCache(async key => { calls.push(key); return "1234"; }, 16);
  await cache.load("A"); await cache.load("B"); await cache.load("A"); await cache.load("C");
  await cache.load("B");
  assert.deepEqual(calls, ["A", "B", "C", "B"]);
});
