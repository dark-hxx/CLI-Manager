import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { terminalTranscriptPage } from "./webTerminalTranscript.ts";

const transpile = (file) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const gitRead = {};
vm.runInNewContext(transpile("./webGitRead.ts"), { exports: gitRead, require: () => ({}) });

function fixture(load) {
  const projects = { loaded: true, projects: [{ id: "p1", path: "C:/repo", environment_type: "local" }], worktrees: [] };
  const terminals = { sessions: [{ id: "pty-a", projectId: "p1", cliSessionId: "cli-a", cliTool: "claude", environmentType: "local" }] };
  const exports = {};
  vm.runInNewContext(transpile("./webManagement.ts"), { exports, TextEncoder, require: (id) => {
    if (id.endsWith("webGitRead")) return gitRead;
    if (id.endsWith("projectStore")) return { useProjectStore: { getState: () => projects } };
    if (id.endsWith("/state")) return { useTerminalStore: { getState: () => terminals } };
    if (id === "@tauri-apps/api/core") return { invoke: async (command, { request }) => {
      assert.equal(command, "history_read_live_transcript");
      const value = await load(request);
      return terminalTranscriptPage({ id: request.sessionId, cliSessionId: request.cliSessionId }, value, request.before, request.includeDetails);
    } };
    if (id.endsWith("historyPathArgs")) return { getHistoryPathArgs: async () => ({ claudeConfigDir: "fixture-home" }) };
    if (id.endsWith("terminalProject")) return { normalizeProjectPath: (value) => value };
    if (id.endsWith("webDevice")) return { webDeviceApi: { validateContext: async (root, cwd) => {
      if (root !== cwd) throw Error("canonical context mismatch");
    } } };
    if (id.endsWith("webTerminalTranscript")) return { terminalTranscriptPage };
    return {};
  } });
  const run = (extra = {}) => exports.executeWebManagementOperation({ kind: "terminal.transcript", payload: { projectId: "p1", sessionId: "pty-a", ...extra } });
  return { run, projects, terminals };
}
const detail = { session_id: "cli-a", source: "claude", cwd: "C:/repo", messages: [{ role: "assistant", parts: [{ kind: "text", content: "bound reply" }] }] };

test("native transcript resolves only the selected PTY and rejects a foreign project before history I/O", async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; return detail; });
  assert.equal((await f.run()).messages[0].text, "bound reply");
  await assert.rejects(f.run({ projectId: "foreign" }), (error) => error.code === "project_not_found");
  await assert.rejects(f.run({ sessionId: "foreign" }), (error) => error.code === "history_context_not_found");
  assert.equal(reads, 1);
});
test("native read never falls back from an unbound terminal to a recent cwd conversation", async () => {
  const f = fixture(async () => { throw Error("unbound terminals must not query history"); });
  delete f.terminals.sessions[0].cliSessionId;
  assert.equal((await f.run()).reason, "unbound");
});
test("a project moving while history is loading invalidates its old transcript result", async () => {
  let release;
  const f = fixture(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.run();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.projects.projects[0].path = "C:/another-repo";
  release(detail);
  assert.equal((await pending).available, false);
});
test("changing either CLI identity or source during history I/O withholds the previous transcript", async () => {
  for (const [field, value] of [["cliSessionId", "cli-other"], ["cliTool", "codex"]]) {
    let release;
    const f = fixture(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.run();
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    f.terminals.sessions[0][field] = value;
    release(detail);
    assert.equal((await pending).available, false, `changed ${field}`);
  }
});

test("detailed transcript request crosses the native operation boundary only when requested", async () => {
  for (const source of ["claude", "codex"]) {
    const f = fixture(async () => ({ ...detail, source, messages: [
      { role: "assistant", parts: [{ kind: "tool_call", tool_name: "Bash", call_id: "c1", content: "git status" }] },
      { role: "tool", parts: [{ kind: "tool_result", call_id: "c1", content: "clean" }] },
    ] }));
    f.terminals.sessions[0].cliTool = source;
    assert.equal((await f.run()).messages.length, 0);
    const page = await f.run({ includeDetails: true });
    assert.equal(page.messages.length, 2);
    assert.equal(page.messages[1].parts[0].kind, "tool_result");
    assert.equal((await f.run({ includeDetails: "yes" })).messages.length, 0, "only a boolean opt-in exports details");
  }
});
