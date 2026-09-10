// Run with Node, then open the printed isolated loopback URL. The harness uses
// real production components and transport batching, without auth or providers.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { WebTerminal } from '/apps/web/src/WebTerminal.tsx';
import { translate } from '/apps/web/src/i18n.ts';
import { useAppModel } from '/apps/web/src/useAppModel.ts';
import { webClient } from '/apps/web/src/webClient.ts';
import { createTerminalStream } from '/apps/web/src/terminalStream.ts';
import { batchWebTerminalFrames } from '/src/lib/webTerminalFrames.ts';
import { installTerminalQueryPolicy, setTerminalQueryReplay, canAnswerTerminalQuery, canAnswerTerminalQueryFrame, createTerminalQuerySession, claimTerminalQueryFrame } from '/src/lib/terminalQueryPolicy.ts';
import '/apps/web/src/styles.css';
const result = window.terminalSmoke = { status: 'running', errors: [], rounds: [], payloadBytes: 0, componentRenders: 0 };
const originalWrite = Terminal.prototype.write;
Terminal.prototype.write = function(...args) {
  result.writeCount = (result.writeCount || 0) + 1;
  if (result.captureDimensions) result.captureDimensions.push({ cols: this.cols, rows: this.rows });
  return originalWrite.apply(this, args);
};
window.addEventListener('error', e => result.errors.push(String(e.error || e.message)));
window.addEventListener('unhandledrejection', e => result.errors.push(String(e.reason)));
const originalError = console.error;
console.error = (...args) => { result.errors.push(args.map(String).join(' ')); originalError(...args); };
const root = createRoot(document.getElementById('root'));
const stream = createTerminalStream();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function terminal() {
  const host = document.querySelector('.web-terminal');
  let fiber = host?.[Object.keys(host).find(key => key.startsWith('__reactFiber$'))];
  while (fiber) {
    let hook = fiber.memoizedState;
    while (hook && typeof hook === 'object') {
      const current = hook.memoizedState?.current;
      if (current?.buffer?.active && typeof current.write === 'function') return current;
      hook = hook.next;
    }
    fiber = fiber.return;
  }
}
function tail() {
  const active = terminal()?.buffer.active;
  if (!active) return '';
  return Array.from({ length: Math.min(active.length, 55) }, (_, i) => active.getLine(Math.max(0, active.length - 55) + i)?.translateToString(true) || '').join('\\n');
}
function chunks(id) {
  const data = new TextEncoder().encode('\\x1b[32m终端内容 🚀 ANSI replay\\x1b[0m\\r\\n'.repeat(25000) + 'SMOKE FINAL ' + id + '\\r\\n');
  result.payloadBytes = data.length;
  const frame = { kind: 'replay', sessionId: id, sequence: 123, cols: 120, rows: 32, data, replayBatchEnd: true };
  return batchWebTerminalFrames([{ ...frame, kind: 'reset', data: new Uint8Array(), replayBatchEnd: false }, frame]).map((batch, i) => ({ sequence: i + 1, frames: batch.frames }));
}
function mount(id, data, controlMode = 'desktop', active = true, language = 'en-US') {
  stream.start(id);
  result.componentRenders++;
  flushSync(() => root.render(React.createElement(WebTerminal, { sessionId: id, active, status: 'running', stream, controlMode, source: 'codex', theme: 'dark', t: key => translate(language, key), errorLabel: '终端错误 / Terminal error', scrollLabel: 'Scroll to bottom', onInput(data) { (result.inputRequests ??= []).push({ id, data }); }, onResize(cols, rows) { (result.resizeRequests ??= []).push({ id, cols, rows }); } })));
  data.forEach(chunk => stream.publish(id, chunk));
}
async function waitMarker(id) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (tail().includes('SMOKE FINAL ' + id)) return;
    await pause(20);
  }
  throw new Error('Rendered terminal missing final marker for ' + id + ': ' + tail().slice(-300));
}
async function run() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const publish = (id, chunkSequence, text, extra = {}) => stream.publish(id, {
    sequence: chunkSequence,
    frames: [{ kind: 'output', sequence: chunkSequence, sequenceStart: true, sequenceEnd: true, cols: 120, rows: 32, data: btoa(text), replayBatchEnd: false, ...extra }],
  });
  // Real AppModel + socket parser, isolated transport: workspace pushes must
  // update transcripts/inventory without re-fetching the entire history.
  const savedWebSocket = window.WebSocket;
  const savedClient = { ...webClient };
  let hookSocket;
  const sentCommands = [];
  class WorkspaceSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { hookSocket = this; }
    send(data) { sentCommands.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  let appModel;
  let historyCalls = 0;
  let releaseHistory;
  let delayHistory = false;
  const initialWorkspace = { groups: [], projects: [{ id: 'project', name: 'Project', groupId: null, sortOrder: 0, source: 'codex', environmentType: 'local' }], worktrees: [], terminals: [], subagents: [], updatedAt: 1 };
  const historyResult = () => ({ items: [], workspace: initialWorkspace });
  function HookHarness() { appModel = useAppModel(); return null; }
  try {
    window.WebSocket = WorkspaceSocket;
    webClient.authStatus = async () => ({ authenticated: true, user: { id: 'workspace-test-user', username: 'test' } });
    webClient.devices = async () => ({ devices: [{ id: 'device', name: 'Device', status: 'online', capabilities: [] }] });
    webClient.history = async () => {
      historyCalls++;
      if (delayHistory) return await new Promise(resolve => { releaseHistory = () => resolve(historyResult()); });
      return historyResult();
    };
    webClient.conversations = async () => ({ sessions: [] });
    flushSync(() => root.render(React.createElement(HookHarness)));
    const waitFor = async (predicate, message) => {
      const deadline = Date.now() + 4000;
      while (!predicate() && Date.now() < deadline) await pause(10);
      check(predicate(), message);
    };
    await waitFor(() => appModel?.workspace?.updatedAt === 1 && hookSocket, 'AppModel initial workspace did not load');
    hookSocket.onopen?.();
    hookSocket.receive({ type: 'ready', latestSequence: 0 });
    await pause(150);
    const beforePush = historyCalls;
    const nextWorkspace = { ...initialWorkspace, updatedAt: 2, terminals: [{ sessionId: 'parent', projectId: 'project', title: 'Parent' }], subagents: [{ sessionId: 'child', parentSessionId: 'parent', title: 'Agent', sourceKind: 'child-jsonl', ended: false, content: 'real child transcript', truncated: false }] };
    hookSocket.receive({ type: 'event', sequence: 1, payload: { type: 'workspace.updated', deviceId: 'device', workspace: nextWorkspace } });
    await waitFor(() => appModel.workspace?.subagents?.[0]?.content === 'real child transcript', 'Workspace event lost subagent transcript');
    check(historyCalls === beforePush, 'Workspace event triggered a full history fetch');
    check(sentCommands.some(entry => entry.command.type === 'attach' && entry.command.sessionId === 'parent'), 'Workspace inventory did not attach new terminal');
    delayHistory = true;
    hookSocket.receive({ type: 'event', sequence: 2, payload: { type: 'history.updated', deviceId: 'device', latestUpdatedAt: 2 } });
    await waitFor(() => releaseHistory, 'History invalidation stopped refreshing history');
    const removed = { ...initialWorkspace, updatedAt: 3 };
    hookSocket.receive({ type: 'event', sequence: 3, payload: { type: 'workspace.updated', deviceId: 'device', workspace: removed } });
    await waitFor(() => appModel.workspace?.updatedAt === 3, 'Workspace terminal removal did not apply');
    check(sentCommands.some(entry => entry.command.type === 'detach' && entry.command.sessionId === 'parent'), 'Workspace inventory did not detach removed terminal');
    releaseHistory();
    await pause(150);
    check(appModel.workspace.updatedAt === 3 && appModel.workspace.terminals.length === 0, 'Delayed old HTTP snapshot overwrote a newer workspace push');
    result.workspacePush = { noHistoryFetch: true, subagentsPreserved: true, terminalAttachDetach: true, staleHttpIgnored: true };
  } finally {
    flushSync(() => root.render(null));
    window.WebSocket = savedWebSocket;
    Object.assign(webClient, savedClient);
  }

  result.geometry = [];
  const inspectGeometry = (name, cols, rows) => {
    const host = document.querySelector('.web-terminal');
    const screenElement = host.querySelector('.xterm-screen');
    const screen = screenElement.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const element = terminal().element.getBoundingClientRect();
    const css = getComputedStyle(host);
    const availableWidth = host.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const availableHeight = host.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const state = { name, availableWidth, availableHeight, width: screen.width, height: screen.height, fontSize: terminal().options.fontSize, cols: terminal().cols, rows: terminal().rows };
    result.geometry.push(state);
    check(state.fontSize <= 14, 'Desktop split enlarged terminal text: ' + JSON.stringify(state));
    check(screen.width + 16 <= availableWidth + 1 && screen.height <= availableHeight + 1, 'Terminal grid is clipped: ' + JSON.stringify(state));
    check(Math.abs(element.height - screen.height) <= 1, 'Terminal viewport differs from actual grid height: ' + JSON.stringify(state));
    check(screen.bottom <= hostRect.bottom - parseFloat(css.paddingBottom) + 1, 'Last terminal row is below the visible container');
    check(terminal().cols === cols && terminal().rows === rows, 'Desktop viewer changed the source PTY grid');
    check(terminal().buffer.active.getLine(terminal().buffer.active.baseY + rows - 1)?.translateToString(true).startsWith('LAST-ROW'), 'Bottom input row marker was lost');
    const mouse = [];
    const listener = terminal().onData(data => mouse.push(data));
    screenElement.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, button: 0, buttons: 1,
      clientX: screen.left + screen.width / cols * 9.5,
      clientY: screen.top + screen.height / rows * (rows - 0.5),
    }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }));
    listener.dispose();
    check(mouse.includes('\x1b[<0;10;' + rows + 'M'), 'Scaled last-row click mapped to wrong cell: ' + JSON.stringify({ state, mouse }));
  };
  for (const [name, width, height] of [['narrow', 360, 700], ['normal', 1200, 700], ['wide', 2400, 700], ['short', 1800, 240]]) {
    document.getElementById('root').style.width = width + 'px';
    document.getElementById('root').style.height = height + 'px';
    const id = 'geometry-' + name;
    mount(id, []);
    publish(id, 1, 'SMOKE FINAL ' + id + '\x1b[32;1HLAST-ROW\x1b[?1000h\x1b[?1006h');
    await waitMarker(id);
    await pause(100);
    inspectGeometry(name, 120, 32);
    // A desktop subagent pane halves the parent's columns without changing Web width.
    publish(id, 2, '\x1b[2J\x1b[HSMOKE FINAL ' + id + '\x1b[32;1HLAST-ROW\x1b[?1000h\x1b[?1006h', { cols: 60 });
    await pause(100);
    inspectGeometry(name + '-subagent-split', 60, 32);
    publish(id, 3, '\x1b[2J\x1b[HSMOKE FINAL ' + id + '\x1b[32;1HLAST-ROW', { cols: 120 });
    await pause(100);
    inspectGeometry(name + '-unsplit', 120, 32);
  }
  check((result.resizeRequests ?? []).length === 0, 'Desktop-controlled viewer emitted resize requests');
  document.getElementById('root').style.width = '1200px';
  document.getElementById('root').style.height = '700px';

  const handoffId = 'geometry-short';
  mount(handoffId, [], 'web');
  await pause(150);
  check(terminal().options.fontSize === 14 && terminal().cols > 120 && terminal().rows > 32, 'Web takeover retained tiny mirror font or stale source grid: ' + JSON.stringify({ fontSize: terminal().options.fontSize, cols: terminal().cols, rows: terminal().rows }));
  mount(handoffId, [], 'desktop');
  publish(handoffId, 4, '\\x1b[2J\\x1b[HLAST-ROW', { cols: 60, rows: 32 });
  await pause(100);
  check(terminal().options.fontSize === 14 && terminal().cols === 60 && terminal().rows === 32, 'Desktop takeover retained the Web grid');
  result.geometryHandoff = true;

  const scrollId = 'geometry-scrollback';
  mount(scrollId, []);
  publish(scrollId, 1, 'scrollback line\\r\\n'.repeat(70));
  await pause(100);
  const scrollScreen = document.querySelector('.xterm-screen');
  const scrollRect = scrollScreen.getBoundingClientRect();
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -300, clientX: scrollRect.left + 40, clientY: scrollRect.top + 40 });
  // Chromium leaves the legacy delta at zero on constructed events; xterm reads it first.
  Object.defineProperty(wheel, 'wheelDeltaY', { value: 900 });
  scrollScreen.dispatchEvent(wheel);
  await pause(150);
  check(terminal().buffer.active.viewportY < terminal().buffer.active.baseY, 'Mirror scrollback wheel did not move viewport: ' + JSON.stringify({ baseY: terminal().buffer.active.baseY, viewportY: terminal().buffer.active.viewportY, tail: tail().slice(-100) }));
  const bottomButton = document.querySelector('.web-terminal-scroll-bottom');
  check(bottomButton, 'Scrolled mirror has no return-to-bottom control');
  bottomButton.click();
  await pause(100);
  check(terminal().buffer.active.viewportY === terminal().buffer.active.baseY, 'Mirror return-to-bottom did not restore input viewport');
  result.geometryScrollback = true;

  const protocolId = 'web-query-policy';
  mount(protocolId, []);
  const queries = '\\x1b[c\\x1b[>c\\x1b[5n\\x1b[6n\\x1b[?6n\\x1b[?25$p\\x1b[?u\\x1b[18t\\x1bP$qm\\x1b\\\\';
  publish(protocolId, 1, queries);
  await pause(100);
  publish(protocolId, 2, '\\x1b[');
  await pause(30);
  publish(protocolId, 3, 'c');
  publish(protocolId, 4, queries, { kind: 'replay', replayBatchEnd: true });
  await pause(100);
  const webInputs = () => (result.inputRequests ?? []).filter(entry => entry.id === protocolId).map(entry => entry.data);
  check(webInputs().length === 0, 'Web output query leaked into PTY input: ' + JSON.stringify(webInputs()));
  publish(protocolId, 5, '\\x1b]4;1;#ff0000;2;?\\x07\\x1b[31mCOLOR\\x1b[0m\\x1b]10;#112233;?\\x07');
  await pause(100);
  const colors = terminal()._core._themeService.colors;
  check((colors.ansi[1].rgba >>> 8) === 0xff0000 && (colors.foreground.rgba >>> 8) === 0x112233, 'Mixed color queries swallowed ordered palette/default setters');
  check(webInputs().length === 0, 'Mixed color query leaked into PTY input');
  terminal().focus();
  terminal().textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'x', code: 'KeyX', keyCode: 88, which: 88 }));
  terminal().textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38 }));
  const pasted = '中文 [1;2c';
  terminal().paste(pasted);
  await pause(50);
  check(webInputs().includes('x') && webInputs().includes('\\x1b[A') && webInputs().includes(pasted), 'Web query suppression swallowed keyboard/arrow/Chinese paste: ' + JSON.stringify(webInputs()));
  result.webQueryPolicy = true;

  // Exercise the real parser with the same ConPTY override and replay gate as desktop.
  const desktop = new Terminal({ cols: 80, rows: 24 });
  const desktopReplies = [];
  const desktopData = desktop.onData(data => desktopReplies.push(data));
  const conpty = desktop.parser.registerCsiHandler({ final: 'c' }, params => {
    if (!canAnswerTerminalQuery(desktop)) return true;
    if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
      desktopReplies.push('\\x1b[?61;4c');
      return true;
    }
    return false;
  });
  const desktopPolicy = installTerminalQueryPolicy(desktop, () => canAnswerTerminalQuery(desktop));
  const desktopWrite = data => new Promise(resolve => desktop.write(data, resolve));
  const deliver = async (id, sequence, replay, bytes) => {
    setTerminalQueryReplay(desktop, !canAnswerTerminalQueryFrame(id, sequence, replay));
    await desktopWrite(bytes);
    claimTerminalQueryFrame(id, sequence, replay);
    setTerminalQueryReplay(desktop, false);
  };
  const createdId = 'desktop-created-query';
  createTerminalQuerySession(createdId);
  check(canAnswerTerminalQueryFrame(createdId, 1, true) && canAnswerTerminalQueryFrame(createdId, 1, true), 'Queued/cancelled output must not consume the initial handshake');
  await deliver(createdId, 1, true, '\\x1b[c');
  check(desktopReplies.length === 1 && desktopReplies[0] === '\\x1b[?61;4c', 'Initial replay did not deliver the new process ConPTY handshake exactly once');
  await deliver(createdId, 1, true, queries);
  await deliver(createdId, 1, false, queries);
  check(desktopReplies.length === 1, 'Duplicate frame repeated terminal protocol replies');
  const coldId = 'desktop-cold-query';
  await deliver(coldId, 8, true, queries);
  check(desktopReplies.length === 1, 'Cold historical restore generated terminal replies');
  await deliver(coldId, 9, false, '\\x1b[c\\x1b[6n');
  check(desktopReplies.length === 3 && desktopReplies[1] === '\\x1b[?61;4c' && /R$/.test(desktopReplies[2]), 'Live desktop query did not resume after cold replay: ' + JSON.stringify(desktopReplies));
  desktopPolicy.dispose();
  conpty.dispose();
  desktopData.dispose();
  desktop.dispose();
  result.desktopQueryPolicy = { startupOnce: true, duplicatesSuppressed: true, coldReplaySuppressed: true, liveReplies: true };

  const splitId = 'split-checkpoint';
  mount(splitId, []);
  publish(splitId, 1, 'partial', { sequence: 55, sequenceEnd: false });
  await pause(100);
  check(stream.renderedSequence(splitId) === undefined, 'Partial sequence was committed before final segment');
  publish(splitId, 2, ' complete', { sequence: 55, sequenceStart: false, sequenceEnd: true });
  await pause(100);
  check(stream.renderedSequence(splitId) === 55, 'Final sequence segment was not committed');
  result.splitCheckpoint = true;

  const reconnectId = 'partial-reconnect';
  mount(reconnectId, []);
  publish(reconnectId, 1, 'BASE\\r\\n');
  await pause(70);
  publish(reconnectId, 2, 'PREFIX-', { sequence: 2, sequenceEnd: false });
  await pause(70);
  check(stream.renderedSequence(reconnectId) === 1, 'Partial reconnect checkpoint advanced');
  // Retained daemon replay is incremental: no reset when sequence 1 still exists.
  publish(reconnectId, 3, 'PREFIX-COMPLETE\\r\\n', { kind: 'replay', sequence: 2, sequenceEnd: true, replayBatchEnd: true });
  await pause(100);
  const reconnectTail = tail();
  check(reconnectTail.includes('BASE') && reconnectTail.includes('PREFIX-COMPLETE') && !reconnectTail.includes('PREFIX-PREFIX-'), 'Incremental reconnect duplicated an already drawn partial prefix: ' + reconnectTail);
  result.partialReconnect = true;

  const retryId = 'replay-retry';
  mount(retryId, []);
  publish(retryId, 1, 'BASE\\r\\n');
  await pause(70);
  publish(retryId, 2, 'PREFIX-', { kind: 'replay', sequence: 2, sequenceEnd: false });
  await pause(70);
  publish(retryId, 3, 'PREFIX-', { kind: 'replay', sequence: 2, sequenceEnd: false });
  publish(retryId, 4, 'COMPLETE\\r\\n', { kind: 'replay', sequence: 2, sequenceStart: false, sequenceEnd: true, replayBatchEnd: true });
  await pause(100);
  const retryTail = tail();
  check(retryTail.includes('BASE') && retryTail.includes('PREFIX-COMPLETE') && !retryTail.includes('PREFIX-PREFIX-'), 'Repeated incremental replay retained a stale partial prefix: ' + retryTail);
  result.replayRetry = true;

  const replayId = 'dimension-replay';
  mount(replayId, []);
  result.captureDimensions = [];
  stream.publish(replayId, { sequence: 1, frames: [
    { kind: 'reset', sequence: 1, sequenceEnd: false, cols: 80, rows: 24, data: '', replayBatchEnd: false },
    { kind: 'replay', sequence: 1, sequenceEnd: true, cols: 80, rows: 24, data: btoa('old grid\\r\\n'), replayBatchEnd: false },
    { kind: 'replay', sequence: 2, sequenceEnd: true, cols: 120, rows: 32, data: btoa('SMOKE FINAL ' + replayId), replayBatchEnd: true },
  ]});
  await waitMarker(replayId);
  const dimensions = result.captureDimensions;
  delete result.captureDimensions;
  check(dimensions.some(entry => entry.cols === 80) && dimensions.some(entry => entry.cols === 120), 'Replay flattened intermediate terminal dimensions');
  result.replayDimensions = dimensions;

  const sentinelId = 'standalone-replay-end';
  mount(sentinelId, []);
  publish(sentinelId, 1, '', { kind: 'reset', sequence: 0, cols: 0, rows: 0, sequenceEnd: false });
  publish(sentinelId, 2, 'HISTORY-READY\\r\\n', { kind: 'replay', sequence: 7, replayBatchEnd: false });
  await pause(50);
  check(!tail().includes('HISTORY-READY'), 'Full replay was drawn before its boundary');
  publish(sentinelId, 3, '', { kind: 'replay', sequence: 0, cols: 0, rows: 0, replayBatchEnd: true });
  await pause(100);
  check(tail().includes('HISTORY-READY'), 'Independent sequence-zero replay boundary was swallowed');
  check(stream.renderedSequence(sentinelId) === 7, 'Empty replay boundary lost the history checkpoint');
  publish(sentinelId, 4, 'LIVE-AFTER-REPLAY', { sequence: 8 });
  await pause(100);
  check(tail().includes('LIVE-AFTER-REPLAY') && stream.renderedSequence(sentinelId) === 8, 'Live output was blocked after standalone replay boundary');
  result.standaloneReplayEnd = true;

  result.visibilityWake = [];
  for (const mode of ['inactive', 'hidden']) {
    const wakeId = 'wake-' + mode;
    mount(wakeId, [], 'desktop', mode !== 'inactive');
    if (mode === 'hidden') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }
    publish(wakeId, 1, 'WAKE-MARKER');
    await pause(30);
    check(!tail().includes('WAKE-MARKER'), mode + ' output was not throttled');
    const wakeStart = performance.now();
    if (mode === 'hidden') {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    } else {
      mount(wakeId, [], 'desktop', true);
    }
    while (!tail().includes('WAKE-MARKER') && performance.now() - wakeStart < 180) await pause(5);
    const elapsedMs = Math.round(performance.now() - wakeStart);
    check(tail().includes('WAKE-MARKER') && elapsedMs < 180, mode + ' activation retained the 250ms background delay: ' + elapsedMs);
    result.visibilityWake.push({ mode, elapsedMs });
  }

  const cursorId = 'cursor-policy';
  mount(cursorId, []);
  await pause(80);
  check(terminal().options.cursorBlink === false && terminal().options.cursorInactiveStyle === 'none', 'Web cursor policy differs from desktop');
  publish(cursorId, 1, '\\x1b[?25l');
  await pause(70);
  check(terminal()._core.coreService.isCursorHidden, 'Cursor hide was ignored');
  publish(cursorId, 2, '\\x1b[?2');
  await pause(30);
  publish(cursorId, 3, '5h');
  await pause(40);
  check(terminal()._core.coreService.isCursorHidden, 'Split cursor-show flashed before Codex delay');
  await pause(120);
  check(!terminal()._core.coreService.isCursorHidden, 'Stable input cursor was never restored');
  publish(cursorId, 4, '\\x1b[?25l\\x1b[?25h\\x1b[?25l');
  await pause(160);
  check(terminal()._core.coreService.isCursorHidden, 'Stale delayed show overrode a newer hide');
  result.cursorPolicy = true;

  const webId = 'web-control';
  mount(webId, [], 'web');
  await pause(150);
  const beforeOutput = (result.resizeRequests ?? []).length;
  const grid = { cols: terminal().cols, rows: terminal().rows };
  for (let i = 1; i <= 30; i++) {
    publish(webId, i, 'live output\\r\\n', grid);
    await pause(5);
  }
  await pause(150);
  check((result.resizeRequests ?? []).length === beforeOutput, 'Web output generated redundant resize requests');
  result.webResizeStable = true;

  // Display preferences are browser-local: neither owner may resize the PTY
  // merely because the viewer changes font, fitting mode or viewport bounds.
  const displayKey = 'cli-manager.web-terminal-display.v1';
  const control = selector => {
    const found = document.querySelector(selector);
    check(found, 'Missing real display-settings entry: ' + selector);
    return found;
  };
  const change = async (selector, value) => {
    const element = control(selector);
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, String(value));
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await pause(120);
  };
  const viewport = () => document.querySelector('.web-terminal-viewport') ?? document.querySelector('.web-terminal');
  result.displaySettings = [];
  for (const owner of ['desktop', 'web']) {
    const displayId = 'display-settings-' + owner;
    mount(displayId, [], owner);
    await pause(150);
    publish(displayId, 1, 'DISPLAY-MARKER');
    await pause(150);
    control('details.web-terminal-display').open = true;
    const gridBefore = { cols: terminal().cols, rows: terminal().rows };
    const resizesBefore = (result.resizeRequests ?? []).length;
    const unchanged = () => {
      check(terminal().cols === gridBefore.cols && terminal().rows === gridBefore.rows, 'Display settings changed shared ' + owner + ' PTY grid');
      check((result.resizeRequests ?? []).length === resizesBefore, 'Display settings emitted ' + owner + ' PTY resize');
      check(tail().includes('DISPLAY-MARKER'), 'Display setting discarded terminal content');
    };
    await change('select[data-display-mode]', 'manual');
    await change('input[data-display-font]', 24);
    check(terminal().options.fontSize === 24, 'Manual font did not enlarge to 24');
    unchanged();
    await change('input[data-display-font]', 10);
    check(terminal().options.fontSize === 10, 'Manual font did not shrink to 10');
    unchanged();
    const fontButtons = document.querySelectorAll('.web-terminal-display-buttons button');
    check(fontButtons.length === 2, 'Missing font minus/plus buttons');
    fontButtons[1].click();
    await pause(100);
    check(terminal().options.fontSize === 11, 'Font plus button did not increment');
    fontButtons[0].click();
    await pause(100);
    check(terminal().options.fontSize === 10, 'Font minus button did not decrement');
    unchanged();
    const ctrlWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
    document.querySelector('.xterm-screen').dispatchEvent(ctrlWheel);
    await pause(120);
    check(ctrlWheel.defaultPrevented && terminal().options.fontSize > 10 && control('select[data-display-mode]').value === 'manual', 'Ctrl+wheel did not locally enlarge the font or prevent browser zoom');
    unchanged();
    await change('select[data-display-mode]', 'width');
    const widthViewport = viewport();
    const widthCss = getComputedStyle(widthViewport);
    const available = widthViewport.clientWidth - parseFloat(widthCss.paddingLeft) - parseFloat(widthCss.paddingRight);
    const widthScreen = document.querySelector('.xterm-screen').getBoundingClientRect();
    check(Math.abs(available - widthScreen.width) < 45, 'Fit-width still leaves a wide blank region: ' + JSON.stringify({ available, screen: widthScreen.width }));
    await change('input[data-display-height]', 30);
    check(viewport().scrollHeight > viewport().clientHeight && /auto|scroll/.test(getComputedStyle(viewport()).overflowY), 'Fit-width cannot scroll vertically to an oversized input row');
    viewport().scrollTop = viewport().scrollHeight;
    check(viewport().scrollTop > 0, 'Fit-width scrollbar cannot reach bottom');
    unchanged();
    await change('input[data-display-height]', 100);
    await change('select[data-display-mode]', 'contain');
    const contained = document.querySelector('.xterm-screen').getBoundingClientRect();
    check(contained.width <= viewport().clientWidth + 1 && contained.height <= viewport().clientHeight + 1, 'Contain does not show the full grid');
    const beforeRegion = viewport().getBoundingClientRect();
    await change('input[data-display-width]', 60);
    await change('input[data-display-height]', 60);
    const afterRegion = viewport().getBoundingClientRect();
    check(afterRegion.width < beforeRegion.width * 0.75 && afterRegion.height < beforeRegion.height * 0.75, 'Display width/height controls did not change viewport bounds');
    unchanged();
    await change('select[data-display-mode]', 'manual');
    await change('input[data-display-font]', 19);
    const stored = JSON.parse(localStorage.getItem(displayKey));
    check(stored.mode === 'manual' && stored.fontSize === 19 && stored.width === 60 && stored.height === 60, 'Display preferences were not persisted');
    flushSync(() => root.render(null));
    mount(displayId + '-restored', [], owner);
    await pause(150);
    check(control('select[data-display-mode]').value === 'manual' && control('input[data-display-font]').value === '19' && control('input[data-display-width]').value === '60' && control('input[data-display-height]').value === '60', 'Remount failed to restore browser-local preferences');
    control('button[data-display-reset]').click();
    await pause(150);
    check(control('select[data-display-mode]').value === 'contain' && control('input[data-display-font]').value === '14' && control('input[data-display-width]').value === '100' && control('input[data-display-height]').value === '100', 'Display reset did not restore defaults');
    result.displaySettings.push({ owner, font: true, ctrlWheel: true, fitWidth: true, scrollable: true, contain: true, region: true, persistedRemount: true, reset: true, noPtyResize: true });
  }
  mount('display-i18n', [], 'desktop', true, 'zh-CN');
  await pause(100);
  const chinese = control('details.web-terminal-display').textContent;
  mount('display-i18n', [], 'desktop', true, 'en-US');
  await pause(100);
  const english = control('details.web-terminal-display').textContent;
  check(/[\u4e00-\u9fff]/.test(chinese) && !/[\u4e00-\u9fff]/.test(english) && chinese !== english && !english.includes('undefined'), 'Display settings failed live Chinese/English switching');
  result.displayLanguageSwitch = true;

  const first = 'initial';
  mount(first, chunks(first));
  await waitMarker(first);
  result.rounds.push({ session: first, marker: true });
  for (let i = 0; i < 10; i++) {
    // Allow a large write to start, then dispose it while asynchronous parser
    // callbacks and additional frame writes are still queued.
    mount('discard-' + i, chunks('discard-' + i));
    await pause(0);
    if (i % 2 === 0) flushSync(() => root.render(null));
    const id = 'recovered-' + i;
    mount(id, chunks(id));
    await waitMarker(id);
    result.rounds.push({ session: id, marker: true });
  }
  const liveId = 'high-frequency';
  mount(liveId, []);
  const startedAt = performance.now();
  const writesBefore = result.writeCount || 0;
  const liveText = new TextEncoder().encode('frame output\\r\\n');
  for (let sequence = 1; sequence <= 5000; sequence++) {
    stream.publish(liveId, { sequence, frames: [{ kind: 'output', sequence, cols: 120, rows: 32, data: btoa(String.fromCharCode(...liveText)), replayBatchEnd: false }] });
  }
  stream.publish(liveId, { sequence: 5001, frames: [{ kind: 'output', sequence: 5001, cols: 120, rows: 32, data: btoa('SMOKE FINAL high-frequency\\r\\n'), replayBatchEnd: false }] });
  await waitMarker(liveId);
  result.highFrequency = {
    chunks: 5001,
    renderedSequence: document.querySelector('.web-terminal')?.dataset.renderedSequence,
    xtermWrites: (result.writeCount || 0) - writesBefore,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
  const screen = document.querySelector('.xterm-screen')?.getBoundingClientRect();
  result.screen = screen ? { width: screen.width, height: screen.height } : null;
  result.tail = tail().slice(-500);
  result.status = result.errors.length || !screen?.width || !screen?.height ? 'failed' : 'passed';
  document.title = 'Terminal smoke: ' + result.status;
  // Keep the verified real component visible for a human UI review.
  mount(liveId, [], 'desktop', true, 'zh-CN');
  control('button[data-display-reset]').click();
  await pause(100);
  control('details.web-terminal-display').open = true;
  await change('select[data-display-mode]', 'width');
  result.visualReady = true;
}
run().catch(error => { result.errors.push(String(error)); result.status = 'failed'; });
`;

const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@xterm/xterm", "@xterm/addon-fit"] },
  esbuild: { jsx: "automatic" },
  plugins: [{
    name: "isolated-terminal-renderer-smoke",
    resolveId(id) { if (id === "/terminal-smoke.js") return "\0terminal-smoke"; },
    load(id) { if (id === "\0terminal-smoke") return harness; },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await vite.transformIndexHtml("/", '<!doctype html><html><head><meta charset="utf-8"><title>Terminal smoke</title><style>body{margin:0;background:#0b0d10;color:white}#root{height:700px;width:1200px;display:flex}</style></head><body><div id="root"></div><script type="module" src="/terminal-smoke.js"></script></body></html>'));
      });
    },
  }],
  server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
});
await server.listen();
console.log(JSON.stringify({ url: server.resolvedUrls.local[0], readResult: "window.terminalSmoke" }));
async function stop() { await server.close(); process.exit(0); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (process.argv.includes("--run")) {
  const profile = await mkdtemp(join(tmpdir(), "cli-manager-terminal-smoke-"));
  const browser = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
    "--user-data-dir=" + profile, "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let browserLog = "";
  browser.stderr.on("data", data => { browserLog = (browserLog + data.toString()).slice(-2000); });
  let ws;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timeout")), 20000);
      let stderr = "";
      browser.on("error", reject);
      browser.stderr.on("data", data => {
        stderr += data.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chrome socket open timeout: " + browserLog)), 15000);
      ws.onopen = () => { clearTimeout(timeout); resolve(); };
      ws.onerror = error => { clearTimeout(timeout); reject(error); };
      ws.onclose = () => { clearTimeout(timeout); reject(new Error("Chrome closed before connection: " + browserLog)); };
    });
    let id = 0;
    const pending = new Map();
    ws.onclose = () => {
      for (const request of pending.values()) request.reject(new Error("Chrome debugging connection closed"));
      pending.clear();
    };
    ws.onmessage = event => {
      const response = JSON.parse(event.data);
      if (response.method === "Runtime.exceptionThrown") console.error(JSON.stringify({ browserException: response.params.exceptionDetails }));
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error(JSON.stringify(response.error)));
      else request.resolve(response.result);
    };
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error("CDP timeout: " + method)); }, 15000);
      pending.set(requestId, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      ws.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await call("Target.createTarget", { url: server.resolvedUrls.local[0] });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    await call("Runtime.enable", {}, sessionId);
    console.log(JSON.stringify({ phase: "browser-attached" }));
    const deadline = Date.now() + 90000;
    let result;
    let lastProgress;
    while (Date.now() < deadline) {
      const response = await call("Runtime.evaluate", { expression: "window.terminalSmoke", returnByValue: true }, sessionId);
      result = response.result.value;
      const progress = result && JSON.stringify({ phase: "render-progress", status: result.status, rounds: result.rounds?.length });
      if (progress && progress !== lastProgress) { console.log(progress); lastProgress = progress; }
      if (result && result.status !== "running" && (result.status === "failed" || result.visualReady)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const screenshot = join(profile, "terminal-smoke.png");
    const capture = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
    await writeFile(screenshot, Buffer.from(capture.data, "base64"));
    console.log(JSON.stringify({ renderer: result, isolatedProfile: profile, screenshot }));
    if (result?.status !== "passed") process.exitCode = 1;
    await call("Browser.close");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    ws?.close();
    browser.kill();
    await server.close();
  }
}
