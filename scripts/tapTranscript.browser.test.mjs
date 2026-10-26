import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

test("real Tap renders final disk notification over negotiated socket, preserves old DOM/expansion and paging", { timeout: 90_000 }, async (t) => {
  const playwrightPath = resolve(process.env.TAP_TEST_PLAYWRIGHT ?? ".codex/tools/browser-test/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const { wsServer: WebSocketServer } = (await import(pathToFileURL(resolve(dirname(playwrightPath), "../playwright-core/lib/utilsBundle.js")).href)).default;
  console.log("TAP_BROWSER_STAGE dependencies ready");
  const messages = Array.from({ length: 120 }, (_, i) => ({ id: `cli:${i}`, role: i % 3 === 0 ? "user" : i % 3 === 1 ? "tool" : "assistant",
    text: i % 3 === 1 ? "" : i % 3 === 0 ? `Question ${i}` : `## Answer ${i}\n\n- Stable **Markdown**\n\n\`\`\`ts\nconst answer = ${i};\n\`\`\``,
    parts: i % 3 === 1 ? [{ id: `p${i}`, kind: "tool_call", callId: `c${i}`, toolName: "Bash", text: JSON.stringify({ command: "git status" }) }] : undefined }));
  let revision = "epoch:120", writtenAt = 0;
  const requestTimes = [], sockets = new Set();
  const outDir = resolve(".codex/tap-transcript-browser-dist");
  await build({ configFile: false, root: process.cwd(), plugins: [react()], logLevel: "error",
    build: { outDir, emptyOutDir: true, rollupOptions: { input: resolve("scripts/fixtures/tapTranscript.html") } } });
  const server = await preview({ configFile: false, build: { outDir }, logLevel: "error",
    plugins: [{ name: "isolated-transcript-backend", configurePreviewServer(server) { server.middlewares.use("/fixture-transcript", transcriptRequest); } }],
    preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  console.log("TAP_BROWSER_STAGE server created");
  let browser, websocket;
  t.after(async () => {
    for (const peer of sockets) peer.terminate(); websocket?.close();
    await Promise.race([browser?.close(), new Promise((done) => setTimeout(done, 3000))]);
    server.httpServer?.closeAllConnections();
    await new Promise((done) => server.httpServer.close(done));
  });
  function transcriptRequest(req, res) {
    let body = "";
    req.on("data", (data) => { body += data; });
    req.on("end", () => {
      requestTimes.push(performance.now());
      const payload = JSON.parse(body);
      const end = Math.min(messages.length, payload.before ?? messages.length), start = Math.max(0, end - 40);
      const unchanged = !payload.before && payload.revision === revision;
      // Isolated, explicitly synthetic bridge RTT (not a real CLI/network measurement).
      setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ available: true, cliSessionId: "cli", epoch: "epoch", revision,
        unchanged, start, total: messages.length, messages: unchanged ? [] : messages.slice(start, end) })); }, 25);
    });
  }
  websocket = new WebSocketServer({ noServer: true });
  server.httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/ws/browser")) return;
    assert.match(req.url, /transcriptChanges=true/);
    websocket.handleUpgrade(req, socket, head, (peer) => { sockets.add(peer); peer.on("close", () => sockets.delete(peer)); peer.send(JSON.stringify({ type: "ready", latestSequence: 0 })); });
  });
  console.log("TAP_BROWSER_STAGE listening");
  browser = await chromium.launch({ headless: true, channel: process.env.TAP_TEST_BROWSER ?? "msedge" });
  console.log("TAP_BROWSER_STAGE browser launched");
  for (const language of ["zh-CN", "en-US"]) {
    const page = await browser.newPage({ viewport: { width: language === "zh-CN" ? 390 : 1280, height: 844 } });
    console.log("TAP_BROWSER_STAGE page created", language);
    const errors = []; page.on("pageerror", (e) => { errors.push(e.message); console.log("TAP_BROWSER_ERROR", e.message); });
    page.setDefaultTimeout(15_000);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/tapTranscript.html?language=${language}`, { waitUntil: "domcontentloaded", timeout: 15000 });
    console.log("TAP_BROWSER_STAGE navigated", language);
    await page.locator(".tap-message").last().waitFor();
    console.log("TAP_BROWSER_STAGE messages ready", language);
    assert.equal(await page.locator(".tap-process > *").count(), 0, "closed process details are not mounted");
    await page.locator(".tap-fold").first().click();
    await page.locator(".tap-process:not([hidden]) .tap-step").first().waitFor();
    console.log("TAP_BROWSER_STAGE process opened", language);
    await page.evaluate(() => {
      window.stableTurn = document.querySelector(".tap-turn");
      window.stableMarkdown = window.stableTurn.querySelector(".tap-message");
      window.oldMutations = 0;
      new MutationObserver((records) => window.oldMutations += records.length).observe(window.stableMarkdown, { childList: true, subtree: true, characterData: true });
    });
    // No PTY output is emitted: only the delayed log invalidation traverses the real socket adapter.
    messages.at(-1).text = `Final delayed response ${language}`; revision += ":next";
    writtenAt = performance.now();
    for (const peer of sockets) peer.send(JSON.stringify({ type: "transcript_changed", deviceId: "fixture", sessionId: "pty" }));
    await page.getByText(`Final delayed response ${language}`, { exact: true }).waitFor();
    const visibleMs = performance.now() - writtenAt;
    assert.ok(visibleMs < 2200, `notification should not require the 5s fallback: ${visibleMs}ms`);
    const stable = await page.evaluate(() => ({ turn: window.stableTurn === document.querySelector(".tap-turn"),
      markdown: window.stableMarkdown === document.querySelector(".tap-turn .tap-message"), mutations: window.oldMutations,
      expanded: document.querySelector(".tap-fold").getAttribute("aria-expanded") }));
    assert.deepEqual(stable, { turn: true, markdown: true, mutations: 0, expanded: "true" });
    // Use the real pager's position rather than assuming a translated label.
    await page.locator(".tap-load-older button").click();
    await page.locator('[data-anchor="cli:41"]').waitFor(); // Row 40 is a folded tool, not ordinary text.
    assert.equal(await page.getByText(`Final delayed response ${language}`, { exact: true }).count(), 1);
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(`TAP_BROWSER language=${language} synthetic_bridge_ms=25 hint_to_dom_ms=${visibleMs.toFixed(1)} unchanged_old_dom_mutations=0`);
    await page.close();
  }
});
