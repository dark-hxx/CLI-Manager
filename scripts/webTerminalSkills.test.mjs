import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(path, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, TextEncoder, require: (name) => dependencies[name] ?? {} });
  return exports;
}
const capabilities = load("src/features/agents/api/agentCapabilities.ts", {
  "../../../shared/lib/wslPaths": load("src/shared/lib/wslPaths.ts"),
});

function harness() {
  const calls = [], roots = [];
  const project = { id: "p", path: "D:/project", environment_type: "local", cli_tool: "codex", cli_args: "",
    cli_config_root: "D:/codex-config" };
  const session = { id: "pty", projectId: "p", cliSessionId: "cli-exact", cliTool: "codex", cwd: project.path };
  const store = { loaded: true, projects: [project], worktrees: [] };
  const state = { skills: [{ name: "review", state: "available", description: "Review code", pathLabel: "secret/path" }],
    afterRead() {}, mismatch: false };
  const skills = load("src/features/terminal/lib/webTerminalSkills.ts", {
    "@tauri-apps/api/core": { invoke: async (command, { request }) => {
      calls.push({ command, request }); state.afterRead();
      return { terminalSessionId: request.terminalSessionId, cliSessionId: state.mismatch ? "someone-else" : request.cliSessionId,
        agent: request.agent, environment: request.environment, bridgeStatus: "ready", skills: state.skills,
        mcp: [{ command: "SECRET" }], configFingerprint: "hidden" };
    } },
    "../../agents/api/agentCapabilities": capabilities,
    "../../providers/api/providerSwitching": { getProviderSwitchAppType: (value) => value.cli_tool },
  });
  const management = load("src/features/terminal/lib/webManagement.ts", {
    "./webGitRead": { WEB_GIT_READ_KINDS: new Set() },
    "./webTerminalSkills": skills,
    "../../projects/api/projectStore": { useProjectStore: { getState: () => store } },
    "../state": { useTerminalStore: { getState: () => ({ sessions: [session] }) } },
    "../../../shared/lib/webDevice": { webDeviceApi: { validateContext: async (...args) => roots.push(args) } },
  });
  return { project, session, store, calls, roots, state,
    run: (payload = {}) => management.executeWebManagementOperation({ kind: "terminal.skills", payload: {
      projectId: "p", sessionId: "pty", ...payload,
    } }) };
}

test("Skill operation discovers only in the exact host context and exports invocation metadata", async () => {
  const f = harness();
  f.state.skills.push({ name: "disabled", state: "disabled" }, { name: "bad\nname", state: "available" });
  const result = await f.run();
  assert.equal(result.available, true); assert.equal(result.source, "codex");
  assert.equal(result.skills.length, 1); assert.equal(result.skills[0].name, "review");
  assert.equal(f.calls[0].command, "agent_capabilities_inspect");
  assert.equal(f.calls[0].request.cliSessionId, "cli-exact"); assert.equal(f.calls[0].request.cwd, "D:/project");
  assert.equal(f.calls[0].request.configRoot, "D:/codex-config");
  assert.ok(!JSON.stringify(result).includes("secret/path")); assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(f.roots.length, 3, "validation and both sides of asynchronous inspection resolve host roots");
});

test("unbound and unsupported sessions do not inspect another session or global inventory", async () => {
  for (const change of [(f) => { delete f.session.cliSessionId; }, (f) => { f.session.cliTool = "shell"; }]) {
    const f = harness(); change(f);
    const result = await f.run(); assert.equal(result.available, false); assert.equal(f.calls.length, 0);
  }
});

test("wrong project, worktree, SSH, missing roots and pseudo terminals are rejected before inspection", async () => {
  for (const [change, payload] of [
    [(f) => { f.session.projectId = "other"; }, {}],
    [(f) => { f.session.worktreeId = "wt"; }, {}],
    [(f) => { f.project.environment_type = "ssh"; }, {}],
    [(f) => { f.session.environmentType = "ssh"; }, {}],
    [(f) => { f.session.kind = "file-editor"; }, {}],
    [(f) => { f.store.worktrees.push({ id: "wt", project_id: "p", path: "D:/wt", status: "missing" }); }, { worktreeId: "wt" }],
  ]) {
    const f = harness(); change(f); await assert.rejects(f.run(payload)); assert.equal(f.calls.length, 0);
  }
});

test("Worktree and WSL Skill reads use the registered guest cwd and Hook distro", async () => {
  const f = harness(); f.session.worktreeId = "wt"; f.session.shell = "wsl"; f.session.wslDistroName = "Ubuntu";
  f.project.cli_config_root = "/home/user/.codex";
  f.store.worktrees.push({ id: "wt", project_id: "p", path: "D:/worktree", status: "active" });
  await f.run({ worktreeId: "wt" });
  assert.equal(f.calls[0].request.environment, "wsl"); assert.equal(f.calls[0].request.wslDistroName, "Ubuntu");
  assert.equal(f.calls[0].request.cwd, "/mnt/d/worktree");
});

test("scope or binding changes during discovery cannot publish stale Skills", async () => {
  for (const change of [
    (f) => { f.session.cliSessionId = "replacement"; },
    (f) => { f.project.path = "D:/different"; },
    (f) => { f.project.cli_config_root = "D:/different-home"; },
    (f) => { f.session.envVars = { CODEX_HOME: "D:/replacement-session-home" }; },
    (f) => { f.session.cliTool = "claude"; },
    (f) => { f.state.mismatch = true; },
  ]) {
    const f = harness(); f.state.afterRead = () => change(f);
    await assert.rejects(f.run(), /skill_context_changed/);
  }
});

test("Skill metadata obeys the existing Web result byte limit", async () => {
  const f = harness();
  f.state.skills = Array.from({ length: 500 }, (_, index) => ({ name: `skill-${index}`, state: "available",
    description: "\0".repeat(512) }));
  await assert.rejects(f.run(), (error) => error.code === "skills_too_large");
});

test("Skill inspection uses the launched session's config home before a later project change", async () => {
  for (const [source, key] of [["codex", "CODEX_HOME"], ["claude", "CLAUDE_CONFIG_DIR"]]) {
    const f = harness(); f.session.cliTool = source;
    f.session.envVars = { [key]: "D:/session-home" };
    await f.run();
    assert.equal(f.calls[0].request.configRoot, "D:/session-home");
  }
});
