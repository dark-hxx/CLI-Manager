import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 执行真实启动编排/参数构造，仅替换设置、平台与 IPC 等外部依赖。
function declarations(path, names) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  return source.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return names.includes(node.name?.text);
    return ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.includes(item.name.getText(source)));
  }).map((node) => node.getText(source)).join("\n");
}

function loadLaunch(light = false) {
  const code = declarations("../src/features/projects/api/projectStartupCommand.ts", [
    "DIRECT_CODEX_COMMAND_PATTERN", "CODEX_LIGHT_TUI_THEME_ARG", "isDirectCodexStartupCommand",
    "normalizeDirectCodexStartupCommand", "withCodexNoDaemon", "withCodexLightTuiTheme", "hasCodexThemeConfigArg",
  ]) + "\n" + declarations("../src/features/terminal/lib/terminalLaunch.ts", [
    "prepareStartupCommandForPty", "resolvePtyLaunch", "formatStartupInputForPty", "buildDirectCodexLaunchCommand",
  ]);
  const exports = {};
  runInNewContext(ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    isCurrentTerminalBackgroundLight: () => light,
    useProjectStore: { getState: () => ({ projects: [] }) },
    useSshHostStore: { getState: () => ({ loaded: true, hosts: [{ id: "host", startup_script: "" }] }) },
    buildSshConnectionSpec: () => ({}), getSshClientInstanceId: () => "client",
    crypto: { randomUUID: () => "epoch" },
    resolveShellForPty: (shell) => shell, normalizeShellKey: (shell) => shell,
    isDeepSeekTuiCommand: () => false, isDeepSeekTuiLauncherCommand: () => false,
    getDeepSeekTuiCommandSourceRoot: () => null,
    prepareProviderLaunchSnapshot: async () => null, buildNativeProviderLaunchConfigs: () => ({}),
    releaseProjectExtensionSnapshot: () => {},
    resolveExtensionEnvironment: () => null, extensionCliForProject: () => null,
    CLAUDE_COMMAND_PATTERN: /\bclaude\b/,
    buildPtyEnvVars: (env) => env ?? {}, shouldEnableHookEnv: async () => true,
    getCurrentTerminalColors: () => ({}),
  });
  return exports;
}

const launch = loadLaunch();
const isolated = (args = "") => `codex --no-daemon${args}`;

test("automatic local and WSL Codex launches opt out of the first terminal's shared server", async () => {
  for (const shell of ["powershell", "pwsh", "cmd", "gitbash", "wsl", "bash", "zsh", "fish"]) {
    const result = await launch.resolvePtyLaunch({ cwd: "F:/repo", shell, startupCmd: "codex --yolo" }, "windows");
    assert.equal(result.startupCmd, isolated(" --yolo"), shell);
    assert.equal(launch.formatStartupInputForPty(result.startupCmd, shell), `\x0c${isolated(" --yolo")}\r`);
  }
});

test("SSH bootstrap receives the same isolated Codex startup command", async () => {
  const result = await launch.resolvePtyLaunch({ sshHostId: "host", cwd: "/home/repo", startupCmd: "codex --yolo" }, "windows");
  assert.equal(result.startupHandledByLaunch, true);
  assert.equal(result.startupCmd, isolated(" --yolo"));
  assert.equal(result.invokeArgs.sshLaunch.startupCommand, isolated(" --yolo"));
});

test("resume, provider arguments and literal prompts survive isolation", () => {
  for (const args of [
    " resume --no-alt-screen thread-3",
    " resume --last --profile cli-manager-provider",
    ' --profile provider -c "model_context_window=200000" --yolo',
    ' "Explain --remote and a & b without running them"',
  ]) {
    assert.equal(launch.prepareStartupCommandForPty(`codex${args}`, "cmd"), isolated(args));
  }
  for (const executable of ["codex.exe", "codex.cmd", "codex.ps1"]) {
    assert.equal(launch.prepareStartupCommandForPty(`${executable} --yolo`, "powershell"),
      `${executable} --no-daemon --yolo`);
  }
});

test("restoring an already prepared command does not accumulate managed overrides", () => {
  const prepared = launch.prepareStartupCommandForPty("codex --yolo", "cmd");
  assert.equal(launch.prepareStartupCommandForPty(prepared, "cmd"), prepared);
});

test("Git Bash light theme composes with isolation and preserves explicit theme", () => {
  const light = loadLaunch(true);
  assert.equal(light.prepareStartupCommandForPty("codex --yolo", "gitbash"),
    `codex -c theme=catppuccin-latte --no-daemon --yolo`);
  assert.equal(light.prepareStartupCommandForPty('codex -c theme=dark', "gitbash"), isolated(" -c theme=dark"));
});

test("other tools and custom launch scripts keep their original command", async () => {
  for (const command of [undefined, "claude --resume thread", "pwsh -File codex.ps1", "echo codex", "my-codex"]) {
    assert.equal(launch.prepareStartupCommandForPty(command, "cmd"), command);
  }
  const result = await launch.resolvePtyLaunch({ sshHostId: "host", cwd: "/home/repo", startupCmd: "grok" }, "windows");
  assert.equal(result.invokeArgs.sshLaunch.startupCommand, "grok");
});

test("no-daemon is required even when daemon_auto_start is already disabled", () => {
  const command = 'codex -c "features.daemon_auto_start=false" --yolo';
  assert.equal(launch.prepareStartupCommandForPty(command, "powershell"),
    'codex --no-daemon -c "features.daemon_auto_start=false" --yolo');
  assert.equal(launch.prepareStartupCommandForPty('codex -c "features.daemon_auto_start=true"', "cmd"),
    'codex --no-daemon -c "features.daemon_auto_start=true"');
});

test("quoted prompt text and -- separator cannot masquerade as launch flags", () => {
  for (const args of [
    ' "Explain --no-daemon before changing anything"',
    " 'Explain --remote unix:// and --no-daemon'",
    ' "Explain \\"quoted\\" --no-daemon"',
    ' -- "--no-daemon"',
    ' -- "--remote=unix://"',
  ]) {
    assert.equal(launch.prepareStartupCommandForPty(`codex${args}`, "powershell"), isolated(args));
  }
  for (const command of [
    'codex --no-daemon --yolo', 'codex "--no-daemon"',
    'codex --remote unix://', 'codex --remote=unix://',
  ]) assert.equal(launch.prepareStartupCommandForPty(command, "powershell"), command);
});

// 同一份 Hook 配置可由正式版安装、开发版接收；安装路径不是接收实例的身份。
function loadHookEnvPolicy(settings, invoke, errors = []) {
  const exports = {};
  runInNewContext(ts.transpileModule(declarations("../src/features/terminal/lib/terminalLaunch.ts", ["shouldEnableHookEnv"]), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, useSettingsStore: { getState: () => settings }, invoke, logError: (...args) => errors.push(args) });
  return exports.shouldEnableHookEnv;
}

test("an enabled bridge always receives this instance's callback even with another executable installed", async () => {
  for (const source of ["claude", "codex", "kimi", "pi", "grok"]) {
    let calls = 0;
    const enabled = loadHookEnvPolicy({ [`${source}HookBridgeEnabled`]: true }, async () => {
      calls++;
      throw new Error("installed Hook points to release executable, not dev executable");
    });
    assert.equal(await enabled(), true, source);
    assert.equal(calls, 0, "terminal creation must not depend on status or repair shared Hook files");
  }
});

test("all disabled bridges preserve the independent OpenCode plugin policy", async () => {
  for (const status of ["installed", "missing", "partial"]) {
    const calls = [];
    const enabled = loadHookEnvPolicy({}, async (command) => { calls.push(command); return { status }; });
    assert.equal(await enabled(), status === "installed");
    assert.deepEqual(calls, ["opencode_hook_status"]);
  }
  const errors = [];
  const enabled = loadHookEnvPolicy({}, async () => { throw new Error("offline"); }, errors);
  assert.equal(await enabled(), false);
  assert.equal(errors.length, 1);
});
