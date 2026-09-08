import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-pty-host-socket-"));
// 进程退出时清理临时转译目录。
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
globalThis.window = globalThis;

writeFileSync(join(tempDir, "tauriCore.mjs"), `
export async function invoke() {
  return {
    transportMode: "websocket",
    url: "ws://127.0.0.1:1/pty",
    token: "token",
    protocolVersion: 2,
    binaryProtocolVersion: 1,
    features: ["ws_binary_output_v1", "ws_binary_input_v1", "checkpoint_replay_v1", "terminal_colors_v1"],
    daemonVersion: "test",
  };
}
`);
writeFileSync(join(tempDir, "tauriEvent.mjs"), `
export async function listen() { return () => {}; }
`);
writeFileSync(join(tempDir, "logger.mjs"), `
export const infoLogs = [];
export const warnLogs = [];
export function logInfo(message, data) { infoLogs.push({ message, data }); }
export function logWarn(message, data) { warnLogs.push({ message, data }); }
`);
writeFileSync(join(tempDir, "resourceDiagnosticsLog.mjs"), `
export const entries = [];
export function writeResourceDiagnostic(level, source, event, payload) {
  entries.push({ level, source, event, payload });
}
`);

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static mode = "normal";
  static attachRequests = 0;
  static createRequests = 0;
  static connectionCount = 0;
  static sentFrames = [];

  // 创建模拟连接并安排异步打开事件。
  constructor() {
    FakeWebSocket.connectionCount += 1;
    this.readyState = FakeWebSocket.CONNECTING;
    // 在微任务中打开模拟连接并通知监听器。
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  // 记录客户端控制帧并按测试模式模拟服务端应答或超时。
  send(raw) {
    const frame = JSON.parse(raw);
    FakeWebSocket.sentFrames.push(frame);
    if (frame.type === "auth") {
      if (FakeWebSocket.mode !== "auth-timeout") {
        // 异步发送认证成功应答。
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) }));
      }
      return;
    }
    if (frame.type === "attach") {
      FakeWebSocket.attachRequests += 1;
      // 异步返回附加成功及会话元数据。
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({
          type: "attached",
          id: frame.id,
          latest_sequence: 0,
          meta: { alive: true },
        }),
      }));
      return;
    }
    if (frame.type === "create") {
      FakeWebSocket.createRequests += 1;
      if (FakeWebSocket.mode !== "create-timeout") {
        // 异步确认创建请求。
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) }));
      }
      return;
    }
    if (frame.type === "set_terminal_colors") {
      // 异步确认终端颜色更新。
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) }));
      return;
    }
    if (frame.type === "close" && FakeWebSocket.mode !== "close-timeout") {
      // 异步确认单会话关闭。
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) }));
      return;
    }
    if (frame.type === "close_all" && FakeWebSocket.mode !== "close-all-timeout") {
      // 异步确认全部会话关闭。
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) }));
      return;
    }
    if (frame.type === "ping" && FakeWebSocket.mode !== "no-pong") {
      // 异步回应心跳请求。
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "pong", id: frame.id }) }));
    }
  }

  // 幂等关闭模拟连接并安排关闭事件。
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    // 在微任务中通知模拟连接正常关闭。
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "", wasClean: true }));
  }
}

globalThis.WebSocket = FakeWebSocket;

const source = readFileSync(new URL("../src/features/terminal/transport/PtyHostSocket.ts", import.meta.url), "utf8")
  .replace("const AUTH_TIMEOUT_MS = 10_000;", "const AUTH_TIMEOUT_MS = 15;")
  .replace("const REQUEST_TIMEOUT_MS = 15_000;", "const REQUEST_TIMEOUT_MS = 15;")
  .replace("const HEARTBEAT_INTERVAL_MS = 5_000;", "const HEARTBEAT_INTERVAL_MS = 10;")
  .replace("const HEARTBEAT_TIMEOUT_MS = 15_000;", "const HEARTBEAT_TIMEOUT_MS = 30;");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "PtyHostSocket.ts",
}).outputText
  .replace('from "@tauri-apps/api/core"', 'from "./tauriCore.mjs"')
  .replace('from "@tauri-apps/api/event"', 'from "./tauriEvent.mjs"')
  .replace('from "../../../shared/platform/logger"', 'from "./logger.mjs"')
  .replace('from "../../../shared/platform/resourceDiagnosticsLog"', 'from "./resourceDiagnosticsLog.mjs"');
const socketPath = join(tempDir, "PtyHostSocket.mjs");
writeFileSync(socketPath, transpiled, "utf8");
const { PtyHostSocket } = await import(pathToFileURL(socketPath).href);
const resourceLogStub = await import(pathToFileURL(join(tempDir, "resourceDiagnosticsLog.mjs")).href);

// 验证认证等待具有明确超时边界。
test("authentication has a bounded timeout", { concurrency: false }, async () => {
  FakeWebSocket.mode = "auth-timeout";
  const socket = new PtyHostSocket();
  await assert.rejects(socket.connect(), /authentication timed out/);
  FakeWebSocket.mode = "normal";
});

// 验证守护进程重启后先重置旧传输再重新连接。
test("daemon restart resets the stale transport before reconnecting", { concurrency: false }, async () => {
  FakeWebSocket.mode = "normal";
  const socket = new PtyHostSocket();
  await socket.connect();
  const connectionCount = FakeWebSocket.connectionCount;
  socket.resetAfterDaemonRestart();
  assert.equal(socket.diagnosticsSnapshot().socketReadyState, null);
  assert.equal(socket.diagnosticsSnapshot().attachedSessions, 0);
  await socket.connect();
  assert.equal(FakeWebSocket.connectionCount, connectionCount + 1);
  socket.socket?.close();
});

// 验证关闭超时仍标记会话已删除并阻止重新附加。
test("failed close tombstones the session and prevents reconnect attach", { concurrency: false }, async () => {
  FakeWebSocket.attachRequests = 0;
  const socket = new PtyHostSocket();
  const attached = await socket.attach("session-1");
  assert.equal(attached.attached, true);
  socket.queueReplay("session-1", [{
    kind: "replay",
    sessionId: "session-1",
    sequence: 1,
    cols: 80,
    rows: 24,
    data: new TextEncoder().encode("pending"),
  }]);
  assert.equal(socket.diagnosticsSnapshot().pendingOutputFrames, 1);
  FakeWebSocket.mode = "close-timeout";
  await assert.rejects(socket.close("session-1"), /request timed out: close/);
  assert.equal(socket.diagnosticsSnapshot().pendingOutputFrames, 0);
  FakeWebSocket.mode = "normal";
  // 等待超时后的重连窗口以检查未重新附加。
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(FakeWebSocket.attachRequests, 1);
  socket.socket?.close();
});

// 验证创建应答丢失后通过附加预留会话恢复。
test("lost create response recovers by attaching the reserved session", { concurrency: false }, async () => {
  FakeWebSocket.attachRequests = 0;
  FakeWebSocket.createRequests = 0;
  FakeWebSocket.sentFrames.length = 0;
  FakeWebSocket.mode = "create-timeout";
  const socket = new PtyHostSocket();
  await socket.create(
    "session-create",
    null,
    {},
    null,
    null,
    { foreground: "#D3D7CF", background: "#000000" },
  );
  assert.equal(FakeWebSocket.createRequests, 1);
  assert.equal(FakeWebSocket.attachRequests, 1);
  // 查找已发送的创建帧以校验终端颜色。
  const createFrame = FakeWebSocket.sentFrames.find((frame) => frame.type === "create");
  assert.deepEqual(createFrame.terminal_colors, {
    foreground: "#D3D7CF",
    background: "#000000",
  });
  FakeWebSocket.mode = "normal";
  await socket.close("session-create");
  socket.socket?.close();
});

// 验证全部关闭超时仍阻止所有会话重新附加。
test("failed closeAll tombstones every session and prevents reconnect attach", { concurrency: false }, async () => {
  FakeWebSocket.attachRequests = 0;
  const socket = new PtyHostSocket();
  await socket.attach("session-a");
  await socket.attach("session-b");
  FakeWebSocket.mode = "close-all-timeout";
  await assert.rejects(socket.closeAll(), /request timed out: close_all/);
  FakeWebSocket.mode = "normal";
  // 等待重连窗口以检查会话墓碑生效。
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(FakeWebSocket.attachRequests, 2);
  socket.socket?.close();
});

// 验证终端颜色更新使用已协商的控制帧。
test("terminal color updates use the negotiated control frame", { concurrency: false }, async () => {
  FakeWebSocket.mode = "normal";
  FakeWebSocket.sentFrames.length = 0;
  const socket = new PtyHostSocket();
  await socket.setTerminalColors("session-colors", {
    foreground: "#FFFFFF",
    background: "#101010",
  });
  // 筛选已发送的终端颜色控制帧。
  const frame = FakeWebSocket.sentFrames.find((candidate) => candidate.type === "set_terminal_colors");
  assert.ok(frame);
  assert.deepEqual(frame, {
    type: "set_terminal_colors",
    id: frame.id,
    session_id: "session-colors",
    terminal_colors: {
      foreground: "#FFFFFF",
      background: "#101010",
    },
  });
  socket.socket?.close();
});

// 验证排队回放仅最后一帧标记批次结束。
test("queued replay marks exactly one batch boundary", { concurrency: false }, () => {
  const socket = new PtyHostSocket();
  const received = [];
  // 收集输出帧供回放边界断言使用。
  socket.subscribeOutput("session-replay", (frame) => received.push(frame));
  socket.queueReplay("session-replay", [
    { kind: "replay", sessionId: "session-replay", sequence: 1, cols: 80, rows: 24, data: new Uint8Array() },
    { kind: "replay", sessionId: "session-replay", sequence: 2, cols: 120, rows: 30, data: new Uint8Array() },
  ]);
  // 提取每帧批次结束标记并验证顺序。
  assert.deepEqual(received.map((frame) => frame.replayBatchEnd), [false, true]);
});

// 验证诊断统计在监听器消费前保留积压输出。
test("diagnostics account for pending output until a listener consumes it", { concurrency: false }, () => {
  const socket = new PtyHostSocket();
  socket.queueReplay("session-diagnostics", [
    {
      kind: "replay",
      sessionId: "session-diagnostics",
      sequence: 1,
      cols: 80,
      rows: 24,
      data: new TextEncoder().encode("queued-output"),
    },
  ]);

  const queued = socket.diagnosticsSnapshot();
  assert.equal(queued.pendingOutputSessions, 1);
  assert.equal(queued.pendingOutputFrames, 1);
  assert.equal(queued.pendingOutputBytes, "queued-output".length);
  assert.deepEqual(queued.topPendingOutput, [{
    sessionId: "session-diagnostics",
    queuedFrames: 1,
    queuedBytes: "queued-output".length,
  }]);

  // 注册空消费监听器以排空诊断会话的输出。
  socket.subscribeOutput("session-diagnostics", () => {});
  const consumed = socket.diagnosticsSnapshot();
  assert.equal(consumed.pendingOutputSessions, 0);
  assert.equal(consumed.pendingOutputFrames, 0);
  assert.equal(consumed.pendingOutputBytes, 0);
});

// 验证积压告警去重且清空后可再次触发。
test("pending output warning is deduplicated and resets after clearing", { concurrency: false }, () => {
  resourceLogStub.entries.length = 0;
  const socket = new PtyHostSocket();
  const thresholdPayload = new Uint8Array(4 * 1024 * 1024);

  socket.queueReplay("session-warning", [{
    kind: "replay",
    sessionId: "session-warning",
    sequence: 1,
    cols: 80,
    rows: 24,
    data: thresholdPayload,
  }]);
  socket.queueReplay("session-warning", [{
    kind: "replay",
    sessionId: "session-warning",
    sequence: 2,
    cols: 80,
    rows: 24,
    data: new Uint8Array([1]),
  }]);
  // 统计警告日志以验证首次积压仅告警一次。
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "warn").length, 1);

  // 注册空消费监听器以清空积压并取得注销函数。
  const unsubscribe = socket.subscribeOutput("session-warning", () => {});
  unsubscribe();
  // 统计信息日志以验证清空事件只记录一次。
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "info").length, 1);
  assert.equal(resourceLogStub.entries[1].event, "backlogCleared");

  socket.queueReplay("session-warning", [{
    kind: "replay",
    sessionId: "session-warning",
    sequence: 3,
    cols: 80,
    rows: 24,
    data: thresholdPayload,
  }]);
  // 统计警告日志以验证再次积压可重新告警。
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "warn").length, 2);
});

// 验证关闭最后一个会话会取消等待中的重连。
test("closing the last session cancels a pending reconnect", { concurrency: false }, async () => {
  FakeWebSocket.mode = "normal";
  const socket = new PtyHostSocket();
  await socket.attach("session-reconnect-close");
  socket.socket?.close();
  // 让关闭事件的异步处理完成。
  await new Promise((resolve) => setTimeout(resolve, 0));
  await socket.close("session-reconnect-close");
  socket.socket?.close();
  const connectionCountAfterClose = FakeWebSocket.connectionCount;
  // 等待重连延迟以确认连接数未增加。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(FakeWebSocket.connectionCount, connectionCountAfterClose);
});

// 验证心跳缺少回应时断开连接并安排重新附加。
test("missing heartbeat pong forces disconnect and reconnect scheduling", { concurrency: false }, async () => {
  FakeWebSocket.attachRequests = 0;
  const socket = new PtyHostSocket();
  await socket.attach("session-heartbeat");
  FakeWebSocket.mode = "no-pong";
  // 等待心跳超时与重连处理。
  await new Promise((resolve) => setTimeout(resolve, 330));
  FakeWebSocket.mode = "normal";
  // 等待恢复正常模式后的附加完成。
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(FakeWebSocket.attachRequests >= 2);
  await socket.close("session-heartbeat");
  socket.socket?.close();
});
