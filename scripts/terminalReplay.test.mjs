import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-replay-"));
// 进程退出时删除本测试创建的临时模块目录。
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

let nextTimerId = 1;
const timerCallbacks = new Map();
const visibilityListeners = new Set();
let documentVisibilityState = "visible";
globalThis.window = {
  // 保存模拟定时器回调，等待测试主动推进。
  setTimeout: (callback) => {
    const id = nextTimerId++;
    timerCallbacks.set(id, callback);
    return id;
  },
  // 移除指定的模拟定时器。
  clearTimeout: (id) => timerCallbacks.delete(id),
};
globalThis.document = {
  // 返回当前模拟的文档可见状态。
  get visibilityState() {
    return documentVisibilityState;
  },
  // 仅登记可见性变化监听器。
  addEventListener: (type, callback) => {
    if (type === "visibilitychange") visibilityListeners.add(callback);
  },
  // 仅移除可见性变化监听器。
  removeEventListener: (type, callback) => {
    if (type === "visibilitychange") visibilityListeners.delete(callback);
  },
};
let nextRafId = 1;
const rafCallbacks = new Map();
// 保存动画帧回调并返回可取消的标识。
globalThis.requestAnimationFrame = (callback) => {
  const id = nextRafId++;
  rafCallbacks.set(id, callback);
  return id;
};
// 取消尚未执行的模拟动画帧。
globalThis.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
globalThis.ResizeObserver = class {
  // 提供不监听真实 DOM 的观察器占位方法。
  observe() {}
  // 提供不操作真实观察器的清理占位方法。
  disconnect() {}
};

// 取出本轮动画帧并执行，不混入本轮新安排的帧。
function flushNextAnimationFrame() {
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  // 将模拟时间传给本轮每个动画帧回调。
  callbacks.forEach((callback) => callback(performance.now()));
}

// 持续推进动画帧直到队列为空。
function flushAnimationFrames() {
  while (rafCallbacks.size > 0) flushNextAnimationFrame();
}

// 取出并执行最早的模拟定时器，返回是否存在待执行项。
function flushNextTimer() {
  const next = timerCallbacks.entries().next().value;
  if (!next) return false;
  const [id, callback] = next;
  timerCallbacks.delete(id);
  callback();
  return true;
}

// 切换模拟文档状态并通知已注册的监听器。
function setDocumentVisibility(state) {
  documentVisibilityState = state;
  // 逐个触发可见性变化监听器。
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

const source = readFileSync(new URL("../src/features/terminal/hooks/useTerminalDisplay.ts", import.meta.url), "utf8");
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
  .replace('from "../../../shared/lib/terminalThemes"', 'from "./themes.mjs"')
  .replace('from "../../../shared/platform/logger"', 'from "./logger.mjs"')
  .replace('from "../api/sessionSnapshotPersistence"', 'from "./snapshot.mjs"')
  .replace('from "../browser/TerminalResizeDebouncer"', 'from "./resize.mjs"')
  .replace('from "../browser/TerminalResizeRenderBarrier"', 'from "./resizeBarrier.mjs"')
  .replace('from "../api/TerminalProcessManager"', 'from "./manager.mjs"')
  .replace('from "../../../shared/preferences/settingsStore"', 'from "./settings.mjs"')
  .replace('from "../state"', 'from "./terminalStore.mjs"');
const modulePath = join(tempDir, "useTerminalDisplay.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { useTerminalDisplay } = await import(pathToFileURL(modulePath).href);
const managerStub = await import(pathToFileURL(join(tempDir, "manager.mjs")).href);
const resizeStub = await import(pathToFileURL(join(tempDir, "resize.mjs")).href);
const visibilityStub = await import(pathToFileURL(join(tempDir, "visibility.mjs")).href);

class FakeTerminal {
  // 初始化假终端缓冲区、回调队列和重排参数。
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

  // 记录写入内容并保留完成回调供测试主动确认。
  write(text, callback) {
    this.events.push(`write:${text}`);
    this.writeCallbacks.push(callback);
  }

  // 执行下一次写入完成回调，缺少待写入项时失败。
  finishNextWrite() {
    const callback = this.writeCallbacks.shift();
    assert.ok(callback, "expected a pending xterm write callback");
    callback();
  }

  // 模拟尺寸变化引起的缓冲区重排和异步视口更新。
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
      // 仅移动尚未释放的行标记。
      this.markers.forEach((marker) => {
        if (!marker.isDisposed) marker.line += this.reflowMarkerLineDelta;
      });
    }
    if (colsChanged) {
      const nextViewportMaxScrollLine = this.buffer.active.baseY;
      // 在后续动画帧更新模拟视口的最大滚动行。
      requestAnimationFrame(() => {
        this.viewportMaxScrollLine = nextViewportMaxScrollLine;
      });
    }
    this.events.push(`resize:${cols}x${rows}`);
    // 通知尺寸监听器新的列数和行数。
    this.resizeListeners.forEach((listener) => listener({ cols, rows }));
  }

  // 按当前光标偏移创建可释放的行标记。
  registerMarker(cursorYOffset) {
    const marker = {
      line: this.buffer.active.baseY + this.buffer.active.cursorY + cursorYOffset,
      isDisposed: false,
      // 将该标记置为已释放并从假终端集合移除。
      dispose: () => {
        marker.isDisposed = true;
        this.markers.delete(marker);
      },
    };
    this.markers.add(marker);
    return marker;
  }

  // 将滚动目标限制在模拟视口范围并记录事件。
  scrollToLine(line) {
    this.buffer.active.viewportY = Math.max(0, Math.min(line, this.viewportMaxScrollLine));
    this.events.push(`scroll:${this.buffer.active.viewportY}`);
  }

  // 滚动到缓冲区底部并记录事件。
  scrollToBottom() {
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this.events.push(`scroll-bottom:${this.buffer.active.viewportY}`);
  }

  // 登记尺寸监听器并返回解除订阅入口。
  onResize(listener) {
    this.resizeListeners.add(listener);
    // 释放该尺寸监听器。
    return { dispose: () => this.resizeListeners.delete(listener) };
  }

  // 提供不加载真实插件的占位入口。
  loadAddon() {}
}

// 组合假终端和替身依赖，返回可供测试驱动的显示控制器。
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
    // 提供不注册真实 DOM 事件的容器占位方法。
    addEventListener() {},
    // 提供不移除真实 DOM 事件的容器占位方法。
    removeEventListener() {},
  };
  const terminalRef = { current: terminal };
  const display = useTerminalDisplay({
    sessionId,
    containerRef: { current: container },
    terminalRef,
    // 返回测试指定的适配尺寸。
    fitAddonRef: { current: { proposeDimensions: () => proposedDimensions } },
    isVisibleRef: { current: isVisible },
    isComposingRef: { current: false },
    lowMemoryMode: false,
    disableHardwareAcceleration: true,
    linuxGraphicsDisableWebgl: true,
    isTransparentRef: { current: false },
    // 原样返回输出，隔离规范化逻辑。
    normalizeOutputRef: { current: (text) => text },
    // 原样返回输出，隔离变换逻辑。
    transformOutputRef: { current: (text) => text },
    afterTerminalWriteRef: { current: null },
    // 使 PTY 监听失败直接暴露给测试。
    onPtyOutputListenError: (error) => { throw error; },
  });
  const detachViewport = display.attachViewport(terminal);
  return { display, terminal, terminalRef, events, detachViewport };
}

// 验证尺寸不变的立即适配不强制刷新视口。
test("immediate fit does not force a viewport refresh when dimensions are unchanged", () => {
  const { display, terminal, detachViewport } = createDisplay();
  terminal.cols = 120;
  terminal.rows = 30;

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(visibilityStub.refreshCalls, []);
  detachViewport();
});

// 验证显式刷新在尺寸不变时仍重绘整个网格。
test("explicit viewport refresh repaints the full grid when dimensions are unchanged", () => {
  const { display, terminal, detachViewport } = createDisplay();
  terminal.cols = 120;
  terminal.rows = 30;

  display.scheduleFit(true, true);
  flushAnimationFrames();

  assert.deepEqual(visibilityStub.refreshCalls, [[0, 29]]);
  detachViewport();
});

// 验证连续适配帧保留横向调整节奏，取消时才清除。
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

// 验证横向重排后恢复普通缓冲区原先可见的行。
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

// 验证延迟视口漂移后仍恢复跟随底部的意图。
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

// 验证仅纵向调整不强制滚动到底部。
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

// 验证备用缓冲区调整不强制滚动到底部。
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

// 验证取消适配释放待恢复的行标记。
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

// 验证取消适配同时阻止待执行的底部恢复。
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

// 构造带历史尺寸与批次终点的回放或实时帧。
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

// 包装帧并收集消费确认，供测试检查顺序与字符数。
function delivery(frameValue, commits) {
  return {
    frame: frameValue,
    // 记录该帧序号和实际确认字符数。
    commit: (charCount) => commits.push({ sequence: frameValue.sequence, charCount }),
  };
}

// 验证初始回放适配当前容器后才释放缓存的实时输出。
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

// 验证重连回放串行恢复历史尺寸，并在实时输出前适配当前尺寸。
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

// 验证仅尺寸变化的回放先在本地应用再适配当前容器。
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

// 验证连续实时输出在有界写入之间让出执行机会。
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

// 验证文档隐藏时由模拟定时器推进待消费的 PTY 输出。
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

// 验证可见文档的动画帧停滞时看门狗仍推进输出。
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

// 验证多个终端在同一动画帧只启动一次写入。
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
    // 仅统计写入事件，不计尺寸与滚动事件。
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

// 验证持续可见输出不会使隐藏终端一直得不到消费机会。
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
    // 仅保留隐藏终端的写入事件供断言。
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
