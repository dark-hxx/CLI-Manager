import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

test("Tap reflows phone text and exposes the whole native grid without resizing the desktop PTY", { timeout: 90_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.TAP_TEST_PLAYWRIGHT ?? ".codex/tools/browser-test/node_modules/playwright/index.mjs")).href);
  const outDir = resolve(".codex/tap-terminal-browser-dist");
  await build({ configFile: false, root: process.cwd(), plugins: [react()], logLevel: "error",
    build: { outDir, emptyOutDir: true, rollupOptions: { input: resolve("scripts/fixtures/tapTerminal.html") } } });
  const server = await preview({ configFile: false, build: { outDir }, logLevel: "error", preview: { host: "127.0.0.1", port: 0 } });
  let browser;
  t.after(async () => {
    await browser?.close(); server.httpServer.closeAllConnections();
    await new Promise((done) => server.httpServer.close(done));
  });
  browser = await chromium.launch({ headless: true, channel: process.env.TAP_TEST_BROWSER ?? "msedge" });
  for (const width of [390, 1800]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390 });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/tapTerminal.html`);
    await page.waitForFunction(() => window.tapTerminalFixture);
    const api = (method, value) => page.evaluate(({ method, value }) => window.tapTerminalFixture[method](value), { method, value });
    const snap = () => api("snapshot");
    const write = async (text) => {
      const sequence = await api("write", text);
      await page.waitForFunction((sequence) => window.tapTerminalFixture.snapshot().rendered === sequence, sequence);
      await page.waitForTimeout(220);
    };
    const rows = "\x1b[2J\x1b[H" + Array.from({ length: 67 }, (_, i) =>
      `\x1b[${i + 1};1H${i === 66 ? "FINAL_VIEWPORT_ROW" : i === 3 ? "Long_" + "abcdefghij".repeat(17) : `ROW_${i + 1}`}`).join("");
    await write(rows);
    assert.equal((await snap()).reading, width === 390, "phone defaults to reflow, wide desktop retains native");
    if (width === 390) {
      assert.equal((await snap()).readerScrollWidth, (await snap()).readerWidth, "long words wrap without horizontal overflow");
      assert.ok((await snap()).readerMax - (await snap()).readerTop < 2, "reader starts at the latest full row");
      await page.screenshot({ path: `.codex/tap-terminal-${width}-reflow.png` });
      await api("focus");
      await page.waitForFunction(() => !window.tapTerminalFixture.snapshot().reading);
      await api("leaveDirect");
      await page.waitForFunction(() => window.tapTerminalFixture.snapshot().reading);
      await page.locator(".tap-terminal-reader").evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(50);
      await write("\x1b[67;1HFINAL_READER_UPDATED");
      assert.equal((await snap()).readerTop, 0, "upstream output must not pull a reader back to the end");
      await page.locator(".tap-terminal-reader").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await api("configure", { height: 400, fontSize: 18 });
      await page.waitForTimeout(250);
      assert.ok((await snap()).readerMax - (await snap()).readerTop < 2, "font/keyboard-sized viewport keeps tail visible");
      await api("configure", { height: 650, fontSize: 14 });
      await page.locator(".tap-terminal-chip").click();
    } else {
      // Make the desktop's native choice explicit before changing its font/available height.
      await page.locator(".tap-terminal-chip").click();
      await page.waitForFunction(() => window.tapTerminalFixture.snapshot().reading);
      await page.locator(".tap-terminal-chip").click();
    }
    await page.waitForFunction(() => !window.tapTerminalFixture.snapshot().reading);
    await page.waitForFunction(() => window.tapTerminalFixture.snapshot().lastRowVisible);
    let state = await snap();
    assert.deepEqual(state.grid, [191, 67]); assert.deepEqual(state.resizes, []);
    assert.ok(state.maxTop > 0 && state.innerHeight > state.hostHeight, "native grid has intrinsic, unclipped height");
    assert.match(state.finalInBuffer, /FINAL_/);
    await page.screenshot({ path: `.codex/tap-terminal-${width}-native.png` });
    const host = page.locator(".tap-terminal-screen");
    await host.hover({ position: { x: 100, y: 100 } });
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(100);
    const manualTop = (await snap()).top;
    assert.ok(manualTop < state.top - 100, "wheel reaches hidden native rows rather than being swallowed by xterm");
    await write("\x1b[67;1HFINAL_NATIVE_UPDATED");
    assert.equal((await snap()).top, manualTop, "output does not undo manual scrolling");
    await host.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(80);
    await api("configure", { height: 380, fontSize: 18 });
    await page.waitForFunction(() => window.tapTerminalFixture.snapshot().lastRowVisible);
    await api("configure", { active: false, visible: false });
    await api("configure", { active: true, visible: true, height: 620 });
    await page.waitForFunction(() => window.tapTerminalFixture.snapshot().lastRowVisible);
    if (width === 390) {
      await host.evaluate((el) => {
        const screen = el.querySelector(".xterm-screen");
        const emit = (type, x, y) => screen.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
          touches: [new Touch({ identifier: 1, target: screen, clientX: x, clientY: y })] }));
        emit("touchstart", 200, 100); emit("touchmove", 80, 200);
      });
      state = await snap();
      assert.ok(state.left > 80 && state.top < state.maxTop - 50, "touch can pan both native axes");
    }
    await write("\r\n" + Array.from({ length: 90 }, (_, i) => `SCROLLBACK_${i}\r\n`).join(""));
    assert.ok((await snap()).baseY > 0);
    await host.evaluate((el) => { el.scrollTop = 0; el.scrollLeft = 0; });
    await host.hover({ position: { x: 100, y: 100 } });
    await page.mouse.wheel(0, -200);
    await page.waitForFunction(() => {
      const state = window.tapTerminalFixture.snapshot(); return state.viewportY < state.baseY;
    });
    await api("configure", { nativeMenu: true });
    await page.waitForTimeout(100);
    assert.equal((await snap()).reading, false, "CLI menus stay native");
    await api("configure", { nativeMenu: false, language: "en-US" });
    await page.waitForTimeout(80);
    if ((await snap()).reading) await page.getByRole("button", { name: "Native screen", exact: true }).click();
    await page.getByRole("button", { name: "Reflow text", exact: true }).click();
    await page.waitForFunction(() => window.tapTerminalFixture.snapshot().reading);
    await api("focus");
    await page.waitForFunction(() => !window.tapTerminalFixture.snapshot().reading);
    await api("leaveDirect");
    await page.waitForFunction(() => window.tapTerminalFixture.snapshot().reading);
    await page.setViewportSize({ width: width === 390 ? 1800 : 390, height: 700 });
    await page.waitForTimeout(200);
    assert.equal((await snap()).reading, true, "explicit reflow choice survives viewport changes");
    assert.deepEqual((await snap()).resizes, [], "all presentation changes leave desktop PTY ownership intact");
    assert.deepEqual((await snap()).errors, []); assert.deepEqual((await snap()).inputs, []);
    assert.deepEqual(errors, []);
    console.log(`TAP_TERMINAL width=${width} grid=191x67 last_row_fully_visible=true desktop_resize_calls=0`);
    await page.close();
  }
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await phone.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/tapTerminal.html`);
  await phone.waitForFunction(() => window.tapTerminalFixture);
  await phone.evaluate(() => window.tapTerminalFixture.configure({ cols: 20, rows: 8 }));
  await phone.waitForFunction(() => window.tapTerminalFixture.snapshot().reading && window.tapTerminalFixture.snapshot().grid[0] === 20);
  assert.deepEqual(await phone.evaluate(() => window.tapTerminalFixture.snapshot().grid), [20, 8], "even a grid that fits the phone defaults to reflow");
  await phone.setViewportSize({ width: 844, height: 390 });
  await phone.waitForTimeout(100);
  assert.equal(await phone.evaluate(() => window.tapTerminalFixture.snapshot().reading), true, "short touch landscape uses the shared phone query");
  await phone.setViewportSize({ width: 1800, height: 844 });
  await phone.waitForFunction(() => !window.tapTerminalFixture.snapshot().reading);
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.waitForFunction(() => window.tapTerminalFixture.snapshot().reading);
  await phone.evaluate(() => window.tapTerminalFixture.configure({ mode: "web", height: 400 }));
  await phone.waitForFunction(() => window.tapTerminalFixture.snapshot().resizes.length > 0);
  const web = await phone.evaluate(() => window.tapTerminalFixture.snapshot());
  assert.ok(web.grid[0] > 20 && web.grid[1] > 8 && web.grid[1] < 67, "Web-owned grids still fit their own viewport");
  assert.equal(web.reading, true);
  await phone.close();
});
