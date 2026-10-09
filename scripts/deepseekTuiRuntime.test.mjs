import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "cli-manager-dsh-tui-runtime-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
async function bundle(relative, name) {
  const outfile = join(dir, `${name}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(outfile).href);
}
const runtime = await bundle("../src/features/terminal/api/deepseekTuiRuntime.ts", "runtime");
const helpers = await bundle("../src/shared/lib/deepseekTui.ts", "helpers");
const PTY = "10000000-0000-4000-8000-000000000001";
const CLI = "20000000-0000-4000-8000-000000000002";
const NEXT = "30000000-0000-4000-8000-000000000003";
const osc = (pty = PTY, cli = CLI, end = "\x07") => `\x1b]777;cli-manager-dsh-tui;${pty};${cli}${end}`;
const encoder = new TextEncoder();

test("OSC identity survives every byte boundary including UTF-8 noise and ST terminator", () => {
  const seen = [];
  runtime.setDeepSeekTuiIdentityHandler((pty, cli) => seen.push([pty, cli]));
  const bytes = encoder.encode(`鲸\x1b[31m${osc(PTY, CLI, "\x1b\\")}\x1b[0m`);
  for (let split = 0; split <= bytes.length; split++) {
    runtime.forgetDeepSeekTuiSession();
    runtime.observeDeepSeekTuiOutput(PTY, bytes.slice(0, split));
    runtime.observeDeepSeekTuiOutput(PTY, bytes.slice(split));
  }
  assert.equal(seen.length, bytes.length + 1);
  seen.forEach((value) => assert.deepEqual(value, [PTY, CLI]));
});

test("foreign PTYs, malformed IDs and oversized OSC never bind a tab", () => {
  const seen = [];
  runtime.forgetDeepSeekTuiSession();
  runtime.setDeepSeekTuiIdentityHandler((pty, cli) => seen.push([pty, cli]));
  for (const value of [osc(NEXT), osc(PTY, "bad;id"), osc(PTY, "not-a-UUID"), `\x1b]${"x".repeat(1024)}`]) {
    runtime.observeDeepSeekTuiOutput(PTY, encoder.encode(value));
  }
  runtime.observeDeepSeekTuiOutput(PTY, encoder.encode(osc()));
  assert.deepEqual(seen, [[PTY, CLI]]);
  runtime.observeDeepSeekTuiOutput("other-shell", encoder.encode(osc()));
  assert.equal(seen.length, 1);
});

function loadLaunch(dependencies) {
  const file = "../src/features/terminal/lib/terminalLaunch.ts";
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const body = source.statements.filter((node) => ts.isFunctionDeclaration(node) && ["detectCliResumeKind", "buildCliResumeStartupCommand", "resolvePtyLaunch", "getDeepSeekTuiLaunchSessionId", "clearDeepSeekTuiResumeBeforeStartup"].includes(node.name?.text)).map((node) => node.getText(source)).join("\n");
  const exports = {};
  runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, ...helpers, ...dependencies });
  return exports;
}
const launch = loadLaunch({
  getProviderSwitchAppType: () => "claude", isExactCodexProject: () => false,
  resolveProjectStartupCommand: (project) => project.command,
  appendResumeCliArgs: (base) => base,
  CODEX_COMMAND_PATTERN: /\bcodex\b/, CLAUDE_COMMAND_PATTERN: /\bclaude\b/,
  GROK_COMMAND_PATTERN: /\bgrok\b/, KIMI_COMMAND_PATTERN: /\bkimi\b/,
});

test("DSH identity wins over provider inference and resume always targets this tab", () => {
  const project = { cli_tool: "dsh", command: "dsh --profile dsh-tui -- --model deepseek-chat" };
  assert.equal(launch.detectCliResumeKind(undefined, project), "deepseek-tui");
  const command = launch.buildCliResumeStartupCommand("deepseek-tui", CLI, project);
  const prepared = helpers.prepareDeepSeekTuiCommand(command);
  assert.equal(prepared.resumeSessionId, CLI);
  assert.equal(prepared.command, project.command);
  assert.equal(helpers.prepareDeepSeekTuiCommand(launch.buildCliResumeStartupCommand("deepseek-tui", undefined, project)).resumeSessionId, null);
  assert.equal(helpers.prepareDeepSeekTuiCommand(launch.buildCliResumeStartupCommand("deepseek-tui", "bad & injected", project)).resumeSessionId, null);
});

test("restore preserves a quoted source launcher and replaces an old explicit selection", () => {
  const old = `node 'C:/github works/deepseek-harness/apps/cli/lib/bin.js' --profile dsh-tui --resume ${NEXT} -- --model deepseek-chat`;
  const command = launch.buildCliResumeStartupCommand("deepseek-tui", CLI, undefined, { startupCmd: old });
  const prepared = helpers.prepareDeepSeekTuiCommand(command);
  assert.equal(prepared.resumeSessionId, CLI);
  assert.match(prepared.command, /^node 'C:\/github works\/deepseek-harness/);
  assert.ok(!prepared.command.includes(NEXT));
  const fresh = launch.buildCliResumeStartupCommand("deepseek-tui", undefined, undefined, { startupCmd: old });
  assert.equal(helpers.prepareDeepSeekTuiCommand(fresh).resumeSessionId, null);
});

test("exact PTY binding updates runtime and immediately saves mismatched disk identity", async () => {
  const file = "../src/features/terminal/store/terminalStore.ts";
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let callback;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "setDeepSeekTuiIdentityHandler") callback = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  let state = { sessions: [{ id: PTY, startupCmd: "dsh --profile dsh-tui", cliSessionId: CLI }, { id: NEXT, startupCmd: "dsh --profile dsh-tui", cliSessionId: NEXT }] };
  let persisted = [{ id: PTY }];
  const saves = [];
  const exports = {};
  runInNewContext(ts.transpileModule(`export const handler = ${callback};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, isDeepSeekTuiCommand: helpers.isDeepSeekTuiCommand, get: () => state, set: (next) => state = { ...state, ...next },
    useSessionStore: { getState: () => ({ sessions: persisted }) },
    queueSshSessionPersistence: async (sessions) => { saves.push(sessions); persisted = sessions; }, logWarn() {},
  });
  exports.handler(PTY, CLI);
  await Promise.resolve();
  assert.equal(saves.length, 1, "disk missing identity heals even when runtime identity matches");
  exports.handler(PTY, NEXT);
  await Promise.resolve();
  assert.equal(state.sessions[0].cliSessionId, NEXT);
  assert.equal(state.sessions[1].cliSessionId, NEXT, "the other tab is untouched");
  assert.equal(saves.length, 2);
  exports.handler("missing", CLI);
  assert.equal(saves.length, 2);
});

function launchFixture(project, failPreflight = false, patchPath = "C:/manager cache/bridge.yml") {
  const calls = [];
  const fn = loadLaunch({
    releaseProjectExtensionSnapshot() {},
    useProjectStore: { getState: () => ({ projects: project ? [project] : [] }) },
    resolveShellForPty: (shell) => shell || "powershell",
    defaultShellForOs: () => "powershell", normalizeShellKey: (shell) => shell,
    isDeepSeekHarnessTool: helpers.isDeepSeekTuiTool,
    resolveProjectStartupCommand: (entry) => entry.startup_cmd || helpers.buildDeepSeekTuiCommand(entry.cli_tool, entry.cli_args || "", entry.source || "", entry.shell),
    getDeepSeekSourceRoot: () => project?.source || "", deepSeekLaunchError: (error) => error,
    invoke: async (command, args) => { calls.push([command, args]); if (failPreflight) throw new Error("deepseek_tui_profile_missing"); return { managerPatchPath: patchPath, patchPath, preloadUrl: "file:///C:/manager%20cache/react-preload.mjs", cmdPreloadPath: "C:/manager cache/node-options.cmd" }; },
    prepareProviderLaunchSnapshot: async () => { calls.push(["provider"]); return null; },
    buildNativeProviderLaunchConfigs: () => ({ claudeProvider: null, codexProvider: null, grokProvider: null }),
    resolveExtensionEnvironment: () => null, extensionCliForProject: () => null,
    prepareStartupCommandForPty: (command) => command,
    CLAUDE_COMMAND_PATTERN: /\bclaude\b/,
    buildPtyEnvVars: (env) => env || {}, shouldEnableHookEnv: async () => false,
    getCurrentTerminalColors: () => ({ foreground: "#fff", background: "#000" }),
    parseProjectEnvVars: () => ({}),
    useSshHostStore: { getState: () => ({ loaded: true, hosts: [{ id: "host", startup_script: "" }] }) },
    resolveSshToolSource: () => null, buildSshConnectionSpec: () => ({}), getSshClientInstanceId: () => "client",
    crypto: { randomUUID: () => PTY },
  });
  return { calls, fn };
}

test("native launch preflights before allocation, appends a quoted bridge and clears inherited resume", async () => {
  const project = { id: "project", cli_tool: "dsh", shell: "powershell", source: "C:/github works/deepseek-harness" };
  const { fn, calls } = launchFixture(project);
  const result = await fn.resolvePtyLaunch({ projectId: "project", envVars: { DSH_TUI_RESUME_SESSION: NEXT, NODE_ENV: "development" } }, "windows");
  assert.equal(calls[0][0], "deepseek_tui_prepare_launch");
  assert.equal(calls[0][1].sourceRoot, project.source);
  assert.equal(calls[1][0], "provider");
  assert.match(result.startupCmd, /--profile dsh-tui --patch 'C:\/manager cache\/bridge.yml'/);
  assert.equal(result.invokeArgs.envVars.DSH_TUI_RESUME_SESSION, "");
  assert.equal(result.invokeArgs.envVars.NODE_ENV, "development");
  assert.match(result.startupCmd, /--import=file:\/\/\/C:\/manager%20cache\/react-preload.mjs/);
  assert.equal(result.invokeArgs.envVars.NODE_OPTIONS, undefined, "preload must use actual shell options, not replace the PTY environment");
});

test("failed TUI preflight does not allocate a provider snapshot or start a PTY", async () => {
  const { fn, calls } = launchFixture({ id: "project", cli_tool: "dsh" }, true);
  await assert.rejects(fn.resolvePtyLaunch({ projectId: "project" }, "windows"), /deepseek_tui_profile_missing/);
  assert.equal(calls.length, 1);
});

test("installed launch executes exactly its saved native launcher without overlays or React preload", async () => {
  const { fn, calls } = launchFixture({ id: "project", cli_tool: "dsh", shell: "powershell" });
  const result = await fn.resolvePtyLaunch({ projectId: "project" }, "windows");
  assert.equal(result.persistedStartupCmd, "dsh-tui");
  assert.equal(result.startupCmd, "dsh-tui");
  assert.equal(result.invokeArgs.envVars.DSH_TUI_RESUME_SESSION, undefined);
  assert.equal(calls[0][0], "deepseek_tui_preflight");
  assert.ok(!calls.some(([name]) => name === "deepseek_tui_prepare_launch"));
});

test("CMD native launcher preserves actual user Node options and explicit resume without shell wrappers", async () => {
  const { fn } = launchFixture({ id: "project", cli_tool: "dsh", shell: "cmd" });
  const envVars = { NODE_OPTIONS: '--require="C:/user preload.cjs"' };
  const fresh = await fn.resolvePtyLaunch({ projectId: "project", shell: "cmd", envVars }, "windows");
  assert.equal(fresh.startupCmd, "dsh-tui");
  assert.equal(fresh.persistedStartupCmd, "dsh-tui");
  assert.equal(fresh.invokeArgs.envVars.NODE_OPTIONS, envVars.NODE_OPTIONS);
  const resumed = await fn.resolvePtyLaunch({ projectId: "project", shell: "cmd", startupCmd: `dsh-tui --resume ${CLI}`, envVars }, "windows");
  assert.equal(resumed.startupCmd, "dsh-tui");
  assert.equal(fn.getDeepSeekTuiLaunchSessionId(resumed), CLI);
  assert.equal(envVars.NODE_OPTIONS, '--require="C:/user preload.cjs"');
});

test("native launchers and literal app arguments remain simple across shells, guests and worktree cwd", async () => {
  for (const shell of ["powershell", "pwsh", "cmd", "bash", "zsh", "sh", "gitbash", "wsl", "fish"]) {
    const { fn } = launchFixture(null);
    for (const command of ["dsh-tui", "dst", "& dsh-tui --model example", "dsh-tui -- hello --patch literal"]) {
      const cwd = "C:/project with spaces/.worktrees/feature";
      const result = await fn.resolvePtyLaunch({ startupCmd: command, shell, cwd }, "windows");
      assert.equal(result.startupCmd, command, shell);
      assert.equal(result.persistedStartupCmd, command);
      assert.equal(result.invokeArgs.cwd, cwd);
      assert.equal(result.invokeArgs.envVars.DSH_TUI_RESUME_SESSION, undefined);
    }
  }
  const { fn, calls } = launchFixture(null);
  const remote = await fn.resolvePtyLaunch({ sshHostId: "host", cwd: "/work", startupCmd: "dsh-tui" }, "windows");
  assert.equal(remote.invokeArgs.sshLaunch.startupCommand, "dsh-tui");
  assert.equal(remote.invokeArgs.sshLaunch.environmentOverrides.DSH_TUI_RESUME_SESSION, undefined);
  assert.equal(calls.length, 0);
});

test("native launch removes old manager overlays while preserving user patches and prompt literals", async () => {
  const oldPatch = `C:/manager cache/deepseek-tui/${"a".repeat(64)}/bridge.yml`;
  const hint = `C:/manager cache/deepseek-tui/${"0".repeat(64)}/bridge.yml`;
  const command = `dsh-tui --patch '${oldPatch}' --patch 'C:/user.yml' -- --patch '${oldPatch}'`;
  const { fn } = launchFixture(null, false, hint);
  const result = await fn.resolvePtyLaunch({ startupCmd: command, shell: "powershell" }, "windows");
  assert.equal(result.startupCmd, `dsh-tui --patch 'C:/user.yml' -- --patch '${oldPatch}'`);
  assert.equal(result.persistedStartupCmd, result.startupCmd);
});

test("ordinary CLI startup does not prepare or append the DSH preload", async () => {
  const { fn, calls } = launchFixture(null);
  const result = await fn.resolvePtyLaunch({ startupCmd: "codex", envVars: { NODE_OPTIONS: "--no-warnings" } }, "windows");
  assert.equal(result.startupCmd, "codex");
  assert.equal(result.invokeArgs.envVars.NODE_OPTIONS, "--no-warnings");
  assert.ok(!calls.some(([command]) => command === "deepseek_tui_prepare_launch"));
});

test("WSL launch preserves an explicit per-tab ID without native bridge or global resume", async () => {
  const { fn, calls } = launchFixture({ id: "project", cli_tool: "dsh", shell: "wsl" });
  const result = await fn.resolvePtyLaunch({ projectId: "project", shell: "wsl", startupCmd: `dsh --profile dsh-tui --resume ${CLI}` }, "windows");
  assert.equal(result.startupCmd, "dsh --profile dsh-tui");
  assert.equal(result.invokeArgs.envVars.DSH_TUI_RESUME_SESSION, CLI);
  assert.equal(fn.getDeepSeekTuiLaunchSessionId(result), CLI);
  assert.ok(!calls.some(([command]) => command === "deepseek_tui_prepare_launch"));
});

test("SSH launch keeps explicit resume in remote environment and skips native preparation", async () => {
  const project = { id: "project", cli_tool: "dsh", environment_type: "ssh", ssh_host_id: "host", remote_path: "/work", name: "DSH" };
  const { fn, calls } = launchFixture(project);
  const envVars = { HTTP_PROXY: "http://proxy" };
  const result = await fn.resolvePtyLaunch({ projectId: "project", startupCmd: `dsh --profile dsh-tui --resume ${CLI}`, envVars }, "windows");
  assert.deepEqual(envVars, { HTTP_PROXY: "http://proxy" }, "per-tab identity must not mutate the source environment object");
  assert.equal(result.invokeArgs.sshLaunch.startupCommand, "dsh --profile dsh-tui");
  assert.equal(result.invokeArgs.sshLaunch.environmentOverrides.DSH_TUI_RESUME_SESSION, CLI);
  assert.equal(fn.getDeepSeekTuiLaunchSessionId(result), CLI);
  assert.equal(calls.length, 0);
});

function loadSaveSession() {
  const file = "../src/features/projects/api/saveSessionToSidebar.ts";
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const body = source.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(source)).join("\n");
  const exports = {};
  runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, ...helpers, detectCliResumeKind: launch.detectCliResumeKind });
  return exports;
}

test("saved DSH project roundtrips source configuration and explicit identity through its default launcher", () => {
  const save = loadSaveSession();
  const project = { cli_tool: "dsh", cli_args: `-c --resume ${NEXT} -- --model deepseek-chat`, startup_cmd: "", env_vars: '{"CLI_MANAGER_DSH_SOURCE_ROOT":"C:/github works/deepseek-harness","HTTP_PROXY":"http://proxy"}', path: "C:/work", shell: "powershell" };
  const session = { cliSessionId: CLI, cwd: project.path, startupCmd: "node 'C:/github works/deepseek-harness/apps/cli/lib/bin.js' --profile dsh-tui" };
  const result = save.buildSavedSessionProjectInput({ name: "Pinned DSH", session, project });
  assert.equal(result.ok, true);
  assert.equal(result.input.cli_tool, "dsh");
  assert.equal(result.input.env_vars, project.env_vars);
  assert.equal(result.input.startup_cmd, "");
  const command = helpers.buildDeepSeekTuiCommand(result.input.cli_tool, result.input.cli_args, "C:/github works/deepseek-harness", "powershell");
  const prepared = helpers.prepareDeepSeekTuiCommand(command);
  assert.equal(prepared.resumeSessionId, CLI);
  assert.match(prepared.command, /^node 'C:\/github works\/deepseek-harness/);
  assert.ok(!prepared.command.includes("claude"));
});

test("saved projectless source TUI keeps the host entry and explicit resume instead of Claude", () => {
  const save = loadSaveSession();
  const source = `node 'C:/github works/deepseek-harness/apps/cli/lib/bin.js' --profile dsh-tui --resume ${NEXT} -- --model deepseek-chat`;
  const session = { cliSessionId: CLI, cwd: "C:/work", startupCmd: source, shell: "powershell", envVars: { DSH_HOME: "C:/profile home", PATH: "C:/custom bin" } };
  assert.equal(save.canSaveSessionToSidebar(session, null), true);
  const result = save.buildSavedSessionProjectInput({ name: "DSH source", session, project: null });
  assert.equal(result.ok, true);
  assert.equal(result.input.cli_tool, "dsh");
  assert.equal(result.input.startup_cmd, helpers.buildDeepSeekTuiResumeCommand(source, CLI));
  assert.deepEqual(JSON.parse(result.input.env_vars), session.envVars);
  const prepared = helpers.prepareDeepSeekTuiCommand(result.input.startup_cmd);
  assert.equal(prepared.resumeSessionId, CLI);
  assert.ok(!prepared.command.includes("claude"));
  assert.equal(save.canSaveSessionToSidebar({ ...session, cliSessionId: "bad;calc" }, null), false);
});

test("projectless saved source launch validates the actual host tree without a global dsh", async () => {
  const { fn, calls } = launchFixture(null);
  const command = `node 'C:/github works/deepseek-harness/apps/cli/lib/bin.js' --profile dsh-tui --resume ${CLI}`;
  const result = await fn.resolvePtyLaunch({ startupCmd: command, shell: "powershell" }, "windows");
  assert.equal(calls[0][1].sourceRoot, "C:/github works/deepseek-harness");
  assert.equal(result.invokeArgs.envVars.DSH_TUI_RESUME_SESSION, CLI);
  assert.match(result.persistedStartupCmd, /^node 'C:\/github works\/deepseek-harness/);
  assert.match(result.startupCmd, /node 'C:\/github works\/deepseek-harness/);
});

test("custom installed-host startup validates its actual executable rather than an unused project source", async () => {
  const { fn, calls } = launchFixture({ id: "project", cli_tool: "dsh", source: "C:/other source", startup_cmd: "dsh --profile dsh-tui" });
  await fn.resolvePtyLaunch({ projectId: "project" }, "windows");
  assert.equal(calls[0][1].sourceRoot, null);
});

test("projectless SSH source command is rejected before a remote launch plan is prepared", async () => {
  const { fn, calls } = launchFixture(null);
  const startupCmd = `node 'C:/github works/deepseek-harness/apps/cli/lib/bin.js' --profile dsh-tui --resume ${CLI}`;
  await assert.rejects(fn.resolvePtyLaunch({ sshHostId: "host", cwd: "/work", startupCmd }, "windows"), /deepseek_source_native_only/);
  assert.equal(calls.length, 0);
});

test("SSH custom source command is rejected even without a local source environment setting", async () => {
  const project = { id: "project", cli_tool: "dsh", environment_type: "ssh", ssh_host_id: "host", remote_path: "/work", name: "DSH", startup_cmd: "node 'C:/github works/deepseek-harness/apps/cli/lib/bin.js' --profile dsh-tui" };
  const { fn, calls } = launchFixture(project);
  await assert.rejects(fn.resolvePtyLaunch({ projectId: "project" }, "windows"), /deepseek_source_native_only/);
  assert.equal(calls.length, 0);
});

test("old Web custom startup on a DSH project returns an explicit profile error before preparation", async () => {
  const { fn, calls } = launchFixture({ id: "project", cli_tool: "dsh", startup_cmd: "try { dsh --profile web --port 0 } finally { echo stopped }" });
  await assert.rejects(fn.resolvePtyLaunch({ projectId: "project" }, "windows"), /deepseek_tui_profile_required/);
  assert.equal(calls.length, 0);
});

test("bridge upgrades regenerate one cache patch while stable restore and sidebar retain user patches", async () => {
  const oldPatch = `C:/manager cache/deepseek-tui/${"a".repeat(64)}/bridge.yml`;
  const newPatch = `C:/manager cache/deepseek-tui/${"b".repeat(64)}/bridge.yml`;
  const userPatch = "C:/user config/custom.yml";
  const source = `node 'C:/github works/deepseek-harness/apps/cli/lib/bin.js' --profile dsh-tui --patch '${userPatch}' -- --model deepseek-chat`;
  const first = await launchFixture(null, false, oldPatch).fn.resolvePtyLaunch({ startupCmd: source, shell: "powershell" }, "windows");
  assert.ok(first.startupCmd.includes(oldPatch));
  assert.equal(first.persistedStartupCmd, source);
  assert.ok(!first.persistedStartupCmd.includes("manager cache"));

  // The prior app-owned cache may disappear between launches: only stable configuration is restored.
  const restoreCommand = launch.buildCliResumeStartupCommand("deepseek-tui", CLI, undefined, { startupCmd: first.persistedStartupCmd });
  const second = await launchFixture(null, false, newPatch).fn.resolvePtyLaunch({ startupCmd: restoreCommand, shell: "powershell" }, "windows");
  assert.ok(second.startupCmd.includes(newPatch));
  assert.ok(!second.startupCmd.includes(oldPatch));
  assert.equal(second.startupCmd.match(/--patch/g).length, 2, "one user patch plus exactly one regenerated manager patch");
  assert.equal(second.persistedStartupCmd, source);
  assert.equal(second.invokeArgs.envVars.DSH_TUI_RESUME_SESSION, CLI);

  const saved = loadSaveSession().buildSavedSessionProjectInput({ name: "DSH", session: { startupCmd: second.persistedStartupCmd, cliSessionId: CLI, cwd: "C:/work" }, project: null });
  assert.equal(saved.ok, true);
  assert.ok(saved.input.startup_cmd.includes(userPatch));
  assert.ok(!saved.input.startup_cmd.includes("manager cache"));
  assert.equal(helpers.prepareDeepSeekTuiCommand(saved.input.startup_cmd).resumeSessionId, CLI);

  // Exercise the actual three store metadata expressions (create, split and dead-daemon restore).
  const file = "../src/features/terminal/store/terminalStore.ts";
  const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const expressions = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "startupCmd" && node.initializer.getText(ast).includes("launch.persistedStartupCmd")) expressions.push(node.initializer.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(expressions.length, 3);
  for (const expression of expressions) {
    const exports = {};
    runInNewContext(ts.transpileModule(`export const value = ${expression};`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { exports, launch: second, launchStartupCmd: second.startupCmd, restoredStartupCmd: restoreCommand, startupCmd: source, options: { startupCmd: source } });
    assert.equal(exports.value, source);
  }
});

test("a legacy invalid DSH startup skips only its tab while the following Codex tab restores", async () => {
  const file = "../src/features/terminal/store/terminalStore.ts";
  const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let tryStatement;
  function visit(node) {
    if (ts.isTryStatement(node) && node.tryBlock.getText(ast).includes("restoredStartupCmd = cliKind")) tryStatement = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(tryStatement, "resume command construction must be inside the per-tab error boundary");
  const exports = {};
  const resolved = [];
  const skippedErrors = [];
  const body = `export async function run(rows) {
    const skippedSessions = [];
    for (let i = 0; i < rows.length; i++) {
      const { ps, restoreProject } = rows[i];
      const cliKind = detectCliResumeKind(ps.startupCmd, restoreProject);
      let restoredStartupCmd;
      let launch;
      ${tryStatement}
    }
    return skippedSessions;
  }`;
  runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, detectCliResumeKind: launch.detectCliResumeKind, buildCliResumeStartupCommand: launch.buildCliResumeStartupCommand,
    normalizeDirectCodexStartupCommand: (command) => command,
    resolvePtyLaunch: async (options) => { resolved.push(options); return options; },
    logError: (...args) => skippedErrors.push(args), os: "windows",
  });
  const badCommand = "try { dsh --profile web --port 0 } finally { echo stopped }";
  const skipped = await exports.run([
    { ps: { title: "Old DSH", startupCmd: badCommand, cliSessionId: CLI }, restoreProject: { cli_tool: "dsh", command: badCommand } },
    { ps: { title: "Codex", startupCmd: "codex", cliSessionId: NEXT }, restoreProject: { cli_tool: "codex" } },
  ]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0], "Old DSH");
  assert.equal(skippedErrors.length, 1);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].startupCmd, `codex resume --no-alt-screen ${NEXT}`);
});

test("legacy cached bridge selector is removed from stable restore and custom-project sidebar metadata", async () => {
  const oldPatch = `C:/manager cache/deepseek-tui/${"a".repeat(64)}/bridge.yml`;
  const newPatch = `C:/manager cache/deepseek-tui/${"b".repeat(64)}/bridge.yml`;
  const userPatch = "C:/user config/custom.yml";
  const stable = `dsh --profile dsh-tui --patch '${userPatch}' -- --model deepseek-chat`;
  const old = helpers.withDeepSeekTuiPatch(stable, oldPatch, "powershell");
  const result = await launchFixture(null, false, newPatch).fn.resolvePtyLaunch({ startupCmd: old, shell: "powershell" }, "windows");
  assert.ok(!result.startupCmd.includes(oldPatch));
  assert.equal(result.startupCmd.match(/--patch/g).length, 2);
  assert.equal(result.persistedStartupCmd, stable);
  const saved = loadSaveSession().buildSavedSessionProjectInput({ name: "DSH", session: { startupCmd: result.persistedStartupCmd, cliSessionId: CLI, cwd: "C:/work" }, project: { cli_tool: "dsh", startup_cmd: old } });
  assert.equal(saved.ok, true);
  assert.ok(saved.input.startup_cmd.includes(userPatch));
  assert.ok(!saved.input.startup_cmd.includes("manager cache"));
  assert.equal(helpers.prepareDeepSeekTuiCommand(saved.input.startup_cmd).resumeSessionId, CLI);
});

test("fresh TUI execution unsets the inherited resume target in each shell and keeps stable metadata", async () => {
  const prefixes = {
    powershell: "$env:DSH_TUI_RESUME_SESSION=$null; ",
    pwsh: "$env:DSH_TUI_RESUME_SESSION=$null; ",
    cmd: 'set "DSH_TUI_RESUME_SESSION=" & ',
    bash: "unset DSH_TUI_RESUME_SESSION; ",
    zsh: "unset DSH_TUI_RESUME_SESSION; ",
    sh: "unset DSH_TUI_RESUME_SESSION; ",
    gitbash: "unset DSH_TUI_RESUME_SESSION; ",
    wsl: "unset DSH_TUI_RESUME_SESSION; ",
    fish: "set -e DSH_TUI_RESUME_SESSION; ",
  };
  for (const [shell, prefix] of Object.entries(prefixes)) {
    const { fn } = launchFixture(null);
    const result = await fn.resolvePtyLaunch({ startupCmd: "dsh --profile dsh-tui", shell, envVars: { DSH_TUI_RESUME_SESSION: NEXT } }, "windows");
    assert.ok(result.startupCmd.includes(prefix), shell);
    assert.equal(result.persistedStartupCmd, "dsh --profile dsh-tui");
    const resumed = await fn.resolvePtyLaunch({ startupCmd: `dsh --profile dsh-tui --resume ${CLI}`, shell }, "windows");
    assert.ok(!resumed.startupCmd.includes(prefix), shell);
    assert.equal(resumed.invokeArgs.envVars.DSH_TUI_RESUME_SESSION, CLI);
  }
  const { fn } = launchFixture(null);
  const remote = await fn.resolvePtyLaunch({ sshHostId: "host", cwd: "/work", startupCmd: "dsh --profile dsh-tui" }, "windows");
  assert.equal(remote.invokeArgs.sshLaunch.startupCommand, "unset DSH_TUI_RESUME_SESSION; dsh --profile dsh-tui");
  assert.equal(remote.persistedStartupCmd, "dsh --profile dsh-tui");
});
