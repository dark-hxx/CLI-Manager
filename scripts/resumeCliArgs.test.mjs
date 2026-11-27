import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-resume-cli-args-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpile(sourceUrl, outputName, replacements = {}) {
  const source = readFileSync(sourceUrl, "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: outputName.replace(/\.mjs$/, ".ts"),
  }).outputText;
  for (const [from, to] of Object.entries({
    "./agyStartupCommand": "./agyStartupCommand.mjs", "../../projects/api/agyStartupCommand": "./agyStartupCommand.mjs",
    "../../../shared/lib/cliTools": "./cliTools.mjs", "../../../shared/lib/wslPaths": "./wslPaths.mjs",
    "../lib/historyResumeEnvironment": "./historyResumeEnvironment.mjs", "./agySessionLocation": "./agySessionLocation.mjs",
    "../../projects/api/agySessionLocation": "./agySessionLocation.mjs", ...replacements,
  })) {
    output = output.replaceAll(`from "${from}"`, `from "${to}"`);
  }
  const outputPath = join(tempDir, outputName);
  writeFileSync(outputPath, output, "utf8");
  return outputPath;
}

writeFileSync(
  join(tempDir, "shell.mjs"),
  "export const normalizeShellKey = (value) => value;\n",
  "utf8",
);
const launchSource = ts.createSourceFile("terminalLaunch.ts", readFileSync(
  new URL("../src/features/terminal/lib/terminalLaunch.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);
function launchCodeFor(...names) {
  const nodes = launchSource.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(nodes.length, names.length);
  return ts.transpileModule(nodes.map((node) => node.getText(launchSource).replace(/^export /, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
writeFileSync(join(tempDir, "terminalStore.mjs"), `
import { isAgyCommand } from './cliTools.mjs';
import { isDeepSeekTuiCommand, isDeepSeekTuiTool } from './deepseekTui.mjs';
import { isExactCodexProject, getProviderSwitchAppType } from './providerSwitching.mjs';
import { buildAgyResumeCommand } from './agyStartupCommand.mjs';
${launchSource.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(launchSource).endsWith('_COMMAND_PATTERN'))).map((node) => node.getText(launchSource)).join('\n')}
${launchCodeFor('detectCliResumeKind', 'buildCliResumeStartupCommand')}
export { detectCliResumeKind, buildCliResumeStartupCommand };\n`, 'utf8');
transpile(new URL("../src/shared/lib/cliTools.ts", import.meta.url), "cliTools.mjs", { "./deepseekTui": "./deepseekTui.mjs" });
transpile(new URL("../src/features/projects/api/agyStartupCommand.ts", import.meta.url), "agyStartupCommand.mjs", { "../../../shared/lib/cliTools": "./cliTools.mjs" });
transpile(new URL("../src/shared/lib/wslPaths.ts", import.meta.url), "wslPaths.mjs");
transpile(new URL("../src/features/projects/api/agySessionLocation.ts", import.meta.url), "agySessionLocation.mjs");
transpile(new URL("../src/features/history/lib/historyResumeEnvironment.ts", import.meta.url), "historyResumeEnvironment.mjs", { "../../../shared/lib/wslPaths": "./wslPaths.mjs" });

transpile(new URL("../src/features/history/api/resumeCliArgs.ts", import.meta.url), "resumeCliArgs.mjs");
transpile(new URL("../src/features/providers/api/providerSwitching.ts", import.meta.url), "providerSwitching.mjs");
transpile(new URL("../src/shared/lib/deepseekHarness.ts", import.meta.url), "deepseekHarness.mjs", {
  "../platform/shell": "./shell.mjs",
});
transpile(new URL("../src/shared/lib/deepseekTui.ts", import.meta.url), "deepseekTui.mjs", {
  "../platform/shell": "./shell.mjs",
  "./deepseekHarness": "./deepseekHarness.mjs",
});
const projectStartupPath = transpile(
  new URL("../src/features/projects/api/projectStartupCommand.ts", import.meta.url),
  "projectStartupCommand.mjs",
  {
    "../../providers/api/providerSwitching": "./providerSwitching.mjs",
    "../../history/api/resumeCliArgs": "./resumeCliArgs.mjs",
    "../../../shared/platform/shell": "./shell.mjs",
    "../../../shared/lib/deepseekHarness": "./deepseekHarness.mjs",
    "../../../shared/lib/deepseekTui": "./deepseekTui.mjs",
  },
);
const saveSessionPath = transpile(
  new URL("../src/features/projects/api/saveSessionToSidebar.ts", import.meta.url),
  "saveSessionToSidebar.mjs",
  {
    "../../../shared/lib/deepseekTui": "./deepseekTui.mjs",
    "../../terminal/state": "./terminalStore.mjs",
    "../../history/api/resumeCliArgs": "./resumeCliArgs.mjs",
  },
);
const historyResumeCommandPath = transpile(
  new URL("../src/features/history/api/historyResumeCommand.ts", import.meta.url),
  "historyResumeCommand.mjs",
  {
    "../../../shared/lib/cliTools": "./cliTools.mjs",
    "../../projects/api/projectStartupCommand": "./projectStartupCommand.mjs",
    "./resumeCliArgs": "./resumeCliArgs.mjs",
  },
);

const {
  detectCodexLaunchSessionSelection,
  extractCodexResumeSessionId,
  isValidGrokSessionId,
  stripResumeCliArgs,
} = await import(
  pathToFileURL(join(tempDir, "resumeCliArgs.mjs")).href
);
const {
  appendResumeCliArgs,
  withCodexConfigOverrides,
  withCodexProfile,
  isDirectCodexStartupCommand,
  withGrokModelOverride,
} = await import(pathToFileURL(projectStartupPath).href);
const { buildResumeCliArgs, buildSavedSessionProjectInput, canSaveSessionToSidebar } = await import(pathToFileURL(saveSessionPath).href);
const { detectCliResumeKind, buildCliResumeStartupCommand } = await import(pathToFileURL(join(tempDir, 'terminalStore.mjs')).href);
const { resolveProjectStartupCommand } = await import(pathToFileURL(projectStartupPath).href);
const { buildHistoryResumeCommand, stripPiResumeCliArgs, stripKimiResumeCliArgs } = await import(
  pathToFileURL(historyResumeCommandPath).href
);
const historySourcesPath = transpile(
  new URL("../src/shared/lib/historySources.ts", import.meta.url),
  "historySources.mjs",
);
const { HISTORY_SOURCE_DESCRIPTOR_BY_ID } = await import(pathToFileURL(historySourcesPath).href);

const OLD_ID = "019f2c9e-ed25-73e1-a883-86d578fc9e08";
const NEW_ID = "019f5e8b-2d11-76d1-89b4-a0c0ff20d111";
const OPENCODE_ID = "ses_abc123";

test('agy sidebar roundtrip retains recorded cwd and exact ID, never carries old selectors or one-shot startup', () => {
  const project = { cli_tool: '"C:\\Tools A\\agy.exe" --continue', shell: 'powershell', cli_args: `--model m --conversation ${OLD_ID} -p once`, startup_cmd: '' };
  const session = { cliSessionId: NEW_ID, cwd: 'C:\\Work Tree', shell: 'powershell', environmentType: 'local' };
  assert.equal(canSaveSessionToSidebar(session, project), true);
  const { ok, input } = buildSavedSessionProjectInput({ session, project, name: 'A' });
  assert.equal(ok, true); assert.equal(input.path, session.cwd);
  assert.equal(resolveProjectStartupCommand(input), `& "C:\\Tools A\\agy.exe" --conversation ${NEW_ID} --model m`);
  for (const patch of [{ cliSessionId: '' }, { cliSessionId: '00000000-0000-0000-0000-000000000000' }, {cliSessionId: NEW_ID + '\n'}, { cwd: undefined }, { sshHostId: 'remote' }]) {
    assert.equal(canSaveSessionToSidebar({ ...session, ...patch }, project), false);
    assert.equal(buildSavedSessionProjectInput({ session: { ...session, ...patch }, project, name: 'invalid' }).ok, false);
  }
  const custom = { ...project, startup_cmd: `agy --continue -p once`, cli_tool: 'gemini' };
  assert.equal(buildSavedSessionProjectInput({ session, project: custom, name: 'A' }).input.startup_cmd, `agy --conversation ${NEW_ID}`);
  assert.equal(detectCliResumeKind('echo agy', project), null);
  assert.equal(detectCliResumeKind(`agy -p claude`, { cli_tool: 'codex' }), 'antigravity');
  assert.equal(buildCliResumeStartupCommand('antigravity', NEW_ID, custom), `agy --conversation ${NEW_ID}`);
  assert.throws(() => buildCliResumeStartupCommand('antigravity', '', project));
});

test('agy Hook opt-in alone controls reserved env on native/WSL even with another bridge enabled', async () => {
  for (const [enabled, other] of [[false, false], [false, true], [true, false]]) {
    const mocks = { useSettingsStore: {getState: () => ({ antigravityHookBridgeEnabled: enabled, codexHookBridgeEnabled: other })},
      SHELL_RUNTIME_MONITORING_ENV: 'MONITOR', isShellRuntimeMonitoringEnabled: () => false,
      invoke: async () => ({ status: 'notInstalled' }) };
    const { env, decide } = new Function(...Object.keys(mocks), `${launchCodeFor('buildPtyEnvVars', 'shouldEnableHookEnv')}; return {env:buildPtyEnvVars, decide:shouldEnableHookEnv};`)(...Object.values(mocks));
    for (const shell of ['pwsh', 'zsh', 'wsl']) assert.deepEqual(env({ cli_manager_agy_hook_enabled: 'stale', CLI_MANAGER_AGY_HOOK_ENABLED: 'stale', KEEP: 'yes' }, shell), { KEEP: 'yes', CLI_MANAGER_AGY_HOOK_ENABLED: enabled ? '1' : '0' });
    assert.equal(await decide(), enabled || other);
  }
});

test("extracts an explicit Codex resume session id", () => {
  const cases = [
    [`codex resume ${OLD_ID}`, OLD_ID],
    [`codex resume --no-alt-screen ${OLD_ID}`, OLD_ID],
    [`codex resume --profile provider-a --model o3 ${OLD_ID}`, OLD_ID],
    [`"C:\\tools\\codex.exe" resume "${OLD_ID}"`, OLD_ID],
    ["codex resume --last", null],
    ["codex resume --last continue", null],
    [`claude resume ${OLD_ID}`, null],
  ];

  for (const [command, expected] of cases) {
    assert.equal(extractCodexResumeSessionId(command), expected, command);
  }
});

test("classifies Codex launch session selection modes", () => {
  const cases = [
    ["codex", { kind: "new" }],
    [`codex resume --no-alt-screen ${OLD_ID}`, { kind: "explicit", sessionId: OLD_ID }],
    ["codex resume --no-alt-screen --last", { kind: "last" }],
    ["codex resume", { kind: "interactive" }],
    [`claude resume ${OLD_ID}`, { kind: "new" }],
  ];

  for (const [command, expected] of cases) {
    assert.deepEqual(detectCodexLaunchSessionSelection(command), expected, command);
  }
});

test("strips supported Codex and Claude resume fragments", () => {
  const cases = [
    `resume ${OLD_ID}`,
    `resume --no-alt-screen ${OLD_ID}`,
    "resume --last",
    "resume --no-alt-screen --last",
    "resume --all",
    `resume --include-non-interactive ${OLD_ID}`,
    `--resume ${OLD_ID}`,
    `--resume=${OLD_ID}`,
    "--continue",
  ];

  for (const cliArgs of cases) {
    assert.equal(stripResumeCliArgs(cliArgs), "", cliArgs);
  }
});

test("keeps ordinary CLI arguments around a removed resume fragment", () => {
  assert.equal(
    stripResumeCliArgs(`--model o3 resume ${OLD_ID}`),
    "--model o3",
  );
  assert.equal(
    stripResumeCliArgs(`resume ${OLD_ID} --sandbox workspace-write`),
    "--sandbox workspace-write",
  );
  assert.equal(
    stripResumeCliArgs(`--model "o 3" --resume ${OLD_ID} --permission-mode plan`),
    '--model "o 3" --permission-mode plan',
  );
});

test("parses Codex resume options before the old session id", () => {
  const cases = [
    [`resume --model o3 ${OLD_ID}`, "--model o3"],
    [
      `resume --sandbox workspace-write ${OLD_ID}`,
      "--sandbox workspace-write",
    ],
    ["resume --all", ""],
    [`resume --include-non-interactive ${OLD_ID}`, ""],
    [`resume -c model=o3 ${OLD_ID}`, "-c model=o3"],
    [
      `resume --profile provider-a --enable feature-x ${OLD_ID} "old prompt"`,
      "--profile provider-a --enable feature-x",
    ],
    [
      `resume ${OLD_ID} "old prompt" --model o3 --search`,
      "--model o3 --search",
    ],
  ];

  for (const [cliArgs, expected] of cases) {
    assert.equal(stripResumeCliArgs(cliArgs), expected, cliArgs);
  }
});

test("remote and history resume command construction never appends a second resume target", () => {
  const project = {
    cli_tool: "codex",
    cli_args: `--model o3 resume ${OLD_ID} --sandbox workspace-write`,
    startup_cmd: "",
    provider_overrides: JSON.stringify({
      codex: {
        schemaVersion: 2,
        source: "cli-manager",
        appType: "codex",
        providerId: "provider-id",
        providerName: "Provider",
      },
    }),
    shell: "powershell",
  };

  const command = appendResumeCliArgs(
    `codex resume --no-alt-screen ${NEW_ID}`,
    "codex",
    project,
  );

  assert.equal(
    command,
    `codex resume --no-alt-screen ${NEW_ID} --model o3 --sandbox workspace-write`,
  );
  assert.equal(command.match(/(?:^|\s)resume(?:\s|$)/g)?.length, 1);
  assert.equal(command.match(/(?:^|\s)--profile(?:\s|$)/g), null);
});

test("scoped Codex overrides keep the real CODEX_HOME and prepend safe config args", () => {
  const command = withCodexConfigOverrides(
    `codex resume ${NEW_ID}`,
    [
      "model_provider='cli_manager_scope'",
      "model_providers.cli_manager_scope.base_url='https://api.example.com/v1'",
      "model='gpt-test'",
    ],
  );

  assert.equal(
    command,
    `codex -c "model_provider='cli_manager_scope'" -c "model_providers.cli_manager_scope.base_url='https://api.example.com/v1'" -c "model='gpt-test'" resume ${NEW_ID}`,
  );
  assert.equal(command.includes("CODEX_HOME"), false);
  assert.equal(withCodexConfigOverrides("pwsh -File launch.ps1", ["model='gpt-test'"]), undefined);
  assert.throws(
    () => withCodexConfigOverrides("codex", ["model=\"unsafe\""]),
    /provider_codex_override_invalid/,
  );
  assert.throws(
    () => withCodexConfigOverrides("codex", ["model='$(whoami)'"]),
    /provider_codex_override_invalid/,
  );
});

test("scoped Codex command can carry provider and project MCP overrides together", () => {
  const command = withCodexConfigOverrides("codex", [
    "model_provider='cli_manager_scope'",
    "model_providers.cli_manager_scope.env_key='CLI_MANAGER_PROVIDER_KEY'",
    "mcp_servers.exa_web_search.url='''https://mcp.exa.ai/mcp'''",
    "mcp_servers.exa_web_search.enabled=true",
    "skills.config=[{path='''C:/skills/doc/SKILL.md',enabled=true}]",
  ]);

  assert.equal(
    command,
    `codex -c "model_provider='cli_manager_scope'" -c "model_providers.cli_manager_scope.env_key='CLI_MANAGER_PROVIDER_KEY'" -c "mcp_servers.exa_web_search.url='''https://mcp.exa.ai/mcp'''" -c "mcp_servers.exa_web_search.enabled=true" -c "skills.config=[{path='''C:/skills/doc/SKILL.md',enabled=true}]"`,
  );
  assert.equal(command.includes("--profile"), false);
});

test("scoped Codex project profile keeps the launch command compact", () => {
  assert.equal(
    withCodexProfile("codex", "cli-manager-project-123"),
    "codex --profile cli-manager-project-123",
  );
  assert.equal(
    withCodexProfile("codex resume session-1", "cli-manager-project-123"),
    "codex --profile cli-manager-project-123 resume session-1",
  );
});

test("scoped Grok overrides keep the real GROK_HOME and replace the process model", () => {
  assert.equal(
    withGrokModelOverride("grok --model old --continue", "grok-test"),
    'grok --model "grok-test" --continue',
  );
  assert.equal(
    withGrokModelOverride("grok -m=old --resume session-1", "grok-test"),
    'grok --model "grok-test" --resume session-1',
  );
  assert.equal(withGrokModelOverride("pwsh -File launch.ps1", "grok-test"), undefined);
  assert.throws(
    () => withGrokModelOverride("grok", "$(whoami)"),
    /provider_grok_model_invalid/,
  );
  assert.throws(
    () => withGrokModelOverride("grok", 'model\" --always-approve'),
    /provider_grok_model_invalid/,
  );
});

test("saved-session CLI arguments reuse the same resume stripping rules", () => {
  assert.equal(
    buildResumeCliArgs("codex", `--model o3 resume ${OLD_ID}`, NEW_ID),
    `--model o3 resume --no-alt-screen ${NEW_ID}`,
  );
  assert.equal(
    buildResumeCliArgs("claude", "--continue --model sonnet", NEW_ID),
    `--model sonnet --resume ${NEW_ID}`,
  );
  assert.equal(
    buildResumeCliArgs("kimi", `--model k2 --session ${OLD_ID} -S ${OLD_ID} --continue`, NEW_ID),
    `--model k2 --session ${NEW_ID}`,
  );
  assert.equal(
    buildResumeCliArgs("grok", `--model grok --resume ${OLD_ID}`, NEW_ID),
    `--model grok --resume ${NEW_ID}`,
  );
  assert.equal(buildResumeCliArgs("grok", "", "bad id"), null);
});

test("Grok session IDs reject path separators and shell metacharacters", () => {
  assert.equal(isValidGrokSessionId("grok-session"), true);
  assert.equal(isValidGrokSessionId(NEW_ID), true);
  assert.equal(isValidGrokSessionId("a/b"), false);
  assert.equal(isValidGrokSessionId("a\\b"), false);
  assert.equal(isValidGrokSessionId("../x"), false);
  assert.equal(isValidGrokSessionId("id;rm"), false);
});

test("Pi history resume uses --session and strips every conflicting selector", () => {
  const project = {
    cli_tool: "pi",
    cli_args: `--model sonnet -c old --continue=old -r old --resume old --session old --session-id=old --fork old --session-dir "F:/pi sessions"`,
    startup_cmd: "",
    provider_overrides: "{}",
    shell: "powershell",
  };

  assert.equal(
    buildHistoryResumeCommand({ source: "pi", session_id: NEW_ID }, project),
    `pi --session ${NEW_ID} --model sonnet --session-dir "F:/pi sessions"`,
  );
  assert.equal(
    stripPiResumeCliArgs("--model opus --session-dir custom --fork=old"),
    "--model opus --session-dir custom",
  );
});


test("existing Claude Codex and Grok history resume commands stay unchanged", () => {
  assert.equal(buildHistoryResumeCommand({ source: "claude", session_id: NEW_ID }), `claude --resume ${NEW_ID}`);
  assert.equal(buildHistoryResumeCommand({ source: "codex", session_id: NEW_ID }), `codex resume ${NEW_ID}`);
  assert.equal(buildHistoryResumeCommand({ source: "grok", session_id: NEW_ID }), `grok --resume ${NEW_ID}`);
  assert.equal(buildHistoryResumeCommand({ source: "kimi", session_id: NEW_ID }), `kimi --session ${NEW_ID}`);
  assert.equal(buildHistoryResumeCommand({ source: "pi", session_id: "bad id" }), null);
});

test("Kimi history resume strips continue/session/resume flags", () => {
  assert.equal(
    stripKimiResumeCliArgs(`--model k2 --session ${OLD_ID} -S ${OLD_ID} --resume ${OLD_ID} -r=${OLD_ID} --continue -c -C --prompt hi`),
    "--model k2 --prompt hi",
  );
  const kimiProject = {
    cli_tool: "kimi",
    cli_args: `--session ${OLD_ID} --model k2`,
    startup_cmd: "",
    provider_overrides: "",
    shell: "powershell",
  };
  assert.equal(
    appendResumeCliArgs(`kimi --session ${NEW_ID}`, "kimi", kimiProject),
    `kimi --session ${NEW_ID} --model k2`,
  );
  assert.equal(buildHistoryResumeCommand({ source: "kimi", session_id: "bad&calc" }), null);
  assert.equal(buildResumeCliArgs("kimi", "--model k2", "bad;calc"), null);
});

test("Kimi history source advertises local list delete resume and realtime stats", () => {
  const kimi = HISTORY_SOURCE_DESCRIPTOR_BY_ID.get("kimi");
  assert.equal(kimi?.capabilities.list, "supported");
  assert.equal(kimi?.capabilities.delete, "supported");
  assert.equal(kimi?.capabilities.resume, "supported");
  assert.equal(kimi?.capabilities.realtimeStats, "supported");
});

test("Grok history source advertises local list delete resume and realtime stats", () => {
  const grok = HISTORY_SOURCE_DESCRIPTOR_BY_ID.get("grok");
  assert.equal(grok?.capabilities.list, "supported");
  assert.equal(grok?.capabilities.delete, "supported");
  assert.equal(grok?.capabilities.resume, "supported");
  assert.equal(grok?.capabilities.realtimeStats, "supported");
});

test("Pi history source advertises local resume support", () => {
  assert.equal(HISTORY_SOURCE_DESCRIPTOR_BY_ID.get("pi")?.capabilities.resume, "supported");
});

// Execute the actual launch orchestrator with I/O mocked; keep real command builders.
const {
  isDeepSeekTuiTool, isDeepSeekTuiCommand, isDeepSeekTuiLauncherCommand,
  getDeepSeekTuiCommandSourceRoot,
} = await import(pathToFileURL(join(tempDir, "deepseekTui.mjs")).href);
const launchCode = launchCodeFor("resolvePtyLaunch");
const proxySettingsPath = transpile(new URL("../src/shared/lib/proxySettings.ts", import.meta.url), "proxySettings.mjs", {
  "./cliTools": "./cliTools.mjs",
});
const { DEFAULT_PROXY_SETTINGS, resolveEffectiveProxy, applyProxyToEnvVars } = await import(pathToFileURL(proxySettingsPath).href);

test("pending Codex trust keeps bridge env without trusting hooks or writing config", async () => {
  const fn = launchSource.statements.find((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "shouldEnableHookEnv");
  const code = ts.transpileModule(fn.getText(launchSource).replace(/^export /, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const complete = { status: "partialInstalled", hooksFeatureInstalled: true,
    sessionStartHookInstalled: true, runningHookInstalled: true, attentionHookInstalled: true,
    stopHookInstalled: true, subagentStartHookInstalled: true };
  for (const [codex, enabled, expected] of [
    [complete, true, true], [{ status: "installed" }, true, true],
    [{ ...complete, hooksFeatureInstalled: false }, true, true],
    [{ ...complete, runningHookInstalled: false }, true, true],
    [{ status: "partialInstalled" }, true, true], [complete, false, false],
  ]) {
    const calls = [];
    const mocks = {
      useSettingsStore: { getState: () => ({ codexHookBridgeEnabled: enabled,
        claudeHookBridgeEnabled: false, kimiHookBridgeEnabled: false,
        piHookBridgeEnabled: false, grokHookBridgeEnabled: false }) },
      logError: () => {},
      invoke: async (command) => {
        calls.push(command);
        assert.equal(command, "opencode_hook_status",
          `terminal creation must not inspect or repair Codex ${codex.status} hooks`);
        return { status: "notInstalled" };
      },
    };
    const decide = new Function(...Object.keys(mocks), `${code}; return shouldEnableHookEnv;`)(...Object.values(mocks));
    assert.equal(await decide(), expected);
    assert.deepEqual(calls, enabled ? [] : ["opencode_hook_status"]);
  }
});

async function resolveProviderTestLaunch({ profile = "cli-manager-provider", combined, startup = "codex", shell = "cmd" } = {}) {
  const project = { id: "project", environment_type: "local", cli_tool: "codex" };
  const provider = { appType: "codex", codexProfileName: profile,
    configOverrides: ["model_provider='legacy-provider'"], snapshotId: "provider-snapshot" };
  const extensions = { codexProfileName: combined, codexConfigOverrides: ["skills.bundled.enabled=false"],
    snapshotId: "extension-snapshot", mcpStatus: "applied", skillStatus: "applied", warnings: [] };
  const mocks = {
    useProjectStore: { getState: () => ({ projects: [project] }) },
    useSettingsStore: { getState: () => ({ proxySettings: DEFAULT_PROXY_SETTINGS }) },
    resolveEffectiveProxy, applyProxyToEnvVars,
    resolveShellForPty: () => shell,
    resolveProjectStartupCommand: () => startup,
    prepareProviderLaunchSnapshot: async () => provider,
    buildNativeProviderLaunchConfigs: () => ({}),
    resolveExtensionEnvironment: () => ({ environmentKind: shell === "wsl" ? "wsl" : "local" }),
    extensionCliForProject: () => "codex",
    prepareProjectExtensionLaunch: async () => extensions,
    releaseProjectExtensionSnapshot: () => {}, releaseProviderSnapshot: () => {},
    withCodexConfigOverrides, withCodexProfile, isDirectCodexStartupCommand,
    isAgyCommand: (await import(pathToFileURL(join(tempDir, "cliTools.mjs")).href)).isAgyCommand,
    isDeepSeekTuiTool, isDeepSeekTuiCommand, isDeepSeekTuiLauncherCommand,
    getDeepSeekTuiCommandSourceRoot,
    prepareStartupCommandForPty: (value) => value, normalizeShellKey: (value) => value,
    extensionLaunchStatus: () => "applied", buildPtyEnvVars: () => null,
    shouldEnableHookEnv: async () => false, getCurrentTerminalColors: () => ({}), logWarn: () => {},
  };
  const resolve = new Function(...Object.keys(mocks), `${launchCode}; return resolvePtyLaunch;`)(...Object.values(mocks));
  return resolve({ projectId: "project", cwd: "F:\\test" }, "windows");
}

test("combined Codex profile is the actual project launch entry", async () => {
  const result = await resolveProviderTestLaunch({ combined: "cli-manager-project-snapshot" });
  assert.equal(result.startupCmd, "codex --profile cli-manager-project-snapshot");
  assert.equal(result.extensionSnapshotId, "extension-snapshot");
});

test("missing combined profile retains complete provider profile plus extension overrides", async () => {
  for (const shell of ["cmd", "powershell", "pwsh"]) {
    const result = await resolveProviderTestLaunch({ shell });
    assert.equal(result.startupCmd,
      'codex -c "skills.bundled.enabled=false" --profile cli-manager-provider');
    assert.equal(result.extensionStatus, "applied");
    assert.equal(result.extensionSnapshotId, "extension-snapshot");
  }
});

test("legacy snapshots still use routing overrides without fabricating a profile", async () => {
  const result = await resolveProviderTestLaunch({ profile: null });
  assert.equal(result.startupCmd,
    'codex -c "model_provider=\'legacy-provider\'" -c "skills.bundled.enabled=false"');
});

test("explicit startup profiles retain previous provider routing enforcement", async () => {
  const result = await resolveProviderTestLaunch({ startup: "codex --profile personal" });
  assert.equal(result.startupCmd,
    'codex -c "model_provider=\'legacy-provider\'" -c "skills.bundled.enabled=false" --profile personal');
});

test("WSL extension fallback does not refer to a profile written into the Windows Home", async () => {
  const result = await resolveProviderTestLaunch({ shell: "wsl" });
  assert.equal(result.startupCmd,
    'codex -c "model_provider=\'legacy-provider\'" -c "skills.bundled.enabled=false"');
});

test("saved DSH TUI args replace global selectors with one explicit tab identity before app args", () => {
  assert.equal(buildResumeCliArgs("deepseek-tui", `--resume ${OLD_ID} -c --continue -- --model deepseek-chat`, NEW_ID), `--resume ${NEW_ID} -- --model deepseek-chat`);
  assert.equal(buildResumeCliArgs("deepseek-tui", `--resume=${OLD_ID} --model deepseek-chat`, NEW_ID), `--model deepseek-chat --resume ${NEW_ID}`);
  assert.equal(buildResumeCliArgs("deepseek-tui", "", "bad;calc"), null);
});
