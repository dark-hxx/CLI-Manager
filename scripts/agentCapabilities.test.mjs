import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-agent-capabilities-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/agentCapabilities.ts", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("../src/components/terminal/AgentCapabilitiesCard.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "agentCapabilities.mjs");
writeFileSync(modulePath, output, "utf8");
const {
  buildSessionMcpEvidence,
  inferWslDistroName,
  normalizeAgentCapabilityError,
  resolveAgentRuntimeKind,
} = await import(pathToFileURL(modulePath).href);

test("五类 Agent 启动命令映射稳定", () => {
  assert.equal(resolveAgentRuntimeKind("claude --model opus"), "claude");
  assert.equal(resolveAgentRuntimeKind("codex resume"), "codex");
  assert.equal(resolveAgentRuntimeKind("pi --provider test"), "pi");
  assert.equal(resolveAgentRuntimeKind("grok build"), "grok");
  assert.equal(resolveAgentRuntimeKind("opencode --continue"), "opencode");
});

test("仅 MCP 分类的当前会话工具事件成为健康证据", () => {
  const evidence = buildSessionMcpEvidence({
    tool_events: [
      { name: "Read", category: "builtin", status: "success" },
      { name: "docs", category: "mcp:docs", status: "success", timestamp: "2026-08-11T08:00:00Z" },
      { name: "search", category: "mcp:search", status: "failed", timestamp: "2026-08-11T08:01:00Z" },
    ],
  });
  assert.deepEqual(evidence, [
    { server: "docs", success: true, timestamp: "2026-08-11T08:00:00Z" },
    { server: "search", success: false, timestamp: "2026-08-11T08:01:00Z" },
  ]);
});

test("WSL 与错误信息只暴露稳定标识", () => {
  assert.equal(inferWslDistroName("\\\\wsl.localhost\\Ubuntu\\home\\dev"), "Ubuntu");
  assert.equal(
    normalizeAgentCapabilityError("agent_capability_wsl_timeout: token=secret"),
    "agent_capability_wsl_timeout",
  );
});

test("Agent 能力摘要打开对应受控页签且长内容不挤出状态徽章", () => {
  assert.match(cardSource, /value=\{activeTab\}/);
  assert.doesNotMatch(cardSource, /defaultValue="mcp"/);
  assert.match(cardSource, /onClick=\{\(\) => openDetails\("mcp"\)\}/);
  assert.match(cardSource, /onClick=\{\(\) => openDetails\("skills"\)\}/);
  assert.match(cardSource, /className="min-w-0 flex-1"/);
  assert.match(cardSource, /className="shrink-0"/);
  assert.match(cardSource, /<CliToolIcon icon=\{AGENT_ICON_KEYS\[agent\]\}/);
  assert.match(cardSource, /<HeaderPill color=\{TERM\.cyan\}>/);
});
