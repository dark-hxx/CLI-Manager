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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/terminalSnapshotMouse.html`;
  await page.goto(url);
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

  // Platform must be set before xterm loads: the local browser, not the remote
  // PTY OS, owns the modifier that overrides application mouse reporting.
  for (const [platform, modifier] of [["MacIntel", "Alt"], ["Win32", "Shift"], ["Linux x86_64", "Shift"]]) {
    const selectionPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    selectionPage.on("pageerror", error => errors.push(String(error)));
    await selectionPage.addInitScript(value => {
      Object.defineProperty(navigator, "platform", { get: () => value });
    }, platform);
    await selectionPage.goto(url);
    await selectionPage.waitForFunction(() => window.mouseSnapshotTest);
    const selectionState = () => selectionPage.evaluate(() => window.mouseSnapshotTest.state());
    // Clear hover reports only after moving into the target. A forced selection
    // must emit no bytes from mouse-down through mouse-up, even in ANY mode.
    async function drag(id, key) {
      const bounds = await selectionPage.locator(`#${id} .xterm-screen`).boundingBox();
      if (key) await selectionPage.keyboard.down(key);
      await selectionPage.mouse.move(bounds.x + 4, bounds.y + 8);
      await selectionPage.evaluate(() => window.mouseSnapshotTest.clear());
      await selectionPage.mouse.down();
      await selectionPage.mouse.move(bounds.x + 160, bounds.y + 8, { steps: 5 });
      await selectionPage.mouse.up();
      if (key) await selectionPage.keyboard.up(key);
    }
    // A short Option gesture must not fall through to xterm's click-to-caret
    // path and inject cursor-movement keys into the running CLI.
    async function forcedClick(id, key, label) {
      const bounds = await selectionPage.locator(`#${id} .xterm-screen`).boundingBox();
      await selectionPage.keyboard.down(key);
      await selectionPage.mouse.move(bounds.x + 100, bounds.y + 8);
      await selectionPage.evaluate(() => window.mouseSnapshotTest.clear());
      await selectionPage.mouse.click(bounds.x + 100, bounds.y + 8);
      await selectionPage.keyboard.up(key);
      const value = (await selectionState())[id === "source" ? "original" : "restored"];
      assert.deepEqual(value.reports, [], `${label}: selection click must not inject cursor keys`);
    }
    // Check the renderer's visible highlight as well as its selection model;
    // select() alone would bypass the broken user-mouse path entirely.
    async function assertVisibleSelection(id, label) {
      const value = (await selectionState())[id === "source" ? "original" : "restored"];
      assert.equal(value.selected, true, label);
      assert.equal(value.text, "selectable text for", label);
      assert.deepEqual(value.reports, [], `${label}: local selection must not reach the PTY`);
      await selectionPage.waitForFunction(target => {
        return [...document.querySelectorAll(`#${target} .xterm-selection div`)].some(element => {
          const box = element.getBoundingClientRect();
          const color = getComputedStyle(element).backgroundColor;
          return box.width > 0 && box.height > 0 && color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
        });
      }, id);
    }
    for (const alternate of [false, true]) {
      for (const [mode, track] of Object.entries(tracking)) for (const [encoding, encode] of Object.entries(encodings)) {
        const label = `${platform}/${alternate ? "alternate" : "normal"}/${mode}/${encoding}`;
        const before = await selectionPage.evaluate(([sequence, alternate]) => {
          return window.mouseSnapshotTest.setup(sequence, { alternate, preexisting: true });
        }, [track + encode, alternate]);
        assert.equal(before.original.buffer, alternate ? "alternate" : "normal", label);
        assert.equal(before.restored.buffer, before.original.buffer, label);
        assert.equal(before.restored.tracking, mode, label);
        assert.equal(before.restored.encoding, encoding, label);
        const ordinaryReports = [];
        for (const id of ["source", "restored"]) {
          await drag(id);
          const value = (await selectionState())[id === "source" ? "original" : "restored"];
          if (mode === "none") {
            await assertVisibleSelection(id, `${label}: ordinary shell selection`);
          } else {
            assert.equal(value.selected, false, `${label}: ordinary drag belongs to the TUI`);
            assert.ok(value.reports.length > 0, `${label}: ordinary drag still reports`);
          }
          ordinaryReports.push(value.reports);
        }
        assert.deepEqual(ordinaryReports[0], ordinaryReports[1], `${label}: restored ordinary reports`);
        if (mode !== "none") {
          for (const id of ["source", "restored"]) {
            await forcedClick(id, modifier, label);
            await drag(id, modifier);
            await assertVisibleSelection(id, `${label}: ${modifier} selection`);
            if (mode !== "x10") {
              await selectionPage.evaluate(() => window.mouseSnapshotTest.clear());
              await selectionPage.mouse.wheel(0, 120);
              await selectionPage.waitForFunction(target => {
                const value = window.mouseSnapshotTest.state()[target === "source" ? "original" : "restored"];
                return value.reports.length > 0;
              }, id);
            }
          }
        }
        cases++;
      }
    }
    await selectionPage.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: cases,
    coverage: "actual mouse bytes, modes, reset, tail, legacy, Win/Linux Shift and Mac Option visible selection, short clicks, normal/alternate, wheel" }));
} finally {
  await browser?.close();
  if (server) {
    server.httpServer.closeAllConnections();
    await new Promise(done => server.httpServer.close(done));
  }
  if (dirname(outDir) === tmpdir()) rmSync(outDir, { recursive: true, force: true });
}
