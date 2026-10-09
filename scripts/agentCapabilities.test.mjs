import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import * as React from "react";
import { renderToString } from "react-dom/server";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-agent-capabilities-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const emitModule = (name, path) => {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022}}).outputText
    .replaceAll('"../../../shared/lib/wslPaths"', '"./wslPaths.mjs"');
  writeFileSync(join(tempDir, name + ".mjs"), output);
};
emitModule("wslPaths", "../src/shared/lib/wslPaths.ts");

const source = readFileSync(new URL("../src/features/agents/api/agentCapabilities.ts", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("../src/features/terminal/components/AgentCapabilitiesCard.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll('"../../../shared/lib/wslPaths"', '"./wslPaths.mjs"');
const modulePath = join(tempDir, "agentCapabilities.mjs");
writeFileSync(modulePath, output, "utf8");
const capabilityHelpers = await import(pathToFileURL(modulePath).href);
const {
  buildSessionMcpEvidence,
  inferWslDistroName,
  normalizeAgentCapabilityError,
  resolveAgentRuntimeKind,
  resolveWslCapabilityLocation,
  toWslGuestPath,
} = capabilityHelpers;

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

test("WSL 目标路径归一为 guest 内绝对路径", () => {
  assert.equal(toWslGuestPath("F:\\github\\cli-manager"), "/mnt/f/github/cli-manager");
  assert.equal(toWslGuestPath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\app"), "/home/dev/app");
  assert.equal(toWslGuestPath("\\\\wsl$\\Ubuntu\\home\\dev"), "/home/dev");
  // OSC 7 在 Windows 上会带上主机名前缀
  assert.equal(toWslGuestPath("//DESKTOP-ABC/home/dev/app"), "/home/dev/app");
  assert.equal(toWslGuestPath("//DESKTOP-ABC/mnt/f/github/app"), "/mnt/f/github/app");
  assert.equal(toWslGuestPath("//DESKTOP-ABC"), "/");
  // 已是 guest 路径则原样保留
  assert.equal(toWslGuestPath("/home/dev/app"), "/home/dev/app");
  assert.equal(toWslGuestPath("  /mnt/f/github/app  "), "/mnt/f/github/app");
  // 解析不出的形态不臆造
  assert.equal(toWslGuestPath(""), null);
  assert.equal(toWslGuestPath(null), null);
  assert.equal(toWslGuestPath("relative/path"), null);
  assert.equal(toWslGuestPath("\\\\fileserver\\share"), null);
});

test("WSL 诊断目标优先采用 hook 上报的发行版并转换为 guest cwd", () => {
  // 场景 1/2：Windows 路径项目 + shell=wsl 是常见形态，项目路径与会话 cwd 都没有 UNC
  assert.deepEqual(
    resolveWslCapabilityLocation({
      hookDistroName: "Ubuntu-22.04",
      sessionCwd: "F:\\github\\cli-manager",
      projectPath: "F:\\github\\cli-manager",
    }),
    { distroName: "Ubuntu-22.04", cwd: "/mnt/f/github/cli-manager" },
  );
  assert.deepEqual(
    resolveWslCapabilityLocation({
      hookDistroName: "Ubuntu",
      sessionCwd: "/mnt/f/github/cli-manager",
      projectPath: "F:\\github\\cli-manager",
    }),
    { distroName: "Ubuntu", cwd: "/mnt/f/github/cli-manager" },
  );
  // 场景 3：WSL UNC 项目路径不回归
  assert.deepEqual(
    resolveWslCapabilityLocation({
      hookDistroName: null,
      sessionCwd: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
      projectPath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
    }),
    { distroName: "Ubuntu", cwd: "/home/dev/app" },
  );
  // 场景 4：OSC 主机前缀路径不再被当成合法 guest 路径
  assert.deepEqual(
    resolveWslCapabilityLocation({
      hookDistroName: "Ubuntu",
      sessionCwd: "//DESKTOP-ABC/home/dev/app",
      projectPath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
    }),
    { distroName: "Ubuntu", cwd: "/home/dev/app" },
  );
  // hook 发行版缺失时回退到路径推断；两者都没有则保持 null，交由后端给出稳定错误
  assert.equal(
    resolveWslCapabilityLocation({ hookDistroName: "  ", sessionCwd: null, configRoot: "\\\\wsl.localhost\\Debian\\home\\dev" }).distroName,
    "Debian",
  );
  assert.deepEqual(
    resolveWslCapabilityLocation({ sessionCwd: null, projectPath: null }),
    { distroName: null, cwd: null },
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

test("旧 Hook 缺少发行版时可从精确会话的普通或扩展 WSL UNC 来源恢复身份", () => {
  for (const filePath of [
    "\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex\\sessions\\current.jsonl",
    "\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\dev\\.codex\\sessions\\current.jsonl",
    "//wsl$/Ubuntu/home/dev/.codex/sessions/current.jsonl",
  ]) {
    assert.deepEqual(resolveWslCapabilityLocation({
      projectPath: "E:\\Projects\\example",
      sessionCwd: "/mnt/e/Projects/example",
      boundSessionFilePath: filePath,
    }), { distroName: "Ubuntu", cwd: "/mnt/e/Projects/example" });
  }
  assert.deepEqual(resolveWslCapabilityLocation({
    boundSessionFilePath: "\\\\wsl.localhost\\Debian\\home\\dev\\.codex\\sessions\\current.jsonl",
  }), { distroName: "Debian", cwd: null }, "历史文件目录不能被当成项目 cwd");
});

test("精确历史补充身份不覆盖已有 Hook、终端、项目或配置目录身份", () => {
  const boundSessionFilePath = "\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex\\sessions\\current.jsonl";
  for (const explicit of [
    { hookDistroName: " Debian " },
    { sessionCwd: "\\\\wsl.localhost\\Debian\\home\\dev\\project" },
    { projectPath: "\\\\wsl$\\Debian\\home\\dev\\project" },
    { configRoot: "\\\\wsl.localhost\\Debian\\home\\dev\\.codex" },
  ]) {
    assert.equal(resolveWslCapabilityLocation({ boundSessionFilePath, ...explicit }).distroName, "Debian");
  }
});

const hookOutput = ts.transpileModule(
  readFileSync(new URL("../src/features/agents/api/useAgentCapabilities.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

// 用真实 React Hook 构造请求，仅替换 IPC/SSH 边界；SSR 不运行自动 effect，也不启动桌面服务。
async function captureCapabilityRequest(input, probe = false) {
  const requests = [];
  const exports = {};
  runInNewContext(hookOutput, {
    exports,
    require(name) {
      if (name === "react") return React;
      if (name === "./agentCapabilities") return capabilityHelpers;
      if (name === "../../remote/api/sshAgentHistory") {
        return { buildSshAgentProjectLaunch: async () => ({ clientInstanceId: "client", hostId: "host" }) };
      }
      if (name === "@tauri-apps/api/core") {
        return { invoke: async (command, args) => {
          requests.push({ command, request: args.request });
          return { configFingerprint: "fixture" };
        } };
      }
      throw new Error("Unexpected dependency: " + name);
    },
  });
  let controls;
  function Harness() {
    controls = exports.useAgentCapabilities(input);
    return null;
  }
  renderToString(React.createElement(Harness));
  await (probe ? controls.probe() : controls.refresh());
  return requests;
}

const wslInput = {
  terminalSession: {
    id: "terminal-current", cliSessionId: "session-current", cliTool: "codex",
    environmentType: "wsl", shell: "wsl", cwd: "E:\\Projects\\example",
  },
  project: { id: "project", cli_tool: "codex", cli_args: "", environment_type: "local", path: "E:\\Projects\\example" },
  boundSession: {
    session_id: "session-current", source: "codex",
    file_path: "\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\dev\\.codex\\sessions\\current.jsonl",
    cwd: "/mnt/e/Projects/example",
    tool_events: [{ category: "mcp:docs", status: "success" }],
  },
  projectPath: "E:\\Projects\\example",
  active: true, enabled: true, refreshSeq: 0,
};

test("客户 Windows 路径项目与旧 Hook 的 inspect/probe 请求携带精确历史发行版", async () => {
  for (const probe of [false, true]) {
    const [call] = await captureCapabilityRequest(wslInput, probe);
    assert.equal(call.command, probe ? "agent_capabilities_probe" : "agent_capabilities_inspect");
    assert.equal(call.request.wslDistroName, "Ubuntu");
    assert.equal(call.request.cwd, "/mnt/e/Projects/example");
    assert.equal(call.request.cliSessionId, "session-current");
    assert.equal(call.request.runtimeEvidence[0].server, "docs");
  }
});

test("历史尚未返回、不同 CLI 会话和不同 Agent 均不能提供 WSL 身份或 MCP 证据", async () => {
  for (const boundSession of [
    null,
    { ...wslInput.boundSession, session_id: "session-other" },
    { ...wslInput.boundSession, source: "claude" },
  ]) {
    const [call] = await captureCapabilityRequest({ ...wslInput, boundSession });
    assert.equal(call.request.wslDistroName, null);
    assert.equal(call.request.runtimeEvidence.length, 0);
  }
  const requests = await captureCapabilityRequest({
    ...wslInput, terminalSession: { ...wslInput.terminalSession, cliSessionId: "" },
  });
  assert.equal(requests.length, 0, "未绑定终端不能发起诊断");
});

test("切换发行版与 Worktree 时使用当前精确会话，不沿用上一 Tab 的身份", async () => {
  for (const distro of ["Ubuntu", "Debian"]) {
    const [call] = await captureCapabilityRequest({
      ...wslInput,
      terminalSession: { ...wslInput.terminalSession, id: "terminal-" + distro, cliSessionId: "session-" + distro },
      boundSession: {
        ...wslInput.boundSession, session_id: "session-" + distro,
        file_path: "\\\\wsl.localhost\\" + distro + "\\home\\dev\\.codex\\sessions\\current.jsonl",
      },
      projectPath: "E:\\Projects\\example-worktree",
    });
    assert.equal(call.request.wslDistroName, distro);
    assert.equal(call.request.cwd, "/mnt/e/Projects/example-worktree");
  }
});

test("当前 Hook 身份优先；本机与 SSH 请求不借用 WSL 历史身份", async () => {
  const [wslCall] = await captureCapabilityRequest({
    ...wslInput, terminalSession: { ...wslInput.terminalSession, wslDistroName: "Debian" },
  });
  assert.equal(wslCall.request.wslDistroName, "Debian");
  for (const environmentType of ["local", "ssh"]) {
    const [call] = await captureCapabilityRequest({
      ...wslInput,
      terminalSession: { ...wslInput.terminalSession, environmentType, shell: "powershell", remotePath: "/srv/project" },
    });
    assert.equal(call.request.environment, environmentType);
    assert.equal(call.request.wslDistroName, null);
    assert.equal(call.request.cwd, environmentType === "ssh" ? "/srv/project" : wslInput.projectPath);
    if (environmentType === "ssh") assert.equal(call.request.sshLaunch.hostId, "host");
  }
});
