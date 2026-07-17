import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-replay-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

globalThis.window = globalThis;
let nextRafId = 1;
const rafCallbacks = new Map();
globalThis.requestAnimationFrame = (callback) => {
  const id = nextRafId++;
  rafCallbacks.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

function flushAnimationFrames() {
  while (rafCallbacks.size > 0) {
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  }
}

writeFileSync(join(tempDir, "react.mjs"), "export const useRef = (value) => ({ current: value });\n");
writeFileSync(join(tempDir, "webgl.mjs"), `
export class WebglAddon {
  onContextLoss() {}
  dispose() {}
  clearTextureAtlas() {}
}
`);
writeFileSync(join(tempDir, "visibility.mjs"), "export function refreshTerminalViewport() {}\n");
writeFileSync(join(tempDir, "themes.mjs"), "export function isLightTerminalTheme() { return false; }\n");
writeFileSync(join(tempDir, "logger.mjs"), "export function logError() {} export function logWarn() {}\n");
writeFileSync(join(tempDir, "snapshot.mjs"), "export function markTerminalSnapshotDirty() {}\n");
writeFileSync(join(tempDir, "resize.mjs"), `
export class TerminalResizeDebouncer {
  constructor(_visible, _terminal, resizeBoth) { this.resizeBoth = resizeBoth; }
  resize(cols, rows) { this.resizeBoth(cols, rows); }
  cancel() {}
  dispose() {}
}
`);
writeFileSync(join(tempDir, "settings.mjs"), `
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const useSettingsStore = { getState: () => ({ fontSize: 14, update: async () => {} }) };
`);
writeFileSync(join(tempDir, "manager.mjs"), `
let outputListener = null;
export const resizeCalls = [];
export const replayAcknowledgments = [];
export const terminalProcessManager = {
  async subscribeOutput(_sessionId, listener) {
    outputListener = listener;
    return () => { if (outputListener === listener) outputListener = null; };
  },
  async resize(sessionId, cols, rows) { resizeCalls.push({ sessionId, cols, rows }); },
  acknowledgeOutput(sessionId, sequence, charCount) {
    replayAcknowledgments.push({ sessionId, sequence, charCount });
  },
};
export function emitOutput(delivery) { outputListener?.(delivery); }
export function resetManager() {
  outputListener = null;
  resizeCalls.length = 0;
  replayAcknowledgments.length = 0;
}
`);

const source = readFileSync(new URL("../src/hooks/useTerminalDisplay.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "useTerminalDisplay.ts",
}).outputText
  .replace('from "react"', 'from "./react.mjs"')
  .replace('from "@xterm/addon-webgl"', 'from "./webgl.mjs"')
  .replace('from "../lib/terminalVisibility"', 'from "./visibility.mjs"')
  .replace('from "../lib/terminalThemes"', 'from "./themes.mjs"')
  .replace('from "../lib/logger"', 'from "./logger.mjs"')
  .replace('from "../lib/sessionSnapshotPersistence"', 'from "./snapshot.mjs"')
  .replace('from "../terminal/browser/TerminalResizeDebouncer"', 'from "./resize.mjs"')
  .replace('from "../terminal/core/TerminalProcessManager"', 'from "./manager.mjs"')
  .replace('from "../stores/settingsStore"', 'from "./settings.mjs"');
const modulePath = join(tempDir, "useTerminalDisplay.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { useTerminalDisplay } = await import(pathToFileURL(modulePath).href);
const managerStub = await import(pathToFileURL(join(tempDir, "manager.mjs")).href);

class FakeTerminal {
  constructor(events) {
    this.events = events;
    this.cols = 80;
    this.rows = 24;
    this.buffer = { normal: { length: 0 } };
    this.writeCallbacks = [];
    this.resizeListeners = new Set();
  }

  write(text, callback) {
    this.events.push(`write:${text}`);
    this.writeCallbacks.push(callback);
  }

  finishNextWrite() {
    const callback = this.writeCallbacks.shift();
    assert.ok(callback, "expected a pending xterm write callback");
    callback();
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.events.push(`resize:${cols}x${rows}`);
    this.resizeListeners.forEach((listener) => listener({ cols, rows }));
  }

  onResize(listener) {
    this.resizeListeners.add(listener);
    return { dispose: () => this.resizeListeners.delete(listener) };
  }

  loadAddon() {}
}

function createDisplay() {
  const events = [];
  const terminal = new FakeTerminal(events);
  const container = {
    offsetWidth: 1200,
    offsetHeight: 600,
    addEventListener() {},
    removeEventListener() {},
  };
  const terminalRef = { current: terminal };
  const display = useTerminalDisplay({
    sessionId: "session-1",
    containerRef: { current: container },
    terminalRef,
    fitAddonRef: { current: { proposeDimensions: () => ({ cols: 120, rows: 30 }) } },
    isVisibleRef: { current: true },
    isComposingRef: { current: false },
    lowMemoryMode: false,
    disableHardwareAcceleration: true,
    linuxGraphicsDisableWebgl: true,
    isTransparentRef: { current: false },
    normalizeOutputRef: { current: (text) => text },
    transformOutputRef: { current: (text) => text },
    afterTerminalWriteRef: { current: null },
    onPtyOutputListenError: (error) => { throw error; },
  });
  const detachViewport = display.attachViewport(terminal);
  return { display, terminal, terminalRef, events, detachViewport };
}

function frame(sequence, text, cols, rows, replayBatchEnd = false) {
  return {
    kind: sequence < 3 ? "replay" : "output",
    sessionId: "session-1",
    sequence,
    cols,
    rows,
    data: new TextEncoder().encode(text),
    replayBatchEnd,
  };
}

function delivery(frameValue, commits) {
  return {
    frame: frameValue,
    commit: (charCount) => commits.push({ sequence: frameValue.sequence, charCount }),
  };
}

test("initial replay fits the current container before releasing buffered live output", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput({ waitForReplay: true });
  await output.ready;
  managerStub.emitOutput(delivery(frame(3, "live", 100, 25), commits));

  const replayPromise = output.completeReplay([
    frame(1, "replay", 90, 20, true),
  ]);
  await Promise.resolve();
  assert.deepEqual(events, ["resize:90x20", "write:replay"]);

  terminal.finishNextWrite();
  assert.equal(await replayPromise, true);
  assert.deepEqual(events, ["resize:90x20", "write:replay", "resize:120x30"]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 120, rows: 30 }]);

  flushAnimationFrames();
  assert.deepEqual(events, ["resize:90x20", "write:replay", "resize:120x30", "write:live"]);
  terminal.finishNextWrite();
  assert.deepEqual(commits, [{ sequence: 3, charCount: 4 }]);
  output.dispose();
  detachViewport();
});

test("reconnect replay restores historical sizes serially and fits before live output", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;

  managerStub.emitOutput(delivery(frame(1, "one", 90, 20), commits));
  managerStub.emitOutput(delivery(frame(2, "two", 100, 25, true), commits));
  managerStub.emitOutput(delivery(frame(3, "live", 100, 25), commits));

  flushAnimationFrames();
  assert.deepEqual(events, ["resize:90x20", "write:one"]);
  terminal.finishNextWrite();
  flushAnimationFrames();
  assert.deepEqual(events, ["resize:90x20", "write:one", "resize:100x25", "write:two"]);
  terminal.finishNextWrite();
  assert.deepEqual(events, [
    "resize:90x20",
    "write:one",
    "resize:100x25",
    "write:two",
    "resize:120x30",
  ]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 120, rows: 30 }]);

  flushAnimationFrames();
  assert.deepEqual(events.at(-1), "write:live");
  terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 1, charCount: 3 },
    { sequence: 2, charCount: 3 },
    { sequence: 3, charCount: 4 },
  ]);
  output.dispose();
  detachViewport();
});

test("resize-only reconnect replay is applied locally before current-size fit", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;

  managerStub.emitOutput(delivery(frame(2, "", 100, 25, true), commits));
  managerStub.emitOutput(delivery(frame(3, "live", 100, 25), commits));
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:100x25", "resize:120x30", "write:live"]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 120, rows: 30 }]);
  assert.deepEqual(commits, [{ sequence: 2, charCount: 0 }]);
  terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 2, charCount: 0 },
    { sequence: 3, charCount: 4 },
  ]);
  output.dispose();
  detachViewport();
});
