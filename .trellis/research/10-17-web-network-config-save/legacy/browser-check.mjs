// Use installed Edge in an isolated headless profile; fixtures never reach the user's Web service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const base = process.argv[2];
assert.ok(base?.startsWith("http://127.0.0.1:"));
const taskDir = path.dirname(fileURLToPath(import.meta.url));
const profile = await mkdtemp(path.join(os.tmpdir(), "cli-manager-web-check-"));
const browser = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { windowsHide: true, stdio: "ignore" });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let sequence = 0;
const pending = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
  pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, method, params, sessionId }));
});
try {
  let connection;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { connection = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/); break; }
    catch { await delay(100); }
  }
  assert.ok(connection, "Edge exposes a debugging endpoint");
  socket = new WebSocket(`ws://127.0.0.1:${connection[0]}${connection[1]}`);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const flight = pending.get(message.id);
    if (!flight) return;
    pending.delete(message.id);
    if (message.error) flight.reject(new Error(message.error.message));
    else flight.resolve(message.result);
  });
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params = {}) => cdp(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(100);
    }
    throw new Error(`Page condition timed out: ${expression}`);
  };
  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page("Page.navigate", { url: base });
  await waitFor("document.querySelectorAll('.tap-project-group').length === 3");
  const info = await evaluate(`({
    groups: [...document.querySelectorAll('.tap-project-group > .tap-folder-row')].map(el => el.textContent),
    paths: [...document.querySelectorAll('.tap-folder-label small')].map(el => el.textContent),
    projects: document.querySelectorAll('.tap-folder-label').length,
    expanded: [...document.querySelectorAll('.tap-folder-toggle[aria-expanded="true"]')].map(el =>
      el.querySelector('.tap-folder-name, .tap-folder-label b').textContent),
    nested: document.querySelector('.tap-project-group .tap-project-group') !== null,
    overflow: document.querySelector('.tap-sidebar').scrollWidth > document.querySelector('.tap-sidebar').clientWidth
  })`);
  assert.equal(info.projects, 3);
  assert.equal(info.paths.length, 2);
  assert.deepEqual(info.expanded, ["开发项目", "CLI-Manager"]);
  assert.equal(info.nested, true);
  assert.equal(info.overflow, false);
  await mkdir(path.join(taskDir, "screenshots"), { recursive: true });
  const screenshot = async (name) => {
    const result = await page("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(taskDir, "screenshots", name), Buffer.from(result.data, "base64"));
  };
  await screenshot("tap-projects-desktop.png");
  // Open inactive groups manually to measure icons alongside long paths at deeper nesting.
  await evaluate(`document.querySelectorAll('.tap-project-group > .tap-folder-row > button[aria-expanded="false"]').forEach(button => button.click())`);
  await waitFor("document.querySelectorAll('.tap-folder-label').length === 5");
  await delay(200);
  const iconGeometry = async () => evaluate(`([...document.querySelectorAll('.tap-folder-toggle > .tap-agent-glyph')].map(el => {
    const box = el.getBoundingClientRect(), svg = el.querySelector('svg').getBoundingClientRect();
    const label = el.nextElementSibling.getBoundingClientRect();
    return { width: box.width, height: box.height, svgWidth: svg.width, labelGap: label.left - box.right };
  }))`);
  const assertIcons = (icons) => {
    assert.ok(icons.length >= 3);
    for (const icon of icons) {
      assert.ok(icon.width >= 15 && icon.height >= 15 && icon.svgWidth >= 15, JSON.stringify(icon));
      assert.ok(icon.labelGap >= 5, JSON.stringify(icon));
    }
  };
  assertIcons(await iconGeometry());
  await screenshot("tap-project-icons-expanded.png");
  await evaluate(`(() => {
    const input = document.querySelector('.tap-search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '/home/dev');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("document.querySelectorAll('.tap-folder-label').length === 1");
  assert.equal(await evaluate("document.querySelector('.tap-folder-label small').textContent"), "/home/dev/smart-home-assistant");
  await evaluate(`(() => {
    const input = document.querySelector('.tap-search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.tap-sidebar-tools button').click();
  })()`);
  await waitFor("document.querySelectorAll('.tap-picker-group').length === 3");
  await screenshot("tap-project-picker.png");
  await page("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page("Page.navigate", { url: base });
  await waitFor("document.querySelector('.tap-empty-bar button') || document.querySelector('[aria-label=\"打开会话导航\"]')");
  await evaluate("document.querySelector('[aria-label=\"打开会话导航\"]').click()");
  await waitFor("document.querySelectorAll('.tap-project-group').length === 3");
  await delay(400);
  assertIcons(await iconGeometry());
  assert.equal(await evaluate("document.querySelectorAll('.tap-folder-toggle[aria-expanded=\"true\"]').length"), 2);
  await screenshot("tap-projects-mobile.png");
  console.log(JSON.stringify({ result: "pass", ...info, icons: "full 15px glyphs without text overlap", search: "path finds an empty project", picker: "nested groups rendered", mobile: "active path only" }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) await cdp("Browser.close").catch(() => {});
  socket?.close();
  await delay(500);
  if (browser.exitCode === null) browser.kill();
  // Only remove the exact temp profile this script created, after verifying its absolute parent.
  if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith("cli-manager-web-check-")) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }).catch(() => {});
  }
}
