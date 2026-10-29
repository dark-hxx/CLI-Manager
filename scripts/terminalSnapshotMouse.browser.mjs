import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, preview } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "cli-manager-mouse-browser-"));
const playwright = process.env.PLAYWRIGHT_MODULE ?? join(root, ".codex/tools/browser-test/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwright).href);
let server, browser;
try {
  await build({ configFile: false, root, logLevel: "error", build: {
    outDir, emptyOutDir: true, rollupOptions: { input: join(root, "scripts/fixtures/terminalSnapshotMouse.html") },
  } });
  server = await preview({ configFile: false, root, logLevel: "error", build: { outDir }, preview: { host: "127.0.0.1", port: 0 } });
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/terminalSnapshotMouse.html`);
  await page.waitForFunction(() => window.mouseSnapshotTest);
  const setup = (sequence, options) => page.evaluate(([sequence, options]) => window.mouseSnapshotTest.setup(sequence, options), [sequence, options]);
  const state = () => page.evaluate(() => window.mouseSnapshotTest.state());
  async function mouse(id) {
    const box = await page.locator(`#${id} .xterm-screen`).boundingBox();
    await page.mouse.move(box.x + 30, box.y + 25);
    await page.mouse.click(box.x + 45, box.y + 45);
    await page.mouse.move(box.x + 60, box.y + 65);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 65);
    await page.mouse.up();
  }
  let cases = 0;
  const tracking = { none: "", x10: "\x1b[?9h", vt200: "\x1b[?1000h", drag: "\x1b[?1002h", any: "\x1b[?1003h" };
  const encodings = { DEFAULT: "", SGR: "\x1b[?1006h", SGR_PIXELS: "\x1b[?1016h" };
  for (const [mode, track] of Object.entries(tracking)) for (const [encoding, encode] of Object.entries(encodings)) {
    const before = await setup(track + encode, { preexisting: true });
    assert.equal(before.restored.tracking, mode);
    assert.equal(before.restored.encoding, encoding);
    await mouse("source");
    await page.mouse.move(0, 0);
    const sourceReports = (await state()).original.reports;
    await mouse("restored");
    const after = await state();
    assert.deepEqual(after.restored.reports, sourceReports, `${mode}/${encoding} actual click/drag/motion reports`);
    assert.equal(sourceReports.length > 0, mode !== "none");
    cases++;
  }
  const tail = await setup("\x1b[?1003h\x1b[?1006h", { tail: true });
  assert.equal(tail.restored.encoding, "SGR");
  await mouse("restored");
  assert.ok((await state()).restored.reports.every(data => data.startsWith("\x1b[<")));
  const reset = await page.evaluate(() => window.mouseSnapshotTest.resetAndRoundTrip());
  assert.equal(reset.restored.tracking, "none");
  assert.equal(reset.restored.encoding, "DEFAULT");
  cases += 2;

  const legacy = await setup("\x1b[?1003h\x1b[?1006h", { legacy: true });
  assert.equal(legacy.snapshotHasEncoding, false);
  assert.equal(legacy.restored.tracking, "none");
  await mouse("restored");
  assert.deepEqual((await state()).restored.reports, []);
  await page.evaluate(() => window.mouseSnapshotTest.writeRestored("\x1b[?1006h\x1b[?1003h"));
  await mouse("restored");
  assert.ok((await state()).restored.reports.some(data => data.startsWith("\x1b[<")));
  cases++;

  await setup("\x1b[?1003h\x1b[?1006h");
  const box = await page.locator("#restored .xterm-screen").boundingBox();
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 4, box.y + 8);
  // xterm can report a shifted hover before selection starts; the selection
  // gesture itself must stay local, matching the unmodified terminal policy.
  await page.evaluate(() => window.mouseSnapshotTest.clear());
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 8, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const selected = await state();
  assert.equal(selected.selected, true);
  assert.deepEqual(selected.restored.reports, []);
  cases++;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: cases, coverage: "actual xterm mouse bytes, modes, reset, tail, legacy recovery, Shift selection" }));
} finally {
  await browser?.close();
  if (server) {
    server.httpServer.closeAllConnections();
    await new Promise(done => server.httpServer.close(done));
  }
  if (dirname(outDir) === tmpdir()) rmSync(outDir, { recursive: true, force: true });
}
