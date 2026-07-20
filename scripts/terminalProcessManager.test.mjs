import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-process-manager-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

writeFileSync(join(tempDir, "tauriCore.mjs"), "export async function invoke() { throw new Error('unused invoke'); }\n");
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

const source = readFileSync(new URL("../src/terminal/core/TerminalProcessManager.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalProcessManager.ts",
}).outputText
  .replace('from "@tauri-apps/api/core"', 'from "./tauriCore.mjs"')
  .replace('from "../capabilities/TerminalCapabilityStore"', 'from "./capabilities.mjs"')
  .replace('from "../transport/PtyHostSocket"', 'from "./ptyHostSocket.mjs"');
const managerPath = join(tempDir, "TerminalProcessManager.mjs");
writeFileSync(managerPath, transpiled, "utf8");

const { TerminalProcessManager } = await import(pathToFileURL(managerPath).href);
const socketStub = await import(pathToFileURL(join(tempDir, "ptyHostSocket.mjs")).href);

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

test("uncommitted output is redelivered after display remount and ACKed once", async () => {
  const manager = new TerminalProcessManager();
  const firstDeliveries = [];
  const disposeFirst = await manager.subscribeOutput("session-1", (delivery) => firstDeliveries.push(delivery));
  socketStub.emitOutput("session-1", frame(1, "hello"));
  assert.equal(firstDeliveries.length, 1);

  disposeFirst();
  const secondDeliveries = [];
  await manager.subscribeOutput("session-1", (delivery) => secondDeliveries.push(delivery));
  assert.equal(secondDeliveries.length, 1);
  secondDeliveries[0].commit(5);

  assert.deepEqual(socketStub.acknowledgments, [
    { sessionId: "session-1", sequence: 1, charCount: 5 },
  ]);
  socketStub.emitOutput("session-1", frame(1, "hello"));
  assert.equal(secondDeliveries.length, 1);
});

test("out-of-order write callbacks drain and ACK frames in sequence order", async () => {
  socketStub.acknowledgments.length = 0;
  const manager = new TerminalProcessManager();
  const deliveries = [];
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
