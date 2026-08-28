import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-history-resume-command-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/historyResumeCommand.ts", import.meta.url), "utf8");
writeFileSync(
  join(tempDir, "cliTools.mjs"),
  `export const resolveCliToolHistorySourceId = (tool) => {
    const value = tool?.trim().toLowerCase();
    return value === "opencode" ? "opencode" : value === "pi" ? "pi" : null;
  };\n`,
  "utf8",
);
writeFileSync(
  join(tempDir, "projectStartupCommand.mjs"),
  `export const appendResumeCliArgs = (base) => base;\n`,
  "utf8",
);
writeFileSync(
  join(tempDir, "resumeCliArgs.mjs"),
  `export const isValidKimiSessionId = (value) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const isValidGrokSessionId = (value) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const stripKimiResumeCliArgs = (value) => value ?? "";\n`,
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  reportDiagnostics: true,
});
assert.deepEqual(
  (transpiled.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  [],
);
const output = transpiled.outputText
  .replace('from "./cliTools"', 'from "./cliTools.mjs"')
  .replace('from "./projectStartupCommand"', 'from "./projectStartupCommand.mjs"')
  .replace('from "./resumeCliArgs"', 'from "./resumeCliArgs.mjs"');
const outputPath = join(tempDir, "historyResumeCommand.mjs");
writeFileSync(outputPath, output, "utf8");

const {
  buildRemoteHandoffResumeCommand,
  buildHistoryResumeCommand,
  stripOpenCodeResumeCliArgs,
} = await import(pathToFileURL(outputPath).href);

const openCodeSession = { source: "opencode", session_id: "ses_abc123" };
const openCodeProject = {
  cli_tool: "opencode",
  cli_args: "--model provider/model --continue ses_wrong --session=ses_wrong2 -s 'ses_wrong3' --fork ses_wrong4 --prompt \"hello world\"",
  startup_cmd: "",
  provider_overrides: "",
  shell: "powershell",
};

test("OpenCode history resume uses the real session ID", () => {
  assert.equal(
    buildHistoryResumeCommand(openCodeSession),
    "opencode --session ses_abc123",
  );
  assert.equal(
    buildHistoryResumeCommand(openCodeSession, openCodeProject),
    'opencode --session ses_abc123 --model provider/model --prompt "hello world"',
  );
});

test("OpenCode locator and invalid IDs are never passed to the CLI", () => {
  assert.equal(
    buildHistoryResumeCommand({
      source: "opencode",
      session_id: "C:/Users/fengx/.local/share/opencode/opencode.db#session=ses_abc123",
    }),
    null,
  );
  assert.equal(buildHistoryResumeCommand({ source: "opencode", session_id: "msg_abc123" }), null);
  assert.equal(buildHistoryResumeCommand({ source: "opencode", session_id: "ses bad" }), null);
});

test("Kimi shell metacharacters are never passed to the CLI", () => {
  assert.equal(buildHistoryResumeCommand({ source: "kimi", session_id: "01KIMI&calc" }), null);
  assert.equal(buildHistoryResumeCommand({ source: "kimi", session_id: "01KIMI;calc" }), null);
});

test("Grok shell metacharacters are never passed to the CLI", () => {
  assert.equal(buildHistoryResumeCommand({ source: "grok", session_id: "grok&calc" }), null);
  assert.equal(buildHistoryResumeCommand({ source: "grok", session_id: "grok;calc" }), null);
});

test("OpenCode resume argument stripping handles separated, equals and quoted forms", () => {
  assert.equal(
    stripOpenCodeResumeCliArgs(
      "--model provider/model --session ses_a -s=ses_b --continue ses_c -c=ses_d --fork ses_e --prompt 'hello world' --temperature=0.2",
    ),
    "--model provider/model --prompt 'hello world' --temperature=0.2",
  );
});

test("OpenCode remote handoff uses the same strict ID and argument filtering", () => {
  assert.equal(
    buildRemoteHandoffResumeCommand("opencode", "ses_abc123", openCodeProject),
    'opencode --session ses_abc123 --model provider/model --prompt "hello world"',
  );
  assert.equal(buildRemoteHandoffResumeCommand("opencode", "msg_abc123", openCodeProject), null);
});

test("other history sources keep their existing command builders", () => {
  assert.equal(
    buildHistoryResumeCommand({ source: "pi", session_id: "ses_pi" }),
    "pi --session ses_pi",
  );
  assert.equal(
    buildHistoryResumeCommand({ source: "claude", session_id: "session-claude" }),
    "claude --resume session-claude",
  );
  assert.equal(
    buildHistoryResumeCommand({ source: "kimi", session_id: "01KIMISESSIONID0000000001" }),
    "kimi --session 01KIMISESSIONID0000000001",
  );
  assert.equal(
    buildHistoryResumeCommand({ source: "grok", session_id: "grok-session" }),
    "grok --resume grok-session",
  );
});
