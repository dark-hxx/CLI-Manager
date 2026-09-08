import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual extracted runtime with an in-memory Zustand-compatible API.
// Imports are replaced at the module boundary; no Tauri, browser or real timer starts.
function loadModule(file, dependencies = {}) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join("\n");
  const output = ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(output, { exports, ...dependencies }, { filename: file });
  return exports;
}

function fixture(initial = {}, saveSessions = async () => {}) {
  let state = { sessions: [], splits: {}, tabStatuses: {}, subagentTranscripts: {}, ...initial };
  const timers = new Map();
  let nextTimer = 0;
  const api = {
    getState: () => state,
    setState: update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
  };
  const status = loadModule("../src/features/terminal/lib/terminalStatus.ts");
  const subagent = loadModule("../src/features/terminal/lib/subagentTranscriptModel.ts");
  const { createTerminalRuntime } = loadModule("../src/features/terminal/store/terminalRuntime.ts", {
    ...status, ...subagent,
    HOOK_RUNNING_TIMEOUT_MS: 100,
    useSessionStore: { getState: () => ({ saveSessions }) },
    logError() {}, logWarn() {}, logInfo() {}, debugConsoleWarn() {},
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const runtime = createTerminalRuntime(api.setState, api.getState, api);
  api.setState(runtime.actions);
  return { api, runtime, timers, maxChars: status.SUBAGENT_TRANSCRIPT_MAX_CHARS };
}

test("runtime construction starts no timers and keeps counters in one owner", () => {
  const { runtime, timers } = fixture();
  assert.equal(timers.size, 0);
  assert.match(runtime.createPaneId(), /-1$/);
  assert.match(runtime.createPaneId(), /-2$/);
  assert.match(runtime.createWorkspanId(), /-1$/);
  assert.match(runtime.createWorkspanId(), /-2$/);
});

test("attention handling and timeout update the same current store API", () => {
  const { api, timers } = fixture({ sessions: [{ id: "tab" }], tabStatuses: { tab: { hook: "attention" } } });
  api.getState().markAttentionInputHandled("tab");
  assert.equal(api.getState().tabStatuses.tab.hook, "running");
  assert.equal(timers.size, 1);
  const expire = [...timers.values()][0];
  expire();
  assert.equal(api.getState().tabStatuses.tab.hook, "none");
  api.setState({ tabStatuses: { tab: { hook: "attention" } } });
  api.getState().markAttentionInputHandled("tab");
  api.setState({ sessions: [] });
  [...timers.values()].at(-1)();
  assert.equal(api.getState().tabStatuses.tab.hook, "running", "a closed session must not be modified by its timeout");
});

test("transcript actions ignore unknown keys and preserve bounded append/reset behavior", () => {
  const { api, maxChars } = fixture({ subagentTranscripts: { known: { content: "old", resetSeq: 0 } } });
  const prior = api.getState().subagentTranscripts;
  api.getState().appendSubagentTranscript("unknown", "text", false);
  assert.equal(api.getState().subagentTranscripts, prior);
  api.getState().appendSubagentTranscript("known", "tail", false);
  assert.equal(api.getState().subagentTranscripts.known.content, "oldtail");
  api.getState().appendSubagentTranscript("known", "x".repeat(maxChars + 10), false);
  const trimmed = api.getState().subagentTranscripts.known;
  assert.equal(trimmed.content.length, maxChars);
  assert.equal(trimmed.truncatedBytes, 17);
  assert.equal(trimmed.resetSeq, 1);
  api.getState().appendSubagentTranscript("known", "reset", true);
  assert.equal(api.getState().subagentTranscripts.known.content, "reset");
  assert.equal(api.getState().subagentTranscripts.known.truncatedBytes, 0);
  assert.equal(api.getState().subagentTranscripts.known.resetSeq, 2);
});

test("session persistence snapshots inputs, serializes writes and recovers after failure", async () => {
  const writes = [];
  let release;
  const firstWrite = new Promise(resolve => { release = resolve; });
  const { runtime } = fixture({}, async sessions => {
    writes.push(sessions);
    if (writes.length === 1) { await firstWrite; throw new Error("simulated storage failure"); }
  });
  const sessions = [{ id: "first" }];
  const first = runtime.queueSshSessionPersistence(sessions);
  const failed = assert.rejects(first, /simulated storage failure/);
  sessions[0].id = "changed";
  const second = runtime.queueSshSessionPersistence([{ id: "second" }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].id, "first");
  release();
  await failed;
  await second;
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0].id, "second");
});
