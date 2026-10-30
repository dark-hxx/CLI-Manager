import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, normalizePath, preview } from "vite";

const root = process.cwd();
const research = dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(join(tmpdir(), "codex-selection-research-"));
const fixture = normalizePath(resolve(root, "scripts/fixtures/terminalSnapshotMouse.ts"));
const policy = normalizePath(resolve(root, "src/features/terminal/browser/TerminalMouseInteraction.ts"));
const runtime = process.env.PLAYWRIGHT_MODULE ?? join(homedir(),
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(runtime).href);
let server, browser;
const results = [];
try {
  await build({ configFile: false, root, logLevel: "error", plugins: [{
    name: "selection-research-only",
    enforce: "pre",
    transform(code, id) {
      // Preserve the pre-fix baseline when rerunning this research after the
      // production option is corrected. The experiment below enables it live.
      if (normalizePath(id) === policy) return code
        .replace("macOptionClickForcesSelection: true", "macOptionClickForcesSelection: false")
        .replace("altClickMovesCursor: false", "altClickMovesCursor: true");
      if (normalizePath(id) !== fixture) return;
      return code.replace("  clear() {", "  option(value: boolean) { original.options.macOptionClickForcesSelection = value; restored.options.macOptionClickForcesSelection = value; },\n  clear() {");
    },
  }], build: { outDir: output, emptyOutDir: false,
    rollupOptions: { input: join(root, "scripts/fixtures/terminalSnapshotMouse.html") } } });
  server = await preview({ configFile: false, root, logLevel: "error", build: { outDir: output },
    preview: { host: "127.0.0.1", port: 0 } });
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  for (const platform of ["Win32", "MacIntel"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.addInitScript(value => Object.defineProperty(navigator, "platform", { get: () => value }), platform);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/terminalSnapshotMouse.html`);
    await page.waitForFunction(() => window.mouseSnapshotTest);
    for (const tracking of [false, true]) for (const modifier of [null, "Shift", "Alt"]) {
      for (const target of ["source", "restored"]) {
        await page.evaluate(sequence => window.mouseSnapshotTest.setup(sequence), tracking ? "\x1b[?1003h\x1b[?1006h" : "");
        const box = await page.locator(`#${target} .xterm-screen`).boundingBox();
        if (modifier) await page.keyboard.down(modifier);
        await page.mouse.move(box.x + 4, box.y + 8);
        await page.evaluate(() => window.mouseSnapshotTest.clear());
        await page.mouse.down();
        await page.mouse.move(box.x + 160, box.y + 8, { steps: 5 });
        await page.mouse.up();
        if (modifier) await page.keyboard.up(modifier);
        await page.waitForTimeout(50);
        const state = await page.evaluate(() => window.mouseSnapshotTest.state());
        const value = target === "source" ? state.original : state.restored;
        results.push({ platform, tracking, modifier, target, selected: value.selected, text: value.text, reports: value.reports.length });
      }
    }
    if (platform === "MacIntel") {
      await page.evaluate(() => window.mouseSnapshotTest.setup("\x1b[?1003h\x1b[?1006h"));
      await page.evaluate(() => window.mouseSnapshotTest.option(true));
      const box = await page.locator("#restored .xterm-screen").boundingBox();
      await page.keyboard.down("Alt");
      await page.mouse.move(box.x + 4, box.y + 8);
      await page.evaluate(() => window.mouseSnapshotTest.clear());
      await page.mouse.down();
      await page.mouse.move(box.x + 160, box.y + 8, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up("Alt");
      const value = (await page.evaluate(() => window.mouseSnapshotTest.state())).restored;
      assert.equal(value.selected, true);
      assert.ok(value.text.length > 0);
      assert.deepEqual(value.reports, []);
      results.push({ platform, experiment: "macOptionClickForcesSelection=true", selected: value.selected, text: value.text, reports: value.reports.length });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  for (const result of results.filter(value => !value.experiment)) {
    const expected = result.tracking
      ? result.platform === "Win32" && result.modifier === "Shift"
      : result.modifier !== "Shift";
    assert.equal(result.selected, expected, JSON.stringify(result));
  }
  writeFileSync(join(research, "selection-baseline.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ cases: results.length, results }, null, 2));
} finally {
  await browser?.close();
  if (server) {
    server.httpServer.closeAllConnections();
    await new Promise(done => server.httpServer.close(done));
  }
  if (resolve(dirname(output)) !== resolve(tmpdir()) || !output.includes("codex-selection-research-")) {
    throw new Error("Unexpected research output path");
  }
  rmSync(output, { recursive: true, force: true });
}
