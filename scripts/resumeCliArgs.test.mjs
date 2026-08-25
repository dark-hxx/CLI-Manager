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
  for (const [from, to] of Object.entries(replacements)) {
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
writeFileSync(
  join(tempDir, "terminalStore.mjs"),
  "export const detectCliResumeKind = () => null;\n",
  "utf8",
);
writeFileSync(
  join(tempDir, "cliTools.mjs"),
  `export const resolveCliToolHistorySourceId = (tool) => {
    const value = tool?.trim().toLowerCase();
    return ["claude", "codex", "grok", "kimi", "pi", "opencode"].includes(value) ? value : null;
  };\n`,
  "utf8",
);

transpile(new URL("../src/lib/resumeCliArgs.ts", import.meta.url), "resumeCliArgs.mjs");
transpile(new URL("../src/lib/providerSwitching.ts", import.meta.url), "providerSwitching.mjs");
const projectStartupPath = transpile(
  new URL("../src/lib/projectStartupCommand.ts", import.meta.url),
  "projectStartupCommand.mjs",
  {
    "./providerSwitching": "./providerSwitching.mjs",
    "./resumeCliArgs": "./resumeCliArgs.mjs",
    "./shell": "./shell.mjs",
  },
);
const saveSessionPath = transpile(
  new URL("../src/lib/saveSessionToSidebar.ts", import.meta.url),
  "saveSessionToSidebar.mjs",
  {
    "../stores/terminalStore": "./terminalStore.mjs",
    "./resumeCliArgs": "./resumeCliArgs.mjs",
  },
);
const historyResumeCommandPath = transpile(
  new URL("../src/lib/historyResumeCommand.ts", import.meta.url),
  "historyResumeCommand.mjs",
  {
    "./cliTools": "./cliTools.mjs",
    "./projectStartupCommand": "./projectStartupCommand.mjs",
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
const { appendResumeCliArgs, withCodexConfigOverrides, withGrokModelOverride } = await import(pathToFileURL(projectStartupPath).href);
const { buildResumeCliArgs } = await import(pathToFileURL(saveSessionPath).href);
const { buildHistoryResumeCommand, buildRemoteHandoffResumeCommand, stripPiResumeCliArgs, stripKimiResumeCliArgs } = await import(
  pathToFileURL(historyResumeCommandPath).href
);
const historySourcesPath = transpile(
  new URL("../src/lib/historySources.ts", import.meta.url),
  "historySources.mjs",
);
const { HISTORY_SOURCE_DESCRIPTOR_BY_ID } = await import(pathToFileURL(historySourcesPath).href);

const OLD_ID = "019f2c9e-ed25-73e1-a883-86d578fc9e08";
const NEW_ID = "019f5e8b-2d11-76d1-89b4-a0c0ff20d111";
const OPENCODE_ID = "ses_abc123";

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

test("remote handoff resume preserves each Agent identity and strips conflicting selectors", () => {
  const project = (cliTool, cliArgs) => ({
    cli_tool: cliTool,
    cli_args: cliArgs,
    startup_cmd: "",
    provider_overrides: "{}",
    shell: "powershell",
  });

  assert.equal(
    buildRemoteHandoffResumeCommand("codex", NEW_ID, project("codex", `--model o3 resume ${OLD_ID}`)),
    `codex resume --no-alt-screen ${NEW_ID} --model o3`,
  );
  assert.equal(
    buildRemoteHandoffResumeCommand("claude", NEW_ID, project("claude", "--continue --model sonnet")),
    `claude --resume ${NEW_ID} --model sonnet`,
  );
  assert.equal(
    buildRemoteHandoffResumeCommand("pi", NEW_ID, project("pi", `--model opus --session ${OLD_ID}`)),
    `pi --session ${NEW_ID} --model opus`,
  );
  assert.equal(
    buildRemoteHandoffResumeCommand("opencode", OPENCODE_ID, project("opencode", `--model openai/gpt-5 --session=${OLD_ID} -s ${OLD_ID}`)),
    `opencode --session ${OPENCODE_ID} --model openai/gpt-5`,
  );
  assert.equal(buildRemoteHandoffResumeCommand("opencode", "bad id"), null);
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
