import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-process-manager-"));
// 退出时清理进程管理器测试的临时转译目录。
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

writeFileSync(join(tempDir, "tauriCore.mjs"), "export async function invoke() { throw new Error('unused invoke'); }\n");
writeFileSync(join(tempDir, "resourceDiagnosticsLog.mjs"), `
export const entries = [];
export function writeResourceDiagnostic(level, source, event, payload) {
  entries.push({ level, source, event, payload });
}
`);
writeFileSync(join(tempDir, "capabilities.mjs"), `
export class TerminalCapabilityStore {
  clear() {}
}
`);
writeFileSync(join(tempDir, "ptyHostSocket.mjs"), `
const listeners = new Map();
export const acknowledgments = [];
export const terminalColorUpdates = [];
export const ptyHostSocket = {
  async connect() {},
  subscribeOutput(sessionId, listener) {
    listeners.set(sessionId, listener);
    return () => listeners.delete(sessionId);
  },
  subscribeStatus() { return () => {}; },
  acknowledge(sessionId, sequence, charCount) {
    acknowledgments.push({ sessionId, sequence, charCount });
  },
  async close() {},
  async closeAll() {},
  async write() {},
  async resize() {},
  async setTerminalColors(sessionId, colors) { terminalColorUpdates.push({ sessionId, colors }); },
  async attach() { return { attached: false, alive: false, replay: [] }; },
  async create() {},
};
export function emitOutput(sessionId, frame) {
  listeners.get(sessionId)?.(frame);
}
`);

const source = readFileSync(new URL("../src/features/terminal/api/TerminalProcessManager.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalProcessManager.ts",
}).outputText
  .replace('from "@tauri-apps/api/core"', 'from "./tauriCore.mjs"')
  .replace('from "../../../shared/platform/resourceDiagnosticsLog"', 'from "./resourceDiagnosticsLog.mjs"')
  .replace('from "../capabilities/TerminalCapabilityStore"', 'from "./capabilities.mjs"')
  .replace('from "../transport/PtyHostSocket"', 'from "./ptyHostSocket.mjs"');
const managerPath = join(tempDir, "TerminalProcessManager.mjs");
writeFileSync(managerPath, transpiled, "utf8");

const { TerminalProcessManager } = await import(pathToFileURL(managerPath).href);
const socketStub = await import(pathToFileURL(join(tempDir, "ptyHostSocket.mjs")).href);
const resourceLogStub = await import(pathToFileURL(join(tempDir, "resourceDiagnosticsLog.mjs")).href);

// 构造具有指定序号和 UTF-8 内容的 PTY 输出帧。
function frame(sequence, text) {
  return {
    kind: "output",
    sessionId: "session-1",
    sequence,
    cols: 80,
    rows: 24,
    data: new TextEncoder().encode(text),
  };
}

// 验证未提交输出在重新挂载后重投递且仅确认一次。
test("uncommitted output is redelivered after display remount and ACKed once", async () => {
  const manager = new TerminalProcessManager();
  const firstDeliveries = [];
  // 收集首次挂载收到的输出交付。
  const disposeFirst = await manager.subscribeOutput("session-1", (delivery) => firstDeliveries.push(delivery));
  socketStub.emitOutput("session-1", frame(1, "hello"));
  assert.equal(firstDeliveries.length, 1);

  disposeFirst();
  const secondDeliveries = [];
  // 收集重新挂载收到的输出交付。
  await manager.subscribeOutput("session-1", (delivery) => secondDeliveries.push(delivery));
  assert.equal(secondDeliveries.length, 1);
  secondDeliveries[0].commit(5);

  assert.deepEqual(socketStub.acknowledgments, [
    { sessionId: "session-1", sequence: 1, charCount: 5 },
  ]);
  socketStub.emitOutput("session-1", frame(1, "hello"));
  assert.equal(secondDeliveries.length, 1);
});

// 验证已提交输出不会在重新挂载后再次投递。
test("committed output is not redelivered after display remount", async () => {
  const manager = new TerminalProcessManager();
  const firstDeliveries = [];
  // 收集首次挂载交付以提交该帧。
  const disposeFirst = await manager.subscribeOutput("session-committed", (delivery) => firstDeliveries.push(delivery));
  socketStub.emitOutput("session-committed", {
    ...frame(1, "committed"),
    sessionId: "session-committed",
  });
  firstDeliveries[0].commit("committed".length);
  disposeFirst();

  const secondDeliveries = [];
  // 收集重新挂载交付以确认没有重复输出。
  await manager.subscribeOutput("session-committed", (delivery) => secondDeliveries.push(delivery));
  assert.equal(secondDeliveries.length, 0);
});

// 验证乱序写入完成仍按帧序号发送确认。
test("out-of-order write callbacks drain and ACK frames in sequence order", async () => {
  socketStub.acknowledgments.length = 0;
  const manager = new TerminalProcessManager();
  const deliveries = [];
  // 收集帧交付以模拟乱序提交。
  await manager.subscribeOutput("session-1", (delivery) => deliveries.push(delivery));
  socketStub.emitOutput("session-1", frame(2, "two"));
  socketStub.emitOutput("session-1", frame(3, "three"));

  deliveries[1].commit(5);
  assert.deepEqual(socketStub.acknowledgments, []);
  deliveries[0].commit(3);
  assert.deepEqual(socketStub.acknowledgments, [
    { sessionId: "session-1", sequence: 2, charCount: 3 },
    { sessionId: "session-1", sequence: 3, charCount: 5 },
  ]);
});

// 验证诊断跟踪排队字节并在提交后清空。
test("diagnostics track queued bytes and clear them after commit", async () => {
  const manager = new TerminalProcessManager();
  const deliveries = [];
  // 收集诊断会话的交付以模拟消费完成。
  const dispose = await manager.subscribeOutput("session-diagnostics", (delivery) => deliveries.push(delivery));
  socketStub.emitOutput("session-diagnostics", {
    ...frame(10, "diagnostic-output"),
    sessionId: "session-diagnostics",
  });

  assert.deepEqual(manager.diagnosticsSnapshot(), {
    trackedSessions: 1,
    sessionsWithConsumers: 1,
    queuedFrames: 1,
    queuedBytes: "diagnostic-output".length,
    committedFrames: 0,
    topBacklogs: [{
      sessionId: "session-diagnostics",
      consumerAttached: true,
      queuedFrames: 1,
      queuedBytes: "diagnostic-output".length,
      committedFrames: 0,
      deliveredFrames: 1,
    }],
  });

  deliveries[0].commit("diagnostic-output".length);
  assert.equal(manager.diagnosticsSnapshot().queuedBytes, 0);
  assert.equal(manager.diagnosticsSnapshot().queuedFrames, 0);
  dispose();
  assert.equal(manager.diagnosticsSnapshot().sessionsWithConsumers, 0);
  await manager.close("session-diagnostics");
  assert.equal(manager.diagnosticsSnapshot().trackedSessions, 0);
});

// 验证重置帧替换原有积压诊断。
test("reset replaces prior diagnostics backlog", async () => {
  const manager = new TerminalProcessManager();
  // 注册空监听器以建立重置测试的消费者。
  await manager.subscribeOutput("session-reset", () => {});
  socketStub.emitOutput("session-reset", {
    ...frame(1, "stale-output"),
    sessionId: "session-reset",
  });
  socketStub.emitOutput("session-reset", {
    kind: "reset",
    sessionId: "session-reset",
    sequence: 0,
    cols: 80,
    rows: 24,
    data: new Uint8Array(),
  });

  const snapshot = manager.diagnosticsSnapshot();
  assert.equal(snapshot.queuedFrames, 1);
  assert.equal(snapshot.queuedBytes, 0);
});

// 验证积压告警去重且恢复后可再次告警。
test("backlog warning is deduplicated and can fire again after recovery", async () => {
  resourceLogStub.entries.length = 0;
  const manager = new TerminalProcessManager();
  const deliveries = [];
  // 收集积压交付以控制恢复时机。
  await manager.subscribeOutput("session-warning", (delivery) => deliveries.push(delivery));
  const thresholdPayload = new Uint8Array(4 * 1024 * 1024);

  socketStub.emitOutput("session-warning", {
    ...frame(1, ""),
    sessionId: "session-warning",
    data: thresholdPayload,
  });
  socketStub.emitOutput("session-warning", {
    ...frame(2, "x"),
    sessionId: "session-warning",
  });
  // 统计警告日志验证重复积压没有重复告警。
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "warn").length, 1);

  deliveries[0].commit(0);
  // 统计信息日志验证恢复事件已记录。
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "info").length, 1);
  assert.equal(resourceLogStub.entries[1].event, "backlogRecovered");

  socketStub.emitOutput("session-warning", {
    ...frame(3, ""),
    sessionId: "session-warning",
    data: thresholdPayload,
  });
  // 统计警告日志验证恢复后可再次触发。
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "warn").length, 2);
});

// 验证终端颜色更新经进程管理器转交传输层。
test("terminal color updates stay behind the process manager boundary", async () => {
  socketStub.terminalColorUpdates.length = 0;
  const manager = new TerminalProcessManager();
  await manager.setTerminalColors("session-colors", {
    foreground: "#FFFFFF",
    background: "#101010",
  });
  assert.deepEqual(socketStub.terminalColorUpdates, [{
    sessionId: "session-colors",
    colors: { foreground: "#FFFFFF", background: "#101010" },
  }]);
});
