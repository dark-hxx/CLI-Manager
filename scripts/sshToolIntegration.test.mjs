import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-ssh-tool-integration-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/sshToolIntegration.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "sshToolIntegration.mjs");
writeFileSync(modulePath, output, "utf8");

const {
  DEFAULT_SSH_TOOL_CONFIG_ROOT,
  parseStoredSshHookReport,
  resolveSshHistorySource,
  resolveSshToolSource,
} = await import(pathToFileURL(modulePath).href);

test("Kimi 命令和带引号路径解析为 Hook source", () => {
  assert.equal(resolveSshToolSource("kimi"), "kimi");
  assert.equal(resolveSshToolSource("kimi.exe --continue"), "kimi");
  assert.equal(resolveSshToolSource('"C:\\Program Files\\Kimi\\kimi.cmd" --model moonshot'), "kimi");
  assert.equal(resolveSshToolSource("'/opt/Kimi Code/kimi' --continue"), "kimi");
  assert.equal(resolveSshToolSource('"/opt/Kimi Code/kimi --continue'), null);
  assert.equal(DEFAULT_SSH_TOOL_CONFIG_ROOT.kimi, "$HOME/.kimi-code");
});

test("Grok 命令和带引号路径解析为 Hook source", () => {
  assert.equal(resolveSshToolSource("grok"), "grok");
  assert.equal(resolveSshToolSource("grok.exe --resume abc"), "grok");
  assert.equal(resolveSshToolSource('"C:\\Program Files\\Grok\\grok.cmd" --continue'), "grok");
  assert.equal(resolveSshToolSource("'/opt/Grok Build/grok' --continue"), "grok");
  assert.equal(resolveSshToolSource('"/opt/Grok Build/grok --continue'), null);
  assert.equal(DEFAULT_SSH_TOOL_CONFIG_ROOT.grok, "$HOME/.grok");
});

test("history resolver 只接受 Claude 和 Codex", () => {
  assert.equal(resolveSshHistorySource("claude"), "claude");
  assert.equal(resolveSshHistorySource("codex resume"), "codex");
  assert.equal(resolveSshHistorySource("kimi"), null);
  assert.equal(resolveSshHistorySource("grok"), null);
});

function report(source, historySourceCandidate) {
  return JSON.stringify({
    action: "installed",
    status: "installed",
    source,
    configFiles: [],
    installation: {
      source,
      historySourceCandidate,
    },
  });
}

test("stored Hook report 强制 Kimi 不携带 history candidate", () => {
  assert.equal(parseStoredSshHookReport(report("kimi", null))?.source, "kimi");
  assert.equal(parseStoredSshHookReport(report("kimi", { source: "kimi" })), null);
  assert.equal(parseStoredSshHookReport(report("kimi", {})), null);
  assert.equal(parseStoredSshHookReport(report("kimi", "present")), null);
  assert.equal(parseStoredSshHookReport(report("kimi", { source: null })), null);
  assert.equal(parseStoredSshHookReport(report("claude", { source: "claude" }))?.source, "claude");
  assert.equal(parseStoredSshHookReport(report("claude", null)), null);
});

test("stored Hook report 强制 Grok 不携带 history candidate", () => {
  assert.equal(parseStoredSshHookReport(report("grok", null))?.source, "grok");
  assert.equal(parseStoredSshHookReport(report("grok", { source: "grok" })), null);
  assert.equal(parseStoredSshHookReport(report("grok", {})), null);
});
