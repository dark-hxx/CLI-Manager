import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const transpile = (file) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const gitRead = {};
vm.runInNewContext(transpile("./webGitRead.ts"), { exports: gitRead, require: () => ({}) });

const summary = { session_id: "cli-a", source: "claude", cwd: "C:/repo", file_path: "C:/claude/projects/C--repo/cli-a.jsonl", project_key: "C--repo" };
const page = { parser: 3, available: true, agentSessionId: "cli-a", start: 0, cursor: 120, size: 120, more: false, events: [{ kind: "user", text: "hi" }] };

/** 每個 fixture 載入一份新的模組，路徑快取與退避狀態互不影響。 */
function fixture({ lookup = async () => summary, read = async () => page, clock } = {}) {
  const projects = { loaded: true, projects: [{ id: "p1", path: "C:/repo", environment_type: "local" }], worktrees: [] };
  const terminals = { sessions: [{ id: "pty-a", projectId: "p1", cliSessionId: "cli-a", cliTool: "claude", environmentType: "local" }] };
  const calls = { lookups: 0, reads: [] };
  const events = {};
  const now = clock ? { now: () => clock.now } : Date;
  vm.runInNewContext(transpile("./webTranscriptEvents.ts"), { exports: events, TextEncoder, Date: now, require: (id) => {
    if (id.endsWith("@tauri-apps/api/core")) return { invoke: async (command, args) => {
      assert.equal(command, "history_live_transcript_read");
      calls.reads.push(args.request);
      return read(args.request);
    } };
    if (id.endsWith("history/index")) return { fetchBoundSessionSummary: async (...args) => { calls.lookups++; return lookup(...args); } };
    if (id.endsWith("historyPathArgs")) return { getHistoryPathArgs: async () => ({ claudeConfigDir: null, codexConfigDir: null }) };
    if (id.endsWith("terminalProject")) return { normalizeProjectPath: (value) => value };
    if (id.endsWith("providerSwitching")) return { getProviderSwitchAppType: () => null };
    return {};
  } });
  const management = {};
  vm.runInNewContext(transpile("./webManagement.ts"), { exports: management, TextEncoder, require: (id) => {
    if (id.endsWith("webGitRead")) return gitRead;
    if (id.endsWith("projectStore")) return { useProjectStore: { getState: () => projects } };
    if (id.endsWith("/state")) return { useTerminalStore: { getState: () => terminals } };
    if (id.endsWith("terminalProject")) return { normalizeProjectPath: (value) => value };
    if (id.endsWith("webDevice")) return { webDeviceApi: { validateContext: async () => {} } };
    if (id.endsWith("webTranscriptEvents")) return events;
    return {};
  } });
  const run = (extra = {}) => management.executeWebManagementOperation({
    kind: "terminal.transcript_events", payload: { projectId: "p1", sessionId: "pty-a", ...extra },
  });
  return { run, projects, terminals, calls };
}

test("exact binding reads the indexed file once and then follows the browser cursor", async () => {
  const f = fixture();
  assert.equal((await f.run()).events[0].text, "hi");
  await f.run({ cursor: 120 });
  assert.equal(f.calls.lookups, 1);
  assert.deepEqual(f.calls.reads.map((request) => [request.filePath, request.cursor, request.agentSessionId]), [
    [summary.file_path, undefined, "cli-a"],
    [summary.file_path, 120, "cli-a"],
  ]);
  assert.equal(f.calls.reads[1].projectKey, "C--repo");
});

test("unbound and unsupported terminals never touch history", async () => {
  const unbound = fixture();
  delete unbound.terminals.sessions[0].cliSessionId;
  assert.equal((await unbound.run()).reason, "unbound");
  const other = fixture();
  other.terminals.sessions[0].cliTool = "gemini";
  assert.equal((await other.run()).reason, "unsupported");
  assert.equal(unbound.calls.lookups + other.calls.lookups, 0);
});

test("a session from another cwd is missing without an ID, and the index is not rescanned during backoff", async () => {
  const f = fixture({ lookup: async () => ({ ...summary, cwd: "C:/elsewhere" }) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.run();
    assert.equal(result.reason, "missing");
    assert.equal(result.agentSessionId, undefined);
  }
  assert.equal(f.calls.lookups, 1);
  assert.equal(f.calls.reads.length, 0);
});

test("a slow index lookup starts its backoff when it finishes", async () => {
  const clock = { now: 0 };
  const f = fixture({ clock, lookup: async () => { clock.now += 6_000; return null; } });
  assert.equal((await f.run()).reason, "missing");
  clock.now += 1_200;
  assert.equal((await f.run()).reason, "missing");
  assert.equal(f.calls.lookups, 1);
  clock.now += 5_000;
  await f.run();
  assert.equal(f.calls.lookups, 2);
});

test("a failed lookup is reported as a failure, not as a new conversation", async () => {
  const f = fixture({ lookup: async () => { throw Error("catalog locked"); } });
  await assert.rejects(f.run(), (error) => error.code === "transcript_lookup_failed");
  assert.equal(f.calls.reads.length, 0);
});

test("a bound session not yet in the index is a pending conversation that keeps its ID", async () => {
  const f = fixture({ lookup: async () => null });
  const result = await f.run();
  assert.equal(result.reason, "missing");
  assert.equal(result.agentSessionId, "cli-a");
  assert.equal((await f.run()).agentSessionId, "cli-a");
  assert.equal(f.calls.lookups, 1);
});

test("a file that vanished after lookup drops the cached path", async () => {
  let gone = true;
  const f = fixture({ read: async () => (gone ? { ...page, available: false, reason: "missing", events: [] } : page) });
  assert.equal((await f.run()).available, false);
  gone = false;
  assert.equal((await f.run()).available, true);
  assert.equal(f.calls.lookups, 2);
});

test("cursor and before are exclusive non-negative byte offsets", async () => {
  const f = fixture();
  for (const extra of [{ cursor: 1, before: 2 }, { cursor: -1 }, { before: 1.5 }, { cursor: "3" }, { cursor: 2 ** 41 }]) {
    await assert.rejects(f.run(extra), (error) => error.code === "invalid_operation_payload", JSON.stringify(extra));
  }
  assert.equal(f.calls.reads.length, 0);
});

test("a foreign project is rejected before any history I/O", async () => {
  const f = fixture();
  await assert.rejects(f.run({ projectId: "foreign" }), (error) => error.code === "project_not_found");
  await assert.rejects(f.run({ sessionId: "foreign" }), (error) => error.code === "history_context_not_found");
  assert.equal(f.calls.lookups, 0);
});

test("changing the CLI identity while the file is being read withholds the page", async () => {
  let release;
  const f = fixture({ read: () => new Promise((resolve) => { release = resolve; }) });
  const pending = f.run();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.terminals.sessions[0].cliSessionId = "cli-other";
  release(page);
  const result = await pending;
  assert.equal(result.available, false);
  assert.equal(result.events.length, 0);
});

test("a cached path is not reused after the project moves to another root", async () => {
  const f = fixture();
  assert.equal((await f.run()).available, true);
  f.projects.projects[0].path = "C:/moved";
  const result = await f.run();
  assert.equal(result.available, false);
  assert.equal(result.agentSessionId, undefined);
  assert.equal(f.calls.lookups, 2);
  assert.equal(f.calls.reads.length, 1);
});

test("a failed read drops the cached path so the next poll looks it up again", async () => {
  let fail = true;
  const f = fixture({ read: async () => { if (fail) throw Error("gone"); return page; } });
  await assert.rejects(f.run(), (error) => error.code === "transcript_read_failed");
  fail = false;
  assert.equal((await f.run()).available, true);
  assert.equal(f.calls.lookups, 2);
});
