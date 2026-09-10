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
import { Workbench } from '/apps/web/src/views.tsx';
import { MobileTerminalInput } from '/apps/web/src/MobileTerminalInput.tsx';
import { createTerminalStream } from '/apps/web/src/terminalStream.ts';
import { translate } from '/apps/web/src/i18n.ts';
import { useMobileViewport } from '/apps/web/src/useMobileViewport.ts';
import '/apps/web/src/styles.css';
document.documentElement.dataset.theme = 'dark';
const result = window.subagentSmoke = { status: 'running', errors: [], checks: [] };
window.addEventListener('error', event => result.errors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => result.errors.push(String(event.reason)));
const root = createRoot(document.getElementById('root'));
const stream = createTerminalStream(); stream.start('p1'); stream.start('p2');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, label) => { if (!condition) throw new Error(label); result.checks.push(label); };
const line = text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: text } }) + '\\n';
let agents = [
  { sessionId: 'a1', parentSessionId: 'p1', title: 'Reviewer A', sourceKind: 'child-jsonl', ended: false, content: line('## Review result\\n**Passed**\\n\\n\`safe code\`\\n\\n<script>window.unsafe=true</script>'), truncated: false },
  { sessionId: 'a2', parentSessionId: 'p1', title: 'Reviewer B', sourceKind: 'pending', ended: false, content: '', truncated: false },
  { sessionId: 'b1', parentSessionId: 'p2', title: 'Other parent', sourceKind: 'child-jsonl', ended: true, content: line('OTHER PARENT'), truncated: false },
];
const device = { id: 'device1', name: 'Test Desktop', status: 'online', capabilities: [], platform: 'windows', appVersion: '1.3.10', lastSeenAt: Date.now() };
let language = 'en-US', parent = 'p1', narrow = false, lastProps;
const noop = () => {};
function ViewportHarness(props) { useMobileViewport(); return React.createElement(Workbench, props); }
function render() {
  const props = {
    key: narrow ? 'narrow' : 'wide', restricted: false, sending: false, detailState: 'ready', t: key => translate(language, key), userName: 'Test',
    devices: [device], selectedDevice: device, history: [], workspace: { groups: [], projects: [], worktrees: [], subagents: agents, updatedAt: Date.now() },
    projectContexts: [{ key: 'x', projectKey: 'x', projectName: 'Project A', cwd: 'F:\\very-long-mobile-path\\workspace\\Project-A', source: 'codex', title: 'Project A', freshness: 'live' }, { key: 'y', projectKey: 'y', projectName: 'Project B', cwd: '/home/test/worktrees/project-b', source: 'codex', title: 'Project B', freshness: 'live' }], selectedProjectContext: { key: parent === 'p1' ? 'x' : 'y', projectKey: 'selected', projectName: 'Selected project', cwd: null, source: 'codex', title: 'Selected project', freshness: 'live' }, terminalSessionId: parent, terminalTabs: [{ sessionId: 'p1', contextKey: 'x', status: 'running', controlMode: 'desktop' }, { sessionId: 'p2', contextKey: 'y', status: 'running', controlMode: 'desktop' }],
    terminalStatus: 'running', terminalStream: stream, terminalControlMode: 'desktop', timeline: [], pairing: { phase: 'idle' }, socketState: 'open', latestSyncAt: null, resolvedTheme: 'dark',
    onTheme: noop, onLanguage: noop, onLogout: noop, onBackToHosts: noop, onRefresh: noop, onSelectDevice: noop, onSelectSession: noop, onSelectProjectContext: noop,
    onOpenTerminal: noop, onSelectTerminalTab: noop, onCloseTerminal: noop, onTerminalInput: () => true, onTerminalResize: () => true, onClaimPairing: async () => {}, onResetPairing: noop, onSubmitManagement: async () => {},
  };
  lastProps = props;
  flushSync(() => root.render(React.createElement(ViewportHarness, props)));
}
const panel = () => document.querySelector('.web-terminal-frame.active .web-subagent-panel');
const tabs = () => [...panel().querySelectorAll('[role=tab]')];
const parentPane = () => document.querySelector('.web-terminal-frame.active .web-terminal-shell');
function verifyEqualSplit(axis, label) {
  const main = parentPane().getBoundingClientRect();
  const child = panel().getBoundingClientRect();
  check(Math.abs(main[axis] - child[axis]) <= 2, label + ': parent and child split equally: ' + main[axis] + '/' + child[axis]);
}

function currentTerminal() {
  const host = document.querySelector('.web-terminal-frame.active .web-terminal');
  let fiber = host?.[Object.keys(host).find(key => key.startsWith('__reactFiber$'))];
  while (fiber) {
    let hook = fiber.memoizedState;
    while (hook && typeof hook === 'object') {
      const value = hook.memoizedState?.current;
      if (value?.buffer?.active && typeof value.write === 'function') return value;
      hook = hook.next;
    }
    fiber = fiber.return;
  }
}
let sequence = 0;
async function verifyGrid(cols, label) {
  const rows = 32;
  const text = '\\x1b[2J\\x1b[H> OpenAI Codex - parent terminal\\r\\n\\r\\nReviewing the project while subagents run.\\r\\nRead source, check boundaries, verify results.\\x1b[32;1H> LAST-ROW INPUT';
  stream.publish(parent, { sequence: ++sequence, frames: [{ kind: 'output', sequence, sequenceStart: true, sequenceEnd: true, cols, rows, data: btoa(text), replayBatchEnd: false }] });
  await pause(250);
  const host = document.querySelector('.web-terminal-frame.active .web-terminal');
  const screen = host.querySelector('.xterm-screen').getBoundingClientRect();
  const bounds = host.getBoundingClientRect();
  const terminal = currentTerminal();
  check(terminal?.cols === cols && terminal.rows === rows, label + ': desktop PTY grid preserved');
  check(screen.left >= bounds.left - 1 && screen.right <= bounds.right + 1 && screen.top >= bounds.top - 1 && screen.bottom <= bounds.bottom + 1, label + ': complete terminal grid stays inside parent pane');
  check(terminal.options.fontSize <= 14, label + ': no font magnification');
  check(terminal.buffer.active.getLine(terminal.buffer.active.baseY + rows - 1)?.translateToString(true).includes('LAST-ROW INPUT'), label + ': input row preserved');
}

async function wide() {
  render(); await pause(500);
  check(document.querySelector('.source-banner')?.textContent.includes('Project A') && document.querySelector('.terminal-cwd')?.textContent.includes('F:\\very-long-mobile-path\\workspace\\Project-A'), 'Status card identifies active terminal project and cwd');
  await verifyGrid(120, 'Wide 120 columns');
  await verifyGrid(60, 'Wide split 60 columns');
  check(panel()?.classList.contains('expanded'), 'Wide panel is expanded next to parent terminal');
  check(tabs().length === 2 && !panel().textContent.includes('Other parent'), 'Only children of selected parent appear');
  check(parseFloat(getComputedStyle(panel()).fontSize) === 14, 'Subagent text retains normal 14px size');
  check(panel().querySelector('h2')?.textContent === 'Review result' && panel().querySelector('.web-subagent-message strong')?.textContent, 'Real Markdown heading and role rendered');
  check(!window.unsafe && !panel().querySelector('script'), 'Transcript HTML does not execute');
  const terminal = document.querySelector('.web-terminal-frame.active .web-terminal').getBoundingClientRect();
  const rect = panel().getBoundingClientRect();
  check(rect.left >= terminal.right - 1, 'Wide parent and child panes do not overlap');
  verifyEqualSplit('width', 'Wide expanded');
  const expandedWidth = parentPane().getBoundingClientRect().width;
  panel().querySelector('header button').click(); await pause(100);
  check(panel().classList.contains('collapsed') && parentPane().getBoundingClientRect().width > expandedWidth * 1.5, 'Wide collapse restores parent width');
  panel().querySelector('header button').click(); await pause(100);
  verifyEqualSplit('width', 'Wide reopened');
  tabs()[1].click(); await pause(30);
  check(panel().textContent.includes('Waiting for the subagent transcript'), 'Pending child has waiting state');
  agents = agents.map(agent => agent.sessionId === 'a2' ? { ...agent, sourceKind: 'child-jsonl', content: line('STREAM UPDATE'), ended: true } : agent);
  render(); await pause(30);
  check(panel().textContent.includes('STREAM UPDATE') && panel().textContent.includes('Completed'), 'Content and completion update without reopening');
  language = 'zh-CN'; render(); await pause(30);
  check(panel().textContent.includes('只读转录') && panel().textContent.includes('已结束'), 'Chinese labels apply immediately');
  parent = 'p2'; render(); await pause(30);
  check(document.querySelector('.source-banner')?.textContent.includes('Project B') && document.querySelector('.terminal-cwd')?.textContent.includes('/home/test/worktrees/project-b'), 'Switching terminal updates project and worktree cwd');
  check(tabs().length === 1 && panel().textContent.includes('OTHER PARENT'), 'Switching parents selects the matching child panel');
  parent = 'p1'; agents = agents.filter(agent => agent.sessionId !== 'a2'); render(); await pause(30);
  check(tabs().length === 1 && panel().textContent.includes('Review result'), 'Removed selected child falls back to remaining child');
  result.status = 'narrow-ready';
}
window.runNarrow = async () => {
  try {
    narrow = true; render(); await pause(400);
    await verifyMobileProjects();
    await verifyDirectionPad();
    render(); await pause(100);
    check(innerWidth === 390, 'Narrow browser viewport applied');
    check(getComputedStyle(document.querySelector('.source-banner')).display === 'none', 'Mobile hides the verbose terminal status card');
    check(!document.querySelector('.mobile-terminal-context'), 'Mobile removes redundant project and cwd block');
    check(panel()?.classList.contains('collapsed'), 'Narrow child panel starts collapsed');
    const collapsedHeight = parentPane().getBoundingClientRect().height;
    panel().querySelector('header button').click(); await pause(150);
    await verifyGrid(120, 'Narrow 120 columns');
    await verifyGrid(60, 'Narrow split 60 columns');
    const terminal = document.querySelector('.web-terminal-frame.active .web-terminal').getBoundingClientRect();
    const rect = panel().getBoundingClientRect();
    check(rect.top >= terminal.bottom - 1 && rect.bottom <= innerHeight + 1, 'Expanded narrow child stacks below parent within viewport');
    verifyEqualSplit('height', 'Narrow expanded');
    panel().querySelector('header button').click(); await pause(100);
    check(Math.abs(parentPane().getBoundingClientRect().height - collapsedHeight) <= 2, 'Narrow collapse restores parent height');
    panel().querySelector('header button').click(); await pause(100);
    verifyEqualSplit('height', 'Narrow reopened');
    check(document.documentElement.scrollWidth <= innerWidth + 1, 'Child content does not force page horizontal overflow');
    agents = []; render(); await pause(50);
    check(!panel(), 'Removing all child sessions removes the panel');
    agents = [{ sessionId: 'a3', parentSessionId: 'p1', title: 'Reconnected', sourceKind: 'lifecycle-only', ended: false, content: '', truncated: false }];
    render(); await pause(30); if (panel().classList.contains('collapsed')) panel().querySelector('header button').click(); await pause(30);
    check(panel().querySelector('.web-subagent-transcript').getBoundingClientRect().height > 50, 'Reconnected lifecycle state is actually visible');
    check(panel().textContent.includes('当前仅有运行状态'), 'Reconnected snapshot restores lifecycle-only child state');
    agents = [{ ...agents[0], sourceKind: 'child-jsonl', content: line('## 子代理结果\\n检查完成，主终端输入区保持可见。\\n\\n- 字号正常\\n- 独立滚动'), ended: true }];
    render(); await pause(100);
    result.status = result.errors.length ? 'failed' : 'keyboard-ready';
  } catch(error) { result.errors.push(String(error)); result.status = 'failed'; }
};
async function verifyMobileProjects() {
  const contexts = [
    { key: 'project', projectId: 'project', projectName: 'Mobile project', source: 'codex', title: 'Project', freshness: 'live' },
    { key: 'worktree', projectId: 'project', worktreeId: 'wt', projectName: 'Mobile worktree', source: 'codex', title: 'Worktree', freshness: 'live' },
  ];
  let selected, started;
  let state = { ...lastProps, key: 'project-test', terminalSessionId: undefined, terminalTabs: [], terminalStatus: 'idle',
    projectContexts: contexts, selectedProjectContext: undefined,
    workspace: { groups: [], projects: [{ id: 'project', name: 'Mobile project', groupId: null, sortOrder: 0, source: 'codex' }], worktrees: [{ id: 'wt', projectId: 'project', name: 'Mobile worktree', branch: 'test', status: 'active' }], updatedAt: 1 },
    onSelectProjectContext: key => { selected = contexts.find(context => context.key === key); state.selectedProjectContext = selected; draw(); },
    onOpenTerminal: () => { started = selected?.key; },
  };
  const draw = () => flushSync(() => root.render(React.createElement(ViewportHarness, state)));
  const drawer = () => document.querySelector('.mobile-project-sidebar');
  const open = async () => { document.querySelector('.mobile-projects-toggle').click(); await pause(40); };
  draw(); await pause(50);
  check(getComputedStyle(document.querySelector('.sidebar')).display === 'none', 'Phone hides desktop sidebar');
  check(document.querySelector('.mobile-projects-toggle').getBoundingClientRect().width > 0, 'Phone project button exists with zero terminals');
  await open();
  check(drawer()?.getBoundingClientRect().width > 100, 'Phone opens visible project tree');
  check(drawer().closest('.drawer').getBoundingClientRect().right <= innerWidth + 1, 'Project drawer fits phone width');
  check(drawer().querySelector('.new-chat-button').disabled, 'No selected project disables launch');
  drawer().querySelector('.web-tree-label').click(); await pause(30);
  check(selected?.key === 'project', 'Project selection reaches existing callback');
  drawer().querySelector('.web-tree-worktree-main').click(); await pause(30);
  check(selected?.key === 'worktree', 'Worktree selection reaches existing callback');
  drawer().querySelector('.new-chat-button').click(); await pause(30);
  check(started === 'worktree' && drawer(), 'Launch uses worktree context and keeps drawer until terminal arrives');
  state.terminalTabs = [{ sessionId: 'created', contextKey: 'worktree', status: 'running', controlMode: 'desktop' }];
  state.terminalSessionId = 'created'; draw(); await pause(80);
  check(!drawer(), 'Running terminal snapshot closes project drawer');
  await open(); drawer().querySelector('.new-chat-button').click(); await pause(40);
  check(!drawer(), 'Opening existing terminal closes drawer');
  state.terminalTabs = []; state.terminalSessionId = undefined;
  state.selectedDevice = { ...device, status: 'offline' }; draw(); await pause(30); await open();
  check(drawer().querySelector('.new-chat-button').disabled && drawer().textContent.includes('Mobile project'), 'Offline projects remain browsable while launch disabled');
  document.querySelector('.drawer > header button').click(); await pause(30);
  check(!drawer(), 'Close button dismisses tree');
  state.selectedDevice = device; state.socketState = 'closed'; draw(); await pause(20); await open();
  check(drawer().querySelector('.new-chat-button').disabled, 'Disconnected browser cannot launch');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause(30);
  state.socketState = 'open'; state.workspace = { groups: [], projects: [], worktrees: [], updatedAt: 2 }; state.projectContexts = []; state.selectedProjectContext = undefined;
  state.t = key => translate('en-US', key); draw(); await pause(30); await open();
  check(document.querySelector('.drawer h2').textContent === 'Projects', 'English project drawer label');
  check(drawer().querySelector('.new-chat-button').disabled && drawer().querySelector('.secondary-button'), 'Empty projects retain disabled launch and refresh');
  document.querySelector('.overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await pause(30);
  check(!drawer(), 'Backdrop dismisses project drawer');
}
async function verifyDirectionPad() {
  const keys = [];
  let enabled = true, lang = 'zh-CN';
  const draw = () => flushSync(() => root.render(React.createElement(MobileTerminalInput, {
    enabled, t: key => translate(lang, key), onFocus: noop, onPaste: noop, onKey: key => keys.push(key),
  })));
  draw(); await pause(30);
  const toolbar = document.querySelector('.mobile-terminal-input-toolbar');
  const enter = toolbar.querySelector('.mobile-terminal-enter');
  check(toolbar.lastElementChild === enter && enter.getBoundingClientRect().right <= innerWidth, 'Enter fixed at right edge on phone');
  check(!document.querySelector('.mobile-direction-pad'), 'Direction pad initially collapsed');
  const toggle = () => document.querySelector('.mobile-direction-toggle');
  toggle().click(); await pause(30);
  let pad = document.querySelector('.mobile-direction-pad');
  check(pad?.querySelectorAll('button').length === 4, 'Single direction button opens four arrows');
  const bounds = pad.getBoundingClientRect();
  check(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0, 'Direction pad fits viewport');
  [...document.querySelectorAll('.mobile-terminal-input-tools button')].find(button => button.textContent === '备用输入').click(); await pause(30);
  const input = document.querySelector('textarea'); input.focus();
  for (const direction of ['up', 'left', 'right', 'down']) {
    const button = pad.querySelector('.direction-' + direction);
    const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    check(!button.dispatchEvent(pointer), 'Arrow prevents pointer focus theft: ' + direction);
    button.click(); await pause(10);
  }
  check(keys.join('|') === ['\\x1b[A', '\\x1b[D', '\\x1b[C', '\\x1b[B'].join('|'), 'Direction keys send standard terminal bytes');
  check(document.querySelector('.mobile-direction-pad') && document.activeElement === input, 'Repeated arrows keep pad open and input focus');
  enter.click(); check(keys.at(-1) === '\\r', 'Right Enter sends carriage return');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await pause(30);
  check(!document.querySelector('.mobile-direction-pad'), 'Outside tap closes direction pad');
  toggle().click(); await pause(20); enabled = false; draw(); await pause(30);
  check(!document.querySelector('.mobile-direction-pad') && toggle().disabled && document.querySelector('.mobile-terminal-enter').disabled, 'Inactive or disconnected terminal closes pad and disables keys');
  enabled = true; lang = 'en-US'; draw(); await pause(20);
  check(toggle().textContent === 'Arrows', 'Direction control has English label');
  toggle().click(); await pause(20); window.dispatchEvent(new Event('resize')); await pause(20);
  check(!document.querySelector('.mobile-direction-pad'), 'Viewport change dismisses pad');
  lang = 'zh-CN'; draw(); await pause(20);
  document.querySelector('.mobile-terminal-input-collapse').click(); await pause(30);
  check(document.querySelector('.mobile-terminal-input.collapsed') && !document.querySelector('.mobile-terminal-input-toolbar'), 'Toolbar collapses to a single floating control');
  check(document.querySelector('.mobile-terminal-input-expand').getAttribute('aria-label') === '展开操作栏', 'Collapsed control has Chinese accessible label');
  draw(); await pause(20);
  check(document.querySelector('.mobile-terminal-input.collapsed'), 'Collapsed preference survives component remount');
  document.querySelector('.mobile-terminal-input-expand').click(); await pause(20);
  check(document.querySelector('.mobile-terminal-input-toolbar'), 'Floating control restores toolbar');
  check(localStorage.getItem('cli-manager.web.mobile-toolbar-collapsed') === 'false', 'Expanded preference is persisted');
}
window.runKeyboard = async () => {
  try {
    const visual = window.visualViewport;
    check(visual, 'Visual viewport API available');
    currentTerminal().focus();
    Object.defineProperties(visual, { height: { configurable: true, value: 440 }, offsetTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    visual.dispatchEvent(new Event('resize'));
    await pause(250);
    check(document.documentElement.dataset.mobileKeyboard === 'true', 'Focused terminal marks reduced visual viewport as keyboard-open');
    check(document.documentElement.style.getPropertyValue('--mobile-viewport-height') === '440px', 'Real mobile hook applies visual viewport height');
    check(document.querySelector('.app-shell').getBoundingClientRect().bottom <= 441, 'Keyboard-open application shell remains within visual viewport');
    const main = parentPane().getBoundingClientRect();
    const child = panel().getBoundingClientRect();
    check(main.height > 0 && child.height > 0 && main.top >= -1 && child.bottom <= 441, 'Keyboard-open parent and child remain inside visible viewport');
    verifyEqualSplit('height', 'Keyboard-open expanded');
    check(document.documentElement.scrollWidth <= innerWidth + 1, 'Keyboard viewport does not add horizontal overflow');
    panel().querySelector('header button').click(); await pause(100);
    const restored = parentPane().getBoundingClientRect();
    check(restored.height > main.height && restored.bottom <= 441, 'Keyboard-open collapse restores usable parent space');
    panel().querySelector('header button').click(); await pause(100);
    delete visual.height; delete visual.offsetTop; delete visual.scale;
    visual.dispatchEvent(new Event('resize')); await pause(200);
    check(document.documentElement.dataset.mobileKeyboard === 'false' && panel().getBoundingClientRect().bottom <= innerHeight + 1, 'Keyboard dismissal restores normal viewport');
    verifyEqualSplit('height', 'Keyboard dismissed');
    result.status = result.errors.length ? 'failed' : 'landscape-ready';
  } catch(error) { result.errors.push(String(error)); result.status = 'failed'; }
};
window.runLandscape = async () => {
  try {
    await pause(250);
    check(innerWidth === 844 && innerHeight === 390, 'Landscape mobile viewport applied');
    verifyEqualSplit('height', 'Landscape expanded');
    check(panel().getBoundingClientRect().bottom <= 391, 'Landscape child remains inside viewport');
    const visual = window.visualViewport;
    currentTerminal().focus();
    Object.defineProperties(visual, { height: { configurable: true, value: 240 }, offsetTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    visual.dispatchEvent(new Event('resize')); await pause(200);
    check(document.documentElement.dataset.mobileKeyboard === 'true', 'Landscape reduced viewport detects keyboard');
    const keyboardGeometry = { app: document.querySelector('.app-shell').getBoundingClientRect().toJSON(), parent: parentPane().getBoundingClientRect().toJSON(), child: panel().getBoundingClientRect().toJSON(), workspace: document.querySelector('.terminal-workspace').getBoundingClientRect().toJSON() };
    result.landscapeKeyboardGeometry = keyboardGeometry;
    check(keyboardGeometry.app.bottom <= 241 && keyboardGeometry.child.bottom <= 241, 'Landscape keyboard keeps application and child within visual viewport: ' + JSON.stringify(keyboardGeometry));
    verifyEqualSplit('height', 'Landscape keyboard expanded');
    panel().querySelector('header button').click(); await pause(100);
    check(parentPane().getBoundingClientRect().height > 0 && parentPane().getBoundingClientRect().bottom <= 241, 'Landscape keyboard collapsed parent remains usable');
    delete visual.height; delete visual.offsetTop; delete visual.scale;
    visual.dispatchEvent(new Event('resize')); await pause(200);
    result.status = result.errors.length ? 'failed' : 'passed';
  } catch(error) { result.errors.push(String(error)); result.status = 'failed'; }
};
wide().catch(error => { result.errors.push(String(error)); result.status = 'failed'; });
`;

const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@xterm/xterm", "@xterm/addon-fit", "react-markdown", "remark-gfm"] },
  esbuild: { jsx: "automatic" },
  plugins: [{
    name: "isolated-terminal-renderer-smoke",
    resolveId(id) { if (id === "/subagent-smoke.js") return "\0subagent-smoke"; },
    load(id) { if (id === "\0subagent-smoke") return harness; },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await vite.transformIndexHtml("/", '<!doctype html><html><head><meta charset="utf-8"><title>Subagent smoke</title><style>body{margin:0;background:#0b0d10;color:white}#root{height:100dvh;width:100%}</style></head><body><div id="root"></div><script type="module" src="/subagent-smoke.js"></script></body></html>'));
      });
    },
  }],
  server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
});
await server.listen();
console.log(JSON.stringify({ url: server.resolvedUrls.local[0], readResult: "window.subagentSmoke" }));
async function stop() { await server.close(); process.exit(0); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (process.argv.includes("--run")) {
  const profile = await mkdtemp(join(tmpdir(), "cli-manager-subagent-smoke-"));
  const browser = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new", "--window-size=1440,1000", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
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
      const response = await call("Runtime.evaluate", { expression: "window.subagentSmoke", returnByValue: true }, sessionId);
      result = response.result.value;
      const progress = result && JSON.stringify({ phase: "render-progress", status: result.status, rounds: result.rounds?.length });
      if (progress && progress !== lastProgress) { console.log(progress); lastProgress = progress; }
      if (result?.status === "narrow-ready") {
        const wideCapture = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
        const wideScreenshot = join(profile, "subagent-wide.png");
        await writeFile(wideScreenshot, Buffer.from(wideCapture.data, "base64"));
        console.log(JSON.stringify({ wideScreenshot }));
        await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId);
        await call("Runtime.evaluate", { expression: "window.subagentSmoke.status = 'running'; window.runNarrow()" }, sessionId);
      } else if (result?.status === "keyboard-ready") {
        const narrowCapture = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
        const narrowScreenshot = join(profile, "subagent-narrow.png");
        await writeFile(narrowScreenshot, Buffer.from(narrowCapture.data, "base64"));
        console.log(JSON.stringify({ narrowScreenshot }));
        await call("Runtime.evaluate", { expression: "window.subagentSmoke.status = 'running'; window.runKeyboard()" }, sessionId);
      } else if (result?.status === "landscape-ready") {
        await call("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 1, mobile: false }, sessionId);
        await call("Runtime.evaluate", { expression: "window.subagentSmoke.status = 'running'; window.runLandscape()" }, sessionId);
      } else if (result && result.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const screenshot = join(profile, "subagent-smoke.png");
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
