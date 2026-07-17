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
  return { url: "ws://127.0.0.1:1/pty", token: "token", protocolVersion: 1, daemonVersion: "test" };
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
    queueMicrotask(() => this.onclose?.());
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
  .replace('from "@tauri-apps/api/core"', 'from "./tauriCore.mjs"');
const socketPath = join(tempDir, "PtyHostSocket.mjs");
writeFileSync(socketPath, transpiled, "utf8");
const { PtyHostSocket } = await import(pathToFileURL(socketPath).href);

test("authentication has a bounded timeout", { concurrency: false }, async () => {
  FakeWebSocket.mode = "auth-timeout";
  const socket = new PtyHostSocket();
  await assert.rejects(socket.connect(), /authentication timed out/);
  FakeWebSocket.mode = "normal";
});

test("failed close tombstones the session and prevents reconnect attach", { concurrency: false }, async () => {
  FakeWebSocket.attachRequests = 0;
  const socket = new PtyHostSocket();
  const attached = await socket.attach("session-1");
  assert.equal(attached.attached, true);
  FakeWebSocket.mode = "close-timeout";
  await assert.rejects(socket.close("session-1"), /request timed out: close/);
  FakeWebSocket.mode = "normal";
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(FakeWebSocket.attachRequests, 1);
});

test("lost create response recovers by attaching the reserved session", { concurrency: false }, async () => {
  FakeWebSocket.attachRequests = 0;
  FakeWebSocket.createRequests = 0;
  FakeWebSocket.mode = "create-timeout";
  const socket = new PtyHostSocket();
  await socket.create("session-create", null, {}, null);
  assert.equal(FakeWebSocket.createRequests, 1);
  assert.equal(FakeWebSocket.attachRequests, 1);
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
