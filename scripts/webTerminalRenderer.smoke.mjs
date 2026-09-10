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
import { createTerminalStream } from '/apps/web/src/terminalStream.ts';
import { batchWebTerminalFrames } from '/src/lib/webTerminalFrames.ts';
const result = window.terminalSmoke = { status: 'running', errors: [], rounds: [], payloadBytes: 0, componentRenders: 0 };
const originalWrite = Terminal.prototype.write;
Terminal.prototype.write = function(...args) { result.writeCount = (result.writeCount || 0) + 1; return originalWrite.apply(this, args); };
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
function mount(id, data) {
  stream.start(id);
  result.componentRenders++;
  flushSync(() => root.render(React.createElement(WebTerminal, { sessionId: id, active: true, status: 'running', stream, controlMode: 'desktop', theme: 'dark', errorLabel: '终端错误 / Terminal error', scrollLabel: 'Scroll to bottom', onInput() {}, onResize() {} })));
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
        response.end(await vite.transformIndexHtml("/", '<!doctype html><html><head><meta charset="utf-8"><title>Terminal smoke</title><style>body{margin:0;background:#0b0d10;color:white}#root{height:700px;width:1200px}.web-terminal{height:100%;width:100%}</style></head><body><div id="root"></div><script type="module" src="/terminal-smoke.js"></script></body></html>'));
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
      if (result && result.status !== "running") break;
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
