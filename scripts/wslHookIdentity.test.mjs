import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 执行实际受管插件源码，隔离 process/fetch，避免触碰用户环境或发送网络请求。
function loadPlugin(source, distro) {
  const payloads = [];
  const exports = {};
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    exports,
    process: {
      env: {
        CLI_MANAGER_TAB_ID: "wsl-tab",
        CLI_MANAGER_NOTIFY_PORT: "12345",
        CLI_MANAGER_NOTIFY_TOKEN: "fixture-only",
        ...(distro === undefined ? {} : { WSL_DISTRO_NAME: distro }),
      },
      cwd: () => "/mnt/f/project/worktree",
    },
    fetch: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return { ok: true };
    },
    AbortController, AbortSignal, setTimeout, clearTimeout,
  });
  return { exports, payloads };
}

// 展开 Rust format! 的受管 Pi 模板；全部生命周期模块启用，类型导入由 TS 擦除。
function piSource() {
  const rust = readFileSync(new URL("../src-tauri/src/features/hooks/settings/pi.rs", import.meta.url), "utf8");
  const template = rust.match(/r#"(\/\/ \{marker\}[\s\S]*?)"#,/);
  assert.ok(template, "Pi managed template must remain discoverable");
  return template[1]
    .replaceAll("{marker}", "__CLI_MANAGER_PI_TEST__")
    .replace(/\{(?:session_start|running|stop)\}/g, "true")
    .replaceAll("{{", "{").replaceAll("}}", "}");
}

const opencodeSource = readFileSync(new URL("../src-tauri/resources/opencode/cli-manager-hook.js", import.meta.url), "utf8");

for (const [label, distro, expected] of [
  ["Ubuntu", "Ubuntu", "Ubuntu"],
  ["other distro", "  Debian  ", "Debian"],
  ["native local", undefined, null],
  ["empty identity", "  ", null],
]) {
  test(`Pi lifecycle reports the guest identity: ${label}`, async () => {
    const { exports, payloads } = loadPlugin(piSource(), distro);
    const handlers = new Map();
    exports.default({ on: (event, callback) => handlers.set(event, callback) });
    for (const event of ["session_start", "agent_start", "agent_settled"]) {
      handlers.get(event)({}, { sessionManager: { getSessionId: () => "pi-session" } });
    }
    await Promise.resolve();
    assert.deepEqual(payloads.map((p) => p.event), ["SessionStart", "UserPromptSubmit", "Stop"]);
    for (const payload of payloads) {
      assert.equal(payload.wslDistroName, expected);
      assert.equal(payload.tabId, "wsl-tab");
      assert.equal(payload.sessionId, "pi-session");
      assert.equal(payload.cwd, "/mnt/f/project/worktree");
    }
  });

  test(`OpenCode lifecycle reports the guest identity: ${label}`, async () => {
    const { exports, payloads } = loadPlugin(opencodeSource, distro);
    const bridge = await exports.CliManagerSessionBridge();
    await bridge.event({ type: "session.created", properties: { sessionID: "ses_wsl" } });
    await bridge.event({ type: "session.status", properties: { sessionID: "ses_wsl", status: { type: "busy" } } });
    await bridge.event({ type: "session.idle", properties: { sessionID: "ses_wsl" } });
    assert.deepEqual(payloads.map((p) => p.event), ["SessionStart", "UserPromptSubmit", "Stop"]);
    for (const payload of payloads) {
      assert.equal(payload.wslDistroName, expected);
      assert.equal(payload.tabId, "wsl-tab");
      assert.equal(payload.sessionId, "ses_wsl");
      assert.equal(payload.cwd, "/mnt/f/project/worktree");
    }
  });
}
