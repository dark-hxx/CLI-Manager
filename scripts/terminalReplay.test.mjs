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

function flushNextAnimationFrame() {
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}

function flushAnimationFrames() {
  while (rafCallbacks.size > 0) flushNextAnimationFrame();
}

writeFileSync(join(tempDir, "react.mjs"), "export const useRef = (value) => ({ current: value });\n");
writeFileSync(join(tempDir, "webgl.mjs"), `
export class WebglAddon {
  onContextLoss() {}
  dispose() {}
  clearTextureAtlas() {}
}
`);
writeFileSync(join(tempDir, "visibility.mjs"), `
export const refreshCalls = [];
export function refreshTerminalViewport(terminal) {
  refreshCalls.push([0, terminal.rows - 1]);
}
export function resetVisibility() {
  refreshCalls.length = 0;
}
`);
writeFileSync(join(tempDir, "themes.mjs"), "export function isLightTerminalTheme() { return false; }\n");
writeFileSync(join(tempDir, "logger.mjs"), "export function logError() {} export function logWarn() {}\n");
writeFileSync(join(tempDir, "snapshot.mjs"), "export function markTerminalSnapshotDirty() {}\n");
writeFileSync(join(tempDir, "resize.mjs"), `
export function shouldDebounceTerminalResize() { return false; }
export const cancelCalls = [];
export class TerminalResizeDebouncer {
  constructor(_visible, _terminal, resizeBoth) { this.resizeBoth = resizeBoth; }
  resize(cols, rows) { this.resizeBoth(cols, rows); }
  cancel() { cancelCalls.push(true); }
  dispose() {}
}
export function resetResizeStub() { cancelCalls.length = 0; }
`);
writeFileSync(join(tempDir, "resizeBarrier.mjs"), `
export class TerminalResizeRenderBarrier {
  begin() { return true; }
  noteContainerResize() {}
  handleWriteCommitted() {}
  cancel() {}
  dispose() {}
}
`);
writeFileSync(join(tempDir, "settings.mjs"), `
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const useSettingsStore = { getState: () => ({ fontSize: 14, update: async () => {} }) };
`);
writeFileSync(join(tempDir, "terminalStore.mjs"), `
export const useTerminalStore = {
  getState: () => ({ recordPtyOutputActivity() {} }),
};
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
  .replace('from "../terminal/browser/TerminalResizeRenderBarrier"', 'from "./resizeBarrier.mjs"')
  .replace('from "../terminal/core/TerminalProcessManager"', 'from "./manager.mjs"')
  .replace('from "../stores/settingsStore"', 'from "./settings.mjs"')
  .replace('from "../stores/terminalStore"', 'from "./terminalStore.mjs"');
const modulePath = join(tempDir, "useTerminalDisplay.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { useTerminalDisplay } = await import(pathToFileURL(modulePath).href);
const managerStub = await import(pathToFileURL(join(tempDir, "manager.mjs")).href);
const resizeStub = await import(pathToFileURL(join(tempDir, "resize.mjs")).href);
const visibilityStub = await import(pathToFileURL(join(tempDir, "visibility.mjs")).href);

class FakeTerminal {
  constructor(events) {
    this.events = events;
    this.cols = 80;
    this.rows = 24;
    this.buffer = {
      normal: { length: 0 },
      active: { type: "normal", baseY: 0, cursorY: 0, viewportY: 0 },
    };
    this.writeCallbacks = [];
    this.resizeListeners = new Set();
    this.markers = new Set();
    this.reflowBaseYDelta = 0;
    this.reflowMarkerLineDelta = 0;
    this.viewportMaxScrollLine = 0;
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
    const colsChanged = this.cols !== cols;
    this.cols = cols;
    this.rows = rows;
    if (colsChanged && this.reflowBaseYDelta > 0) {
      const wasAtBottom = this.buffer.active.viewportY === this.buffer.active.baseY;
      this.buffer.active.baseY += this.reflowBaseYDelta;
      if (wasAtBottom) {
        this.buffer.active.viewportY = this.buffer.active.baseY;
      }
      this.markers.forEach((marker) => {
        if (!marker.isDisposed) marker.line += this.reflowMarkerLineDelta;
      });
    }
    if (colsChanged) {
      const nextViewportMaxScrollLine = this.buffer.active.baseY;
      requestAnimationFrame(() => {
        this.viewportMaxScrollLine = nextViewportMaxScrollLine;
      });
    }
    this.events.push(`resize:${cols}x${rows}`);
    this.resizeListeners.forEach((listener) => listener({ cols, rows }));
  }

  registerMarker(cursorYOffset) {
    const marker = {
      line: this.buffer.active.baseY + this.buffer.active.cursorY + cursorYOffset,
      isDisposed: false,
      dispose: () => {
        marker.isDisposed = true;
        this.markers.delete(marker);
      },
    };
    this.markers.add(marker);
    return marker;
  }

  scrollToLine(line) {
    this.buffer.active.viewportY = Math.max(0, Math.min(line, this.viewportMaxScrollLine));
    this.events.push(`scroll:${this.buffer.active.viewportY}`);
  }

  onResize(listener) {
    this.resizeListeners.add(listener);
    return { dispose: () => this.resizeListeners.delete(listener) };
  }

  loadAddon() {}
}

function createDisplay(proposedDimensions = { cols: 120, rows: 30 }) {
  visibilityStub.resetVisibility();
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
    fitAddonRef: { current: { proposeDimensions: () => proposedDimensions } },
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

test("immediate fit does not force a viewport refresh when dimensions are unchanged", () => {
  const { display, terminal, detachViewport } = createDisplay();
  terminal.cols = 120;
  terminal.rows = 30;

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(visibilityStub.refreshCalls, []);
  detachViewport();
});

test("explicit viewport refresh repaints the full grid when dimensions are unchanged", () => {
  const { display, terminal, detachViewport } = createDisplay();
  terminal.cols = 120;
  terminal.rows = 30;

  display.scheduleFit(true, true);
  flushAnimationFrames();

  assert.deepEqual(visibilityStub.refreshCalls, [[0, 29]]);
  detachViewport();
});

test("consecutive fit frames keep the live horizontal resize cadence pending", () => {
  resizeStub.resetResizeStub();
  const { display, detachViewport } = createDisplay({ cols: 100, rows: 24 });

  display.scheduleFit();
  flushNextAnimationFrame();
  display.scheduleFit();

  assert.equal(resizeStub.cancelCalls.length, 0);
  display.cancelScheduledFit();
  assert.equal(resizeStub.cancelCalls.length, 1);
  detachViewport();
});

test("horizontal reflow preserves the visible normal-buffer line", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.normal.length = 300;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.cursorY = 23;
  terminal.buffer.active.viewportY = 177;
  terminal.viewportMaxScrollLine = 277;
  terminal.reflowBaseYDelta = 300;
  terminal.reflowMarkerLineDelta = 177;

  display.scheduleFit(true, false);

  flushNextAnimationFrame();
  assert.deepEqual(events, ["resize:60x24"]);
  assert.equal(terminal.markers.size, 1);

  flushNextAnimationFrame();
  assert.deepEqual(events, ["resize:60x24"]);
  assert.equal(terminal.markers.size, 1);

  flushNextAnimationFrame();

  assert.equal(terminal.buffer.active.viewportY, 354);
  assert.deepEqual(events, ["resize:60x24", "scroll:354"]);
  assert.equal(terminal.markers.size, 0);
  detachViewport();
});

test("horizontal reflow keeps live-bottom following without forcing a scroll", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.cursorY = 23;
  terminal.buffer.active.viewportY = 277;
  terminal.viewportMaxScrollLine = 277;
  terminal.reflowBaseYDelta = 300;
  terminal.reflowMarkerLineDelta = 177;

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.equal(terminal.buffer.active.viewportY, 577);
  assert.deepEqual(events, ["resize:60x24"]);
  assert.equal(terminal.markers.size, 0);
  detachViewport();
});

test("cancelling a scheduled fit disposes a pending viewport marker", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.normal.length = 300;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.cursorY = 23;
  terminal.buffer.active.viewportY = 177;
  terminal.viewportMaxScrollLine = 277;
  terminal.reflowBaseYDelta = 300;
  terminal.reflowMarkerLineDelta = 177;

  display.scheduleFit(true, false);
  flushNextAnimationFrame();
  assert.equal(terminal.markers.size, 1);

  display.cancelScheduledFit();
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:60x24"]);
  assert.equal(terminal.markers.size, 0);
  detachViewport();
});

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
