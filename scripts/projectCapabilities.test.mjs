import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-project-capabilities-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function writeModule(name, source) {
  const path = join(tempDir, name);
  writeFileSync(path, source, "utf8");
  return path;
}

writeModule("sshToolIntegration.mjs", `
export const resolveSshHistorySource = (value) => {
  const command = value?.trim().split(/\\s+/, 1)[0]?.toLowerCase();
  return command === "claude" || command === "codex" ? command : null;
};
`);
writeModule("cliTools.mjs", `
export const resolveCliToolHistorySourceId = (value) => (
  value?.toLowerCase().includes("grok") ? "grok" : null
);
`);

const source = readFileSync(new URL("../src/lib/projectCapabilities.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replaceAll('from "./sshToolIntegration"', 'from "./sshToolIntegration.mjs"')
  .replaceAll('from "./cliTools"', 'from "./cliTools.mjs"');
const modulePath = writeModule("projectCapabilities.mjs", output);
const {
  isSshGrokHistoryUnsupported,
  isSshHistorySourceUnsupported,
  projectSupportsCapability,
} = await import(pathToFileURL(modulePath).href);

function project(environment_type, cli_tool) {
  return { environment_type, cli_tool };
}

test("SSH 历史能力只放行 Claude 和 Codex", () => {
  assert.equal(projectSupportsCapability(project("ssh", "claude --model opus"), "history"), true);
  assert.equal(projectSupportsCapability(project("ssh", "codex resume"), "history"), true);
  assert.equal(projectSupportsCapability(project("ssh", "kimi"), "history"), false);
  assert.equal(projectSupportsCapability(project("ssh", "grok build"), "history"), false);
  assert.equal(projectSupportsCapability(project("ssh", "opencode"), "history"), false);
  assert.equal(projectSupportsCapability(project("ssh", ""), "history"), false);
});

test("Grok 限制仅作用于 SSH 历史", () => {
  const sshGrok = project("ssh", "grok build");

  assert.equal(isSshHistorySourceUnsupported(sshGrok), true);
  assert.equal(isSshGrokHistoryUnsupported(sshGrok), true);
  assert.equal(projectSupportsCapability(sshGrok, "statistics"), true);
  assert.equal(projectSupportsCapability(project("local", "grok build"), "history"), true);
  assert.equal(projectSupportsCapability(project("wsl", "grok build"), "history"), true);
});

test("历史入口与双语提示复用 SSH 历史能力判断", () => {
  const terminalTabsSource = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
  const sidebarSource = readFileSync(new URL("../src/components/sidebar/index.tsx", import.meta.url), "utf8");
  const i18nSource = readFileSync(new URL("../src/lib/i18n.ts", import.meta.url), "utf8");

  for (const componentSource of [terminalTabsSource, sidebarSource]) {
    assert.match(componentSource, /isSshHistorySourceUnsupported/);
    assert.match(componentSource, /isSshGrokHistoryUnsupported/);
    assert.match(componentSource, /remoteCapabilities\.grokHistoryUnsupportedTitle/);
    assert.match(componentSource, /remoteCapabilities\.sshHistoryUnsupportedTitle/);
    assert.match(componentSource, /remoteCapabilities\.sshHistoryUnsupportedDescription/);
  }

  assert.match(i18nSource, /"remoteCapabilities\.grokHistoryUnsupportedTitle": "Grok 暂不支持查看会话历史"/);
  assert.match(i18nSource, /"remoteCapabilities\.grokHistoryUnsupportedTitle": "Grok does not support viewing session history yet"/);
  assert.match(i18nSource, /"remoteCapabilities\.sshHistoryUnsupportedDescription": "SSH 远程会话历史目前仅支持 Claude Code 和 Codex CLI。"/);
  assert.match(i18nSource, /"remoteCapabilities\.sshHistoryUnsupportedDescription": "SSH session history currently supports only Claude Code and Codex CLI\."/);
});
