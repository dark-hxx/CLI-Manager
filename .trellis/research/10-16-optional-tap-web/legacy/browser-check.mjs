// Controlled browser acceptance host: no Tauri app, real CLI, credentials or model calls.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.TAP_PLAYWRIGHT_MODULE || "playwright");
const { WebSocketServer } = await import(process.env.TAP_WS_MODULE || "ws");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dist = path.join(root, "apps/web/dist");
const evidence = path.join(root, ".impeccable/review");
await mkdir(evidence, { recursive: true });
let authenticated = false;
let eventSequence = 0;
let chunkSequence = 0;
let outputSequence = 0;
let created = 0;
let deviceScope;
let redeems = 0;
let holdStart = false;
let finishStart;
let holdHistory401 = false;
let finishHistory401;
const inputLog = [];
const commandLog = [];
const requestLog = [];
const operations = new Map();
const clients = new Set();
const workspace = {
  groups: [], projects: [
    { id: "project-a", name: "CLI-Manager", source: "claude", cwd: "/workspace/CLI-Manager", environmentType: "local", sortOrder: 0, groupId: null },
    { id: "project-b", name: "Design notes", source: "codex", cwd: "/workspace/design-notes", environmentType: "local", sortOrder: 1, groupId: null },
  ], worktrees: [], terminals: [
    { sessionId: "pty-a", projectId: "project-a", worktreeId: null, title: "完善移动工作台" },
    { sessionId: "pty-b", projectId: "project-a", worktreeId: null, title: "检查会话接力" },
  ], updatedAt: 1,
};
const devices = ["device-a", "device-b"].map((id, index) => ({
  id, name: index ? "Spare host" : "Studio", clientId: id, machineId: id, clientKind: "release", platform: "linux", appVersion: "1.4.4",
  status: "online", capabilities: ["terminal.transcript", "project.management", "conversation", "file.management", "git.management"],
  hostInfo: null, wallpaperRevision: null, lastSeenAt: Date.now(), pairedAt: Date.now(),
}));
const transcript = {
  available: true, cliSessionId: "cli-a", start: 0, total: 2,
  messages: [
    { id: "cli-a:0", role: "user", text: "把移动工作台的输入和会话切换做好，保留原生终端的行为。" },
    { id: "cli-a:1", role: "assistant", model: "Claude", at: "2026-10-16T19:30:00Z", text:
      "会话切换和输入已经接通。\n\n### 这次调整\n\n- 草稿按设备和会话保存，切换后继续写。\n- 中文输入法确认候选字时不会发送。\n- 终端与对话共用同一个原生 CLI。\n\n```ts\nconst next = await continueSession(projectId);\n```\n\n你可以继续输入，也可以切回终端操作权限菜单。" },
  ],
};
const send = (ws, value) => { if (ws.readyState === 1) ws.send(JSON.stringify(value)); };
const event = (payload) => { for (const ws of clients) send(ws, { type: "event", sequence: ++eventSequence, occurredAt: Date.now(), payload }); };
const output = (ws, deviceId, sessionId, text) => send(ws, { type: "terminal_output", deviceId, sessionId, sequence: ++chunkSequence,
  frames: [{ sequence: ++outputSequence, kind: "output", cols: 80, rows: 24, data: Buffer.from(text).toString("base64"), replayBatchEnd: false }] });
const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
const launch = (data) => {
  assert.equal(data.payload.launchMode, "internal");
  const sessionId = `pty-created-${++created}`;
  workspace.terminals.push({ sessionId, projectId: data.payload.targetId, worktreeId: null, title: "新的 CLI 会话" });
  workspace.updatedAt++; event({ type: "workspace.updated", deviceId: data.deviceId, workspace });
  return { sessionIds: [sessionId] };
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    let body = ""; for await (const part of req) body += part;
    const data = body ? JSON.parse(body) : {};
    if (url.pathname === "/api/auth/status") return json(res, { authenticated, user: authenticated ? { id: "test-user", username: "reviewer" } : null, deviceScope });
    if (url.pathname === "/api/auth/login") { authenticated = true; deviceScope = undefined; return json(res, { authenticated, user: { id: "test-user", username: "reviewer" } }); }
    if (url.pathname === "/api/auth/logout") { authenticated = false; return json(res, { ok: true }); }
    if (url.pathname === "/api/mobile/redeem") {
      assert.equal(data.token, "fixture-ticket");
      redeems++; authenticated = true; deviceScope = "device-b";
      return json(res, { authenticated, user: { id: "test-user", username: "reviewer" }, deviceScope });
    }
    if (!authenticated) return json(res, { error: { code: "unauthorized" } }, 401);
    if (url.pathname === "/api/devices") return json(res, { devices });
    if (url.pathname === "/api/history") {
      if (holdHistory401 && url.searchParams.get("deviceId") === "device-a") {
        holdHistory401 = false;
        res.writeHead(401, { "Content-Type": "application/json" }); res.flushHeaders();
        finishHistory401 = () => res.end(JSON.stringify({ error: { code: "unauthorized" } }));
        return;
      }
      return json(res, { items: [], nextOffset: null, workspace });
    }
    if (url.pathname.startsWith("/api/operations/")) return json(res, { operation: operations.get(url.pathname.split("/").at(-1)) });
    if (url.pathname === "/api/operations") {
      requestLog.push(data);
      assert.equal("cwd" in data.payload, false); assert.equal("rootPath" in data.payload, false);
      if (data.kind === "project.start" && holdStart) {
        holdStart = false;
        const operation = { ...data, id: `operation-${operations.size}`, status: "running", result: null, error: null, createdAt: Date.now(), updatedAt: Date.now() };
        operations.set(operation.id, operation);
        finishStart = () => {
          const completed = { ...operation, status: "succeeded", result: launch(data) };
          operations.set(operation.id, completed); event({ type: "operation.updated", operation: completed });
        };
        return json(res, { operation });
      }
      let result = null;
      if (data.kind === "project.start") {
        result = launch(data);
      } else if (data.kind === "terminal.transcript") result = transcript;
      else if (data.kind === "file.list") result = [{ name: "README.md", path: "README.md", kind: "file" }, { name: "src", path: "src", kind: "directory" }];
      else if (data.kind === "file.read_text") result = { content: "# CLI-Manager\n\nControlled fixture content." };
      else if (data.kind === "git.status") result = { changes: [{ path: "src/workspace.tsx", status: "M", staged: false, added: 12, deleted: 3 }], branch: { branch: "feat/optional-tap-web", ahead: 1, behind: 0, detached: false } };
      else if (data.kind === "terminal.attach_image") result = { delivery: "browser_paste", sessionId: data.payload.sessionId, pasteText: "'.cli-manager/uploads/test.jpg'" };
      const operation = { ...data, id: `operation-${operations.size}`, status: "succeeded", result, error: null, createdAt: Date.now(), updatedAt: Date.now() };
      operations.set(operation.id, operation);
      event({ type: "operation.updated", operation });
      return setTimeout(() => json(res, { operation }), 30);
    }
    return json(res, {}, 404);
  }
  const relative = url.pathname.replace(/^\/+/, "");
  const target = path.resolve(dist, relative);
  if (!target.startsWith(dist + path.sep) && target !== dist) { res.writeHead(403).end(); return; }
  let bytes;
  let file = target;
  try { bytes = await readFile(file); }
  catch { file = url.pathname.startsWith("/tap") ? path.join(dist, "tap/index.html") : path.join(dist, "index.html"); bytes = await readFile(file); }
  const mime = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
  res.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "text/html" }); res.end(bytes);
});
const sockets = new WebSocketServer({ server, path: "/ws/browser" });
sockets.on("connection", (ws) => {
  clients.add(ws); send(ws, { type: "ready", latestSequence: eventSequence });
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const command = message.command;
    commandLog.push(message);
    if (command?.type === "attach") {
      send(ws, { type: "terminal_status", deviceId: message.deviceId, sessionId: command.sessionId, status: "running", controlMode: "desktop", cols: 80, rows: 24 });
      output(ws, message.deviceId, command.sessionId, "\x1b[?2004h\x1b[38;5;141mClaude Code\x1b[0m\r\n\r\n/workspace/CLI-Manager\r\n\r\n  Mobile workspace is ready.\r\n  中文输入与原生终端已连接。\r\n\r\n❯ ");
    }
    if (command?.type === "input") inputLog.push({ deviceId: message.deviceId, sessionId: command.sessionId, data: command.data });
    if (command?.type === "close") send(ws, { type: "terminal_status", deviceId: message.deviceId, sessionId: command.sessionId, status: "exited", controlMode: "web" });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.TAP_CHROMIUM, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Desktop hides the key strip by default; this run drives it, as a phone would.
  await page.addInitScript(() => { if (!localStorage.getItem("cli-manager.tap.preferences")) localStorage.setItem("cli-manager.tap.preferences", JSON.stringify({ keys: true })); });
  const errors = []; page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/tap/`);
  await page.getByLabel("用户名", { exact: true }).fill("reviewer");
  await page.getByLabel("密码", { exact: true }).fill("fixture-only");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "完善移动工作台", exact: true }).click();
  await page.locator(".xterm-screen").waitFor();
  await page.waitForTimeout(500);
  const input = page.getByRole("textbox", { name: "会话输入", exact: true });
  await input.fill("keep this draft");
  await page.getByRole("button", { name: "检查会话接力", exact: true }).click();
  await input.fill("reconnect this draft");
  await page.reload();
  await input.waitFor();
  assert.equal(await page.locator(".tap-nav-row[aria-current=page]").innerText(), "检查会话接力");
  assert.equal(await input.inputValue(), "reconnect this draft");
  // Keep a deep link from initial load, then select another session before reconnect.
  await page.getByRole("button", { name: "完善移动工作台", exact: true }).click();
  // A real transport reconnect must not replay input or discard the active draft.
  const inputBeforeReconnect = inputLog.length;
  for (const socket of clients) socket.terminate();
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await input.waitFor();
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".tap-nav-row[aria-current=page]").innerText(), "完善移动工作台");
  assert.equal(await input.inputValue(), "keep this draft");
  assert.equal(inputLog.length, inputBeforeReconnect);
  await input.fill("任务一\n任务二");
  const before = inputLog.length;
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, ctrlKey: true });
  assert.equal(inputLog.length, before);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(inputLog.at(-2).data, "\x1b[200~任务一\n任务二\x1b[201~"); assert.equal(inputLog.at(-1).data, "\r");
  await page.getByRole("button", { name: "Shift+Tab", exact: true }).click();
  assert.equal(inputLog.at(-1).data, "\x1b[Z");
  await page.getByRole("button", { name: "Ctrl 修饰键", exact: true }).click();
  await page.getByRole("button", { name: "上", exact: true }).click();
  assert.equal(inputLog.at(-1).data, "\x1b[1;5A");
  await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await page.getByText("这次调整", { exact: true }).waitFor();
  await input.fill("send from chat"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(200); assert.equal(inputLog.at(-1).data, "\r");
  assert.equal(await input.inputValue(), "");
  await page.screenshot({ path: path.join(evidence, "desktop-chat.png"), fullPage: true });
  await page.getByRole("button", { name: "打开右侧栏（详情、改动、文件）", exact: true }).click();
  await page.getByRole("tab", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await page.getByText("Controlled fixture content.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "收起右侧栏", exact: true }).last().click();
  const settings = async (more, item) => {
    await page.locator(".tap-session.is-visible").getByRole("button", { name: more, exact: true }).click();
    await page.getByRole("menuitem", { name: item, exact: true }).click();
  };
  await settings("更多操作", "设置");
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await page.getByRole("radio", { name: "English", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator("html").getAttribute("lang"), "en-US");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await settings("More actions", "Settings");
  await page.getByRole("radio", { name: "简体中文", exact: true }).click();
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForTimeout(250);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "终端", exact: true }).click();
  await page.locator(".tap-terminal-reader:not([hidden])").waitFor();
  assert.ok(await page.evaluate(() => document.fonts.check('13px "Tap Mono"')));
  assert.equal(commandLog.some((message) => message.command?.type === "resize"), false, "desktop geometry must remain authoritative");
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "打开会话导航", exact: true }).click();
  await page.getByRole("dialog", { name: "会话", exact: true }).waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidence, "mobile-drawer.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await page.screenshot({ path: path.join(evidence, "mobile-chat.png"), fullPage: true });
  await input.fill("phone line"); await input.press("Enter");
  assert.equal(await input.inputValue(), "phone line\n");
  // A synthetic visual-viewport contraction checks our geometry writes, not a real mobile keyboard.
  const viewportCheck = await page.evaluate(async () => {
    const visual = window.visualViewport;
    const content = document.querySelector(".tap-session.is-visible .tap-session-content");
    const originalHeight = content.getBoundingClientRect().height;
    const properties = ["height", "offsetTop", "scale"];
    const saved = properties.map((key) => Object.getOwnPropertyDescriptor(visual, key));
    Object.defineProperties(visual, {
      height: { configurable: true, value: innerHeight - 280 },
      offsetTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 },
    });
    visual.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const lifted = document.querySelector(".tap-app").style.top;
    const stable = content.getBoundingClientRect().height === originalHeight;
    document.activeElement.blur();
    const reset = document.querySelector(".tap-app").style.top;
    properties.forEach((key, index) => saved[index] ? Object.defineProperty(visual, key, saved[index]) : delete visual[key]);
    visual.dispatchEvent(new Event("resize"));
    return { lifted, stable, reset };
  });
  assert.deepEqual(viewportCheck, { lifted: "-280px", stable: true, reset: "" });
  await page.locator(".tap-session.is-visible").getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "结束会话…", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  // Repeating native keys stop immediately on cancellation; the key strip belongs to the terminal view.
  await page.getByRole("tab", { name: "终端", exact: true }).click();
  const up = page.getByRole("button", { name: "上", exact: true });
  const upBox = await up.boundingBox();
  await page.mouse.move(upBox.x + upBox.width / 2, upBox.y + upBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(520);
  await up.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  const stopped = inputLog.length;
  await page.waitForTimeout(180); assert.equal(inputLog.length, stopped);
  // Starting is a native project operation, never a browser cwd or command.
  await page.getByRole("button", { name: "打开会话导航", exact: true }).click();
  await page.getByRole("button", { name: "新建会话 · Design notes", exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith("#/s/pty-created-"));
  // Status reads (Git branch, transcript) may follow; the last command is still the native start.
  assert.equal(requestLog.filter((request) => !["git.status", "file.list", "terminal.transcript"].includes(request.kind)).at(-1).kind, "project.start");
  await input.fill("device-a private draft");
  await page.getByRole("button", { name: "打开会话导航", exact: true }).click();
  await page.getByRole("button", { name: /^执行设备/ }).click();
  await page.getByRole("menuitemradio", { name: /Spare host/ }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  assert.notEqual(await input.inputValue().catch(() => ""), "device-a private draft");
  await page.goto(`${base}/tap/#mobileToken=fixture-ticket`);
  await page.getByRole("button", { name: "确认连接", exact: true }).waitFor();
  assert.equal(redeems, 0, "opening a ticket must not redeem automatically");
  assert.equal(new URL(page.url()).hash, "");
  await page.getByRole("button", { name: "确认连接", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector(".tap-app")));
  assert.equal(redeems, 1);
  assert.equal(await page.locator(".tap-drawer.is-left.is-open").count(), 0, "phone navigation remains closed");
  await page.getByRole("button", { name: "打开会话导航", exact: true }).first().click();
  assert.equal(await page.getByRole("button", { name: /^执行设备/ }).isDisabled(), true, "a scoped ticket offers one device");
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  assert.equal(await page.locator(".tap-terminal-screen").count(), 0);
  await page.getByLabel("用户名", { exact: true }).fill("reviewer");
  await page.getByLabel("密码", { exact: true }).fill("fixture-only");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "打开会话导航", exact: true }).first().waitFor();
  for (const socket of clients) socket.close(4401, "expired");
  await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  assert.equal(await page.locator(".tap-terminal-screen").count(), 0);
  assert.equal(commandLog.some((message) => message.command?.type === "close"), false, "cancel/end/logout never terminate a process");
  assert.equal(requestLog.some((request) => request.kind.startsWith("conversation.")), false, "chat input stays in the native PTY");
  // Detailed pre-commit review: drive production xterm, not a terminal mock.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("用户名", { exact: true }).fill("reviewer");
  await page.getByLabel("密码", { exact: true }).fill("fixture-only");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "完善移动工作台", exact: true }).click();
  await page.locator(".tap-session.is-visible .xterm-screen").waitFor();
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.tapFixtureTerminal = () => {
      const host = document.querySelector(".tap-session.is-visible .tap-terminal");
      let fiber = host?.[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))];
      for (; fiber; fiber = fiber.return) {
        for (let hook = fiber.memoizedState; hook && typeof hook === "object"; hook = hook.next) {
          const current = hook.memoizedState?.current;
          if (current?.buffer?.active && typeof current.write === "function") return current;
        }
      }
    };
    window.tapFixtureText = () => {
      const buffer = window.tapFixtureTerminal()?.buffer.active;
      return buffer ? Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n") : "";
    };
    const terminal = window.tapFixtureTerminal();
    if (!terminal) throw Error("production terminal unavailable");
    const write = terminal.write;
    window.tapFixtureWrites = 0;
    terminal.write = function (...args) { window.tapFixtureWrites++; return write.apply(this, args); };
  });
  for (const socket of clients) {
    for (let batch = 0; batch < 51; batch++) {
      const count = batch === 50 ? 1 : 100;
      send(socket, { type: "terminal_output", deviceId: "device-a", sessionId: "pty-a", sequence: ++chunkSequence,
        frames: Array.from({ length: count }, () => ({ sequence: ++outputSequence, kind: "output", cols: 80, rows: 24,
          data: Buffer.from(batch === 50 ? "TAP BURST FINAL\r\n" : "live burst\r\n").toString("base64"), replayBatchEnd: false })) });
    }
  }
  await page.waitForFunction(() => window.tapFixtureText().includes("TAP BURST FINAL"), null, { timeout: 5000 });
  assert.ok(await page.evaluate(() => window.tapFixtureWrites <= 64), "Tap must batch live output, not write once per frame");
  const burstWrites = await page.evaluate(() => window.tapFixtureWrites);
  // A late project launch must not retarget an already-open process-close confirmation.
  holdStart = true;
  await page.getByRole("button", { name: "新建会话 · Design notes", exact: true }).click();
  await page.locator(".tap-session.is-visible").getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "结束会话…", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  const closesBefore = commandLog.filter((message) => message.command?.type === "close").length;
  assert.equal(typeof finishStart, "function"); finishStart();
  await page.waitForFunction(() => location.hash.startsWith("#/s/pty-created-"));
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole("alertdialog").count(), 0, "switching sessions dismisses the confirmation instead of retargeting it");
  assert.equal(commandLog.filter((message) => message.command?.type === "close").length, closesBefore);
  await page.getByRole("button", { name: "完善移动工作台", exact: true }).click();
  await page.locator(".tap-session.is-visible").getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "结束会话…", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "结束进程", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(commandLog.findLast((message) => message.command?.type === "close").command.sessionId, "pty-a");
  // Canceling a ticket must restore the old native screen, not only its empty renderer.
  await input.fill("keep after authorization cancellation");
  await page.goto(`${base}/tap/#mobileToken=fixture-ticket`);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(() => window.tapFixtureText().includes("Mobile workspace is ready."), null, { timeout: 5000 });
  assert.equal(await input.inputValue(), "keep after authorization cancellation");
  // Keep a real old model callback, then switch scope as an async input/image completion can do.
  await page.evaluate(() => {
    const host = document.querySelector(".tap-session.is-visible");
    let fiber = host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))];
    for (; fiber; fiber = fiber.return) {
      if (fiber.memoizedProps?.model?.input) { window.tapOldModel = fiber.memoizedProps.model; break; }
    }
    if (!window.tapOldModel) throw Error("workspace model unavailable");
  });
  await page.getByRole("button", { name: /^执行设备/ }).click();
  await page.getByRole("menuitemradio", { name: /Spare host/ }).click();
  await page.waitForTimeout(350);
  const commandsBeforeStale = commandLog.length;
  const acceptedStale = await page.evaluate(() => {
    const model = window.tapOldModel;
    const accepted = model.input(model.activeId, "stale input");
    model.resize(model.activeId, 100, 30); model.end(model.activeId);
    return accepted;
  });
  await page.waitForTimeout(50);
  assert.equal(acceptedStale, false, "old-scope input must be rejected before sending");
  assert.equal(commandLog.length, commandsBeforeStale, "old resize/close must not target a new device");
  // Escape belongs to an IME candidate/child control before the surrounding sheet.
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.dispatchEvent("keydown", { key: "Escape", isComposing: true });
  assert.equal(await dialog.isVisible(), true, "IME Escape must not dismiss the sheet");
  await dialog.dispatchEvent("keydown", { key: "Escape", repeat: true });
  assert.equal(await dialog.isVisible(), true, "held Escape must not dismiss a new sheet");
  await dialog.evaluate((element) => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault(); element.dispatchEvent(event);
  });
  assert.equal(await dialog.isVisible(), true, "consumed Escape belongs to the child control");
  await page.keyboard.press("Escape");
  // Retrying one renderer must not unmount another cached session's native screen.
  await page.getByRole("button", { name: "检查会话接力", exact: true }).click();
  await page.locator(".tap-session.is-visible .xterm-screen").waitFor();
  await page.evaluate(() => {
    window.tapOtherScreen = document.querySelector(".tap-session.is-visible .xterm-screen");
    window.tapOtherTerminal = window.tapFixtureTerminal();
  });
  await page.getByRole("button", { name: "完善移动工作台", exact: true }).click();
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.tapWriteFrames = [];
    window.tapFrame = 0;
    const tick = () => { window.tapFrame++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    for (const terminal of [window.tapFixtureTerminal(), window.tapOtherTerminal]) {
      const write = terminal.write;
      terminal.write = function (...args) { window.tapWriteFrames.push(window.tapFrame); return write.apply(this, args); };
    }
  });
  const simultaneous = ["pty-a", "pty-b"].map((sessionId) => ({ sessionId, chunk: { sequence: ++chunkSequence,
    frames: [{ sequence: ++outputSequence, kind: "output", cols: 80, rows: 24,
      data: Buffer.from(`GLOBAL FAIR ${sessionId}\r\n`).toString("base64"), replayBatchEnd: false }] } }));
  await page.evaluate((items) => {
    const host = document.querySelector(".tap-session.is-visible");
    let fiber = host[Object.keys(host).find((key) => key.startsWith("__reactFiber$"))];
    for (; fiber; fiber = fiber.return) {
      const stream = fiber.memoizedProps?.model?.stream;
      if (stream) { for (const item of items) stream.publish(item.sessionId, item.chunk); return; }
    }
    throw Error("terminal stream unavailable");
  }, simultaneous);
  await page.waitForTimeout(100);
  const writeFrames = await page.evaluate(() => window.tapWriteFrames);
  assert.equal(writeFrames.length, 2);
  assert.equal(new Set(writeFrames).size, 2, "different terminal writes must not start in the same animation frame");
  await page.evaluate(() => {
    // Simulate an xterm write failure, then exercise the actual retry button/discrete event.
    window.tapFixtureTerminal().write = () => { throw Error("controlled xterm failure"); };
  });
  for (const socket of clients) output(socket, "device-b", "pty-a", "retry-trigger\r\n");
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.tapOtherScreen.isConnected), true, "retrying one terminal must keep sibling renderers mounted");
  // Paste/Enter is deliberately interruptible, with no delivery retry after the transport returns.
  await input.fill("interrupted paste");
  const interruptedAt = inputLog.length;
  await page.getByRole("button", { name: "发送", exact: true }).click();
  for (const socket of clients) socket.terminate();
  await page.waitForTimeout(200);
  assert.equal(await input.inputValue(), "interrupted paste");
  assert.equal(inputLog.slice(interruptedAt).some((entry) => entry.data === "\r"), false);
  const interruptedCount = inputLog.length;
  await page.waitForTimeout(1500);
  assert.equal(inputLog.length, interruptedCount, "reconnect never resubmits an interrupted draft");
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const phoneErrors = [];
  phone.on("pageerror", (error) => phoneErrors.push(String(error)));
  await phone.route("**/*.woff2", (route) => route.abort());
  await phone.goto(`${base}/tap/`);
  await phone.getByRole("button", { name: "打开会话导航", exact: true }).click();
  await phone.getByRole("button", { name: "完善移动工作台", exact: true }).click();
  await phone.locator(".tap-session.is-visible .xterm-helper-textarea").waitFor({ state: "attached" });
  await phone.locator(".tap-session.is-visible").getByRole("button", { name: "添加", exact: true }).click();
  await phone.getByRole("menuitem", { name: "直接键入", exact: true }).click();
  assert.equal(await phone.locator(".tap-session.is-visible .xterm-helper-textarea").evaluate((element) => element.readOnly), false);
  await phone.getByRole("button", { name: "结束直接键入", exact: true }).click();
  assert.equal(await phone.locator(".tap-session.is-visible .xterm-helper-textarea").evaluate((element) => element.readOnly), true, "leaving direct input restores the coarse-pointer keyboard policy");
  assert.deepEqual(phoneErrors, [], "optional font failure must not reject the terminal setup");
  await phone.close();
  // An aborted old 401 body must not expire the new device/account scope.
  await page.getByRole("button", { name: /^执行设备/ }).click();
  await page.getByRole("menuitemradio", { name: /Studio/ }).click();
  await page.waitForTimeout(350);
  holdHistory401 = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const historyDeadline = Date.now() + 3000;
  while (!finishHistory401 && Date.now() < historyDeadline) await page.waitForTimeout(10);
  assert.equal(typeof finishHistory401, "function");
  await page.getByRole("button", { name: /^执行设备/ }).click();
  await page.getByRole("menuitemradio", { name: /Spare host/ }).click();
  await page.waitForTimeout(350);
  finishHistory401();
  assert.equal(await page.locator(".tap-app").count(), 1, "an old response must not expire the new scope");
  assert.ok(requestLog.some((request) => request.kind === "terminal.transcript"));
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(JSON.stringify({ result: "pass", screenshots: evidence, inputFrames: inputLog.length, operations: requestLog.length, burstFrames: 5001, burstWrites }));
} finally {
  await browser?.close();
  for (const ws of clients) ws.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
