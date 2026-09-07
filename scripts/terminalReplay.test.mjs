import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-replay-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

let nextTimerId = 1;
const timerCallbacks = new Map();
const visibilityListeners = new Set();
let documentVisibilityState = "visible";
globalThis.window = {
  setTimeout: (callback) => {
    const id = nextTimerId++;
    timerCallbacks.set(id, callback);
    return id;
  },
  clearTimeout: (id) => timerCallbacks.delete(id),
};
globalThis.document = {
  get visibilityState() {
    return documentVisibilityState;
  },
  addEventListener: (type, callback) => {
    if (type === "visibilitychange") visibilityListeners.add(callback);
  },
  removeEventListener: (type, callback) => {
    if (type === "visibilitychange") visibilityListeners.delete(callback);
  },
};
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

function flushNextTimer() {
  const next = timerCallbacks.entries().next().value;
  if (!next) return false;
  const [id, callback] = next;
  timerCallbacks.delete(id);
  callback();
  return true;
}

function setDocumentVisibility(state) {
  documentVisibilityState = state;
  [...visibilityListeners].forEach((listener) => listener());
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
const outputListeners = new Map();
export const resizeCalls = [];
export const replayAcknowledgments = [];
export const terminalProcessManager = {
  async subscribeOutput(sessionId, listener) {
    outputListeners.set(sessionId, listener);
    return () => { if (outputListeners.get(sessionId) === listener) outputListeners.delete(sessionId); };
  },
  async resize(sessionId, cols, rows) { resizeCalls.push({ sessionId, cols, rows }); },
  acknowledgeOutput(sessionId, sequence, charCount) {
    replayAcknowledgments.push({ sessionId, sequence, charCount });
  },
};
export function emitOutput(delivery, sessionId = "session-1") { outputListeners.get(sessionId)?.(delivery); }
export function resetManager() {
  outputListeners.clear();
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

  scrollToBottom() {
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this.events.push(`scroll-bottom:${this.buffer.active.viewportY}`);
  }

  onResize(listener) {
    this.resizeListeners.add(listener);
    return { dispose: () => this.resizeListeners.delete(listener) };
  }

  loadAddon() {}
}

function createDisplay(
  proposedDimensions = { cols: 120, rows: 30 },
  { sessionId = "session-1", isVisible = true } = {},
) {
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
    sessionId,
    containerRef: { current: container },
    terminalRef,
    fitAddonRef: { current: { proposeDimensions: () => proposedDimensions } },
    isVisibleRef: { current: isVisible },
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

test("horizontal reflow restores live-bottom intent after asynchronous viewport drift", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.cursorY = 23;
  terminal.buffer.active.viewportY = 277;
  terminal.viewportMaxScrollLine = 277;
  terminal.reflowBaseYDelta = 300;

  display.scheduleFit(true, false);
  flushNextAnimationFrame();

  assert.equal(terminal.buffer.active.viewportY, 577);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577"]);

  // Reproduce the delayed DOM viewport event that can leave xterm at the top.
  terminal.buffer.active.viewportY = 0;
  flushNextAnimationFrame();
  assert.equal(terminal.buffer.active.viewportY, 0);

  flushNextAnimationFrame();
  assert.equal(terminal.buffer.active.viewportY, 577);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577", "scroll-bottom:577"]);
  detachViewport();
});

test("vertical resize does not force a live-bottom scroll", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 120, rows: 30 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.viewportY = 277;

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:120x30"]);
  detachViewport();
});

test("alternate buffer resize does not force a live-bottom scroll", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.type = "alternate";

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:60x24"]);
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

test("cancelling a scheduled fit cancels pending live-bottom restoration", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.viewportY = 277;
  terminal.reflowBaseYDelta = 300;

  display.scheduleFit(true, false);
  flushNextAnimationFrame();
  terminal.buffer.active.viewportY = 0;

  display.cancelScheduledFit();
  flushAnimationFrames();

  assert.equal(terminal.buffer.active.viewportY, 0);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577"]);
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
  assert.deepEqual(events, [
    "resize:90x20",
    "write:replay",
    "resize:120x30",
    "scroll-bottom:0",
  ]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 120, rows: 30 }]);

  flushAnimationFrames();
  assert.deepEqual(events, [
    "resize:90x20",
    "write:replay",
    "resize:120x30",
    "scroll-bottom:0",
    "write:live",
    "scroll-bottom:0",
  ]);
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
    "scroll-bottom:0",
  ]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 120, rows: 30 }]);

  flushAnimationFrames();
  assert.deepEqual(events.slice(-2), ["write:live", "scroll-bottom:0"]);
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

  assert.deepEqual(events, [
    "resize:100x25",
    "resize:120x30",
    "scroll-bottom:0",
    "write:live",
    "scroll-bottom:0",
  ]);
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

test("continuous live output yields between bounded xterm writes", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;
  const firstText = "a".repeat(40 * 1024);
  const secondText = "b".repeat(40 * 1024);

  managerStub.emitOutput(delivery(frame(3, firstText, 120, 30), commits));
  managerStub.emitOutput(delivery(frame(4, secondText, 120, 30), commits));
  flushNextAnimationFrame();

  assert.deepEqual(events, [`write:${firstText}`]);
  assert.deepEqual(commits, []);
  terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 3, charCount: firstText.length },
  ]);
  flushNextAnimationFrame();
  assert.deepEqual(events, [`write:${firstText}`, `write:${secondText}`]);
  terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 3, charCount: firstText.length },
    { sequence: 4, charCount: secondText.length },
  ]);
  output.dispose();
  detachViewport();
});

test("hidden document drains pending PTY output with timer fallback", async () => {
  managerStub.resetManager();
  setDocumentVisibility("hidden");
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;

  managerStub.emitOutput(delivery(frame(3, "background", 120, 30), commits));

  assert.equal(rafCallbacks.size, 0);
  assert.equal(timerCallbacks.size, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(commits, []);

  assert.equal(flushNextTimer(), true);
  assert.deepEqual(events, ["write:background"]);
  assert.deepEqual(commits, []);
  terminal.finishNextWrite();
  assert.deepEqual(commits, [{ sequence: 3, charCount: 10 }]);

  output.dispose();
  detachViewport();
  setDocumentVisibility("visible");
  assert.equal(timerCallbacks.size, 0);
});

test("timer watchdog drains output if a visible rAF is stalled", async () => {
  managerStub.resetManager();
  setDocumentVisibility("visible");
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;

  managerStub.emitOutput(delivery(frame(3, "watchdog", 120, 30), commits));

  assert.equal(rafCallbacks.size, 1);
  assert.equal(timerCallbacks.size, 1);
  rafCallbacks.clear();
  assert.equal(flushNextTimer(), true);
  assert.deepEqual(events, ["write:watchdog"]);
  terminal.finishNextWrite();
  assert.deepEqual(commits, [{ sequence: 3, charCount: 8 }]);

  output.dispose();
  detachViewport();
  assert.equal(timerCallbacks.size, 0);
});

test("multiple terminals start only one xterm write per animation frame", async () => {
  managerStub.resetManager();
  const first = createDisplay(undefined, { sessionId: "session-1" });
  const second = createDisplay(undefined, { sessionId: "session-2" });
  const firstOutput = first.display.attachPtyOutput();
  const secondOutput = second.display.attachPtyOutput();
  await Promise.all([firstOutput.ready, secondOutput.ready]);

  managerStub.emitOutput(delivery(frame(1, "first", 120, 30), []), "session-1");
  managerStub.emitOutput(delivery(frame(1, "second", 120, 30), []), "session-2");
  flushNextAnimationFrame();

  const writeCount = [...first.events, ...second.events]
    .filter((event) => event.startsWith("write:"))
    .length;
  assert.equal(writeCount, 1);
  const pending = first.terminal.writeCallbacks.length > 0 ? first : second;
  const waiting = pending === first ? second : first;
  pending.terminal.finishNextWrite();
  flushNextAnimationFrame();
  assert.equal(waiting.terminal.writeCallbacks.length, 1);

  waiting.terminal.finishNextWrite();
  firstOutput.dispose();
  secondOutput.dispose();
  first.detachViewport();
  second.detachViewport();
});

test("hidden terminal is not starved by continuous visible output", async () => {
  managerStub.resetManager();
  const visible = createDisplay(undefined, { sessionId: "visible", isVisible: true });
  const hidden = createDisplay(undefined, { sessionId: "hidden", isVisible: false });
  const visibleOutput = visible.display.attachPtyOutput();
  const hiddenOutput = hidden.display.attachPtyOutput();
  await Promise.all([visibleOutput.ready, hiddenOutput.ready]);
  const visibleCommits = [];
  const hiddenCommits = [];

  for (let sequence = 1; sequence <= 4; sequence += 1) {
    managerStub.emitOutput(
      delivery(frame(sequence, String(sequence).repeat(40 * 1024), 120, 30), visibleCommits),
      "visible",
    );
  }
  managerStub.emitOutput(delivery(frame(1, "background", 120, 30), hiddenCommits), "hidden");

  for (let index = 0; index < 3; index += 1) {
    flushNextAnimationFrame();
    assert.equal(hidden.events.length, 0);
    visible.terminal.finishNextWrite();
  }
  flushNextAnimationFrame();
  assert.deepEqual(
    hidden.events.filter((event) => event.startsWith("write:")),
    ["write:background"],
  );
  hidden.terminal.finishNextWrite();
  assert.deepEqual(hiddenCommits, [{ sequence: 1, charCount: 10 }]);

  visibleOutput.dispose();
  hiddenOutput.dispose();
  visible.detachViewport();
  hidden.detachViewport();
});
