import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE
  ?? ".codex/tools/browser-test/node_modules/playwright/index.mjs")).href);
const outDir = mkdtempSync(join(tmpdir(), "cli-subagent-browser-"));
let server, browser;
const errors = [];
try {
  // Bundle real components once instead of crawling the desktop Store's large
  // import graph through a dev server. Styles come from both production builds.
  await build({ entryPoints: ["scripts/fixtures/subagentConversation.tsx"], bundle: true,
    outfile: join(outDir, "fixture.js"), platform: "browser", format: "esm", jsx: "automatic",
    loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": resolve("src") } });
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
    response.end(request.url === "/fixture.js" ? readFileSync(join(outDir, "fixture.js"))
      : '<!doctype html><meta charset="UTF-8"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => { errors.push(error.message); console.error("Fixture page error:", error.message); });
  page.on("console", event => { if (event.type() === "error") console.error("Fixture console:", event.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  // Load the real built Web CSS without running a second Tailwind application
  // scan from the repository root. Run npm run web:build before this fixture.
  for (const assets of ["dist/assets", "apps/web/dist/assets"]) {
    const styles = readdirSync(resolve(assets)).filter(name => /^(?:index|App)-.*\.css$/.test(name));
    assert.ok(styles.length, "build assets before browser verification");
    for (const css of styles) await page.addStyleTag({ path: resolve(assets, css) });
  }
  // Allocate the child pane's column directly; the fixture has no parent PTY.
  await page.addStyleTag({ content: "#web > .web-subagent-panel { flex: 1; max-width: 100%; }" });
  await page.locator("#desktop .subagent-chat-message[data-actor=parent]").first().waitFor({ timeout: 120000 });
  const desktop = page.locator("#desktop"), web = page.locator("#web");
  for (const host of [desktop, web]) {
    assert.equal(await host.getByText("HIDDEN_INSTRUCTIONS", { exact: true }).count(), 0);
    assert.equal(await host.getByText("TOOL_SECRET", { exact: true }).count(), 0);
    assert.ok(await host.getByText("Final answer", { exact: true }).isVisible());
    assert.ok(await host.locator('[data-actor="parent"]').count());
    assert.equal(await host.getByText(/END_OF_TASK/).count(), 0);
    await host.getByRole("button", { name: "Show full text", exact: true }).click();
    assert.ok(await host.getByText(/END_OF_TASK/).isVisible());
    await host.locator(".subagent-chat-details > button").first().click();
    assert.ok(await host.getByText("HIDDEN_INSTRUCTIONS", { exact: true }).isVisible());
  }
  await page.locator("#append").click();
  await desktop.getByText("APPENDED_REPLY", { exact: true }).waitFor();
  assert.ok(await desktop.getByText("HIDDEN_INSTRUCTIONS", { exact: true }).count());
  await desktop.getByRole("button", { name: "Execution records", exact: true }).click();
  assert.ok(await desktop.getByText(/TOOL_SECRET/).count());
  await desktop.getByRole("button", { name: "Conversation", exact: true }).click();
  await page.locator("#language").click();
  assert.ok(await desktop.getByRole("button", { name: "对话", exact: true }).isVisible());
  assert.ok(await web.getByRole("button", { name: "对话", exact: true }).isVisible());
  assert.match(await desktop.locator("time").first().textContent(), /^\d{2}:\d{2}$/);
  await page.locator("#theme").click();
  await page.screenshot({ path: ".codex/subagent-conversation-light.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".codex/subagent-conversation-mobile.png", fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#theme").click();
  await page.screenshot({ path: ".codex/subagent-conversation-dark.png", fullPage: true });
  await page.locator("#hide").click();
  await page.locator("#append").click();
  assert.equal(await desktop.getByText("APPENDED_REPLY", { exact: true }).count(), 1, "hidden desktop keeps cached parse");
  await page.locator("#hide").click();
  await page.waitForFunction(() => [...document.querySelectorAll("#desktop .subagent-chat-bubble")].filter(el => el.textContent === "APPENDED_REPLY").length === 2);
  await page.locator("#switch").click();
  await desktop.getByText("OTHER_CHILD", { exact: true }).waitFor();
  assert.equal(await desktop.getByText("APPENDED_REPLY", { exact: true }).count(), 0);
  await web.getByRole("tab", { name: /Other agent/ }).click();
  await web.getByText("OTHER_CHILD", { exact: true }).waitFor();
  await page.locator("#switch").click();
  await page.locator("#many").click();
  await desktop.getByText(/ROW_329/).waitFor();
  assert.ok(await desktop.locator(".subagent-chat-message").count() <= 300);
  const scroll = desktop.locator(".ui-terminal-native-scroll");
  await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await page.locator("#append").click();
  assert.ok(await scroll.evaluate(el => el.scrollTop < 30), "append does not steal upward reading position");
  await page.locator("#reset").click();
  await desktop.getByText("RESET_MESSAGE", { exact: true }).waitFor();
  assert.equal(await desktop.getByText(/ROW_329/).count(), 0);
  assert.equal(await desktop.locator('[data-actor="parent"]').count(), 0, "reset discards provenance");
  assert.deepEqual(errors, []);
  console.log("PASS: desktop + Web, classification, lazy details, long text, append/reset, hidden catch-up, child isolation, 300-row cap, scroll, zh/en, dark/light, 390px");
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
  if (dirname(outDir) === tmpdir()) rmSync(outDir, { recursive: true, force: true });
}
