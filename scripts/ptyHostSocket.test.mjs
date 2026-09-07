import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-pty-host-socket-"));
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

  constructor() {
    FakeWebSocket.connectionCount += 1;
    this.readyState = FakeWebSocket.CONNECTING;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(raw) {
    const frame = JSON.parse(raw);
    FakeWebSocket.sentFrames.push(frame);
    if (frame.type === "auth") {
      if (FakeWebSocket.mode !== "auth-timeout") {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) }));
      }
      return;
    }
    if (frame.type === "attach") {
      FakeWebSocket.attachRequests += 1;
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
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) }));
      }
      return;
    }
    if (frame.type === "set_terminal_colors") {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) }));
      return;
    }
    if (frame.type === "close" && FakeWebSocket.mode !== "close-timeout") {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) }));
      return;
    }
    if (frame.type === "close_all" && FakeWebSocket.mode !== "close-all-timeout") {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) }));
      return;
    }
    if (frame.type === "ping" && FakeWebSocket.mode !== "no-pong") {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "pong", id: frame.id }) }));
    }
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "", wasClean: true }));
  }
}

globalThis.WebSocket = FakeWebSocket;

const source = readFileSync(new URL("../src/terminal/transport/PtyHostSocket.ts", import.meta.url), "utf8")
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
  .replace('from "../../lib/logger"', 'from "./logger.mjs"')
  .replace('from "../../lib/resourceDiagnosticsLog"', 'from "./resourceDiagnosticsLog.mjs"');
const socketPath = join(tempDir, "PtyHostSocket.mjs");
writeFileSync(socketPath, transpiled, "utf8");
const { PtyHostSocket } = await import(pathToFileURL(socketPath).href);
const resourceLogStub = await import(pathToFileURL(join(tempDir, "resourceDiagnosticsLog.mjs")).href);

test("authentication has a bounded timeout", { concurrency: false }, async () => {
  FakeWebSocket.mode = "auth-timeout";
  const socket = new PtyHostSocket();
  await assert.rejects(socket.connect(), /authentication timed out/);
  FakeWebSocket.mode = "normal";
});

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
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(FakeWebSocket.attachRequests, 1);
  socket.socket?.close();
});

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
  const createFrame = FakeWebSocket.sentFrames.find((frame) => frame.type === "create");
  assert.deepEqual(createFrame.terminal_colors, {
    foreground: "#D3D7CF",
    background: "#000000",
  });
  FakeWebSocket.mode = "normal";
  await socket.close("session-create");
  socket.socket?.close();
});

test("failed closeAll tombstones every session and prevents reconnect attach", { concurrency: false }, async () => {
  FakeWebSocket.attachRequests = 0;
  const socket = new PtyHostSocket();
  await socket.attach("session-a");
  await socket.attach("session-b");
  FakeWebSocket.mode = "close-all-timeout";
  await assert.rejects(socket.closeAll(), /request timed out: close_all/);
  FakeWebSocket.mode = "normal";
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(FakeWebSocket.attachRequests, 2);
  socket.socket?.close();
});

test("terminal color updates use the negotiated control frame", { concurrency: false }, async () => {
  FakeWebSocket.mode = "normal";
  FakeWebSocket.sentFrames.length = 0;
  const socket = new PtyHostSocket();
  await socket.setTerminalColors("session-colors", {
    foreground: "#FFFFFF",
    background: "#101010",
  });
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

test("queued replay marks exactly one batch boundary", { concurrency: false }, () => {
  const socket = new PtyHostSocket();
  const received = [];
  socket.subscribeOutput("session-replay", (frame) => received.push(frame));
  socket.queueReplay("session-replay", [
    { kind: "replay", sessionId: "session-replay", sequence: 1, cols: 80, rows: 24, data: new Uint8Array() },
    { kind: "replay", sessionId: "session-replay", sequence: 2, cols: 120, rows: 30, data: new Uint8Array() },
  ]);
  assert.deepEqual(received.map((frame) => frame.replayBatchEnd), [false, true]);
});

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

  socket.subscribeOutput("session-diagnostics", () => {});
  const consumed = socket.diagnosticsSnapshot();
  assert.equal(consumed.pendingOutputSessions, 0);
  assert.equal(consumed.pendingOutputFrames, 0);
  assert.equal(consumed.pendingOutputBytes, 0);
});

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
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "warn").length, 1);

  const unsubscribe = socket.subscribeOutput("session-warning", () => {});
  unsubscribe();
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
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "warn").length, 2);
});

test("closing the last session cancels a pending reconnect", { concurrency: false }, async () => {
  FakeWebSocket.mode = "normal";
  const socket = new PtyHostSocket();
  await socket.attach("session-reconnect-close");
  socket.socket?.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await socket.close("session-reconnect-close");
  socket.socket?.close();
  const connectionCountAfterClose = FakeWebSocket.connectionCount;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(FakeWebSocket.connectionCount, connectionCountAfterClose);
});

test("missing heartbeat pong forces disconnect and reconnect scheduling", { concurrency: false }, async () => {
  FakeWebSocket.attachRequests = 0;
  const socket = new PtyHostSocket();
  await socket.attach("session-heartbeat");
  FakeWebSocket.mode = "no-pong";
  await new Promise((resolve) => setTimeout(resolve, 330));
  FakeWebSocket.mode = "normal";
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(FakeWebSocket.attachRequests >= 2);
  await socket.close("session-heartbeat");
  socket.socket?.close();
});
