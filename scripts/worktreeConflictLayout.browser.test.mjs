import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Run just React + the actual layout/CSS in an empty page: no application, HTTP server or Git IPC.
test('conflict columns fit, resize, cancel and preserve their mounted children', { timeout: 60000 }, async (t) => {
  const runtime = process.env.CONFLICT_TEST_PLAYWRIGHT ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({ channel: process.env.CONFLICT_TEST_BROWSER ?? 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const css = await readFile('src/styles/components/worktree-conflicts.css', 'utf8');
  const bundle = await build({ entryPoints: ['scripts/fixtures/worktreeConflictLayout.tsx'], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic' });
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}:root{--term-panel-bg:#1e1f22;--term-panel-fg:#bcbec4;--term-panel-track:#232529;--term-panel-card:#2b2d30;--term-panel-border:#393b40;--terminal-theme-accent:#3574f0;--term-panel-red:#e06c75;--term-panel-green:#57965c} ${css}</style><div id="root"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('separator').first().waitFor();
  const settled = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const widths = () => page.locator('.conflict-pane-slot').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  const close = (a, b) => assert.ok(Math.abs(a - b) < 2, `${a} != ${b}`);
  const fit = async () => {
    await settled();
    const bounds = await page.locator('.conflict-merge-grid').evaluate((grid) => ({
      width: grid.clientWidth, scroll: grid.scrollWidth, right: grid.getBoundingClientRect().right,
      panes: [...grid.querySelectorAll('.conflict-pane-slot')].map((pane) => ({ right: pane.getBoundingClientRect().right, width: pane.clientWidth })),
    }));
    assert.equal(bounds.panes.length, 3);
    assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
    assert.ok(bounds.panes.every((pane) => pane.width > 0 && pane.right <= bounds.right + 1));
  };
  for (const language of ['zh-CN', 'en-US']) {
    await page.evaluate((value) => window.conflictLayoutTest.setLanguage(value), language);
    for (const width of [480, 640, 800, 1000, 1400]) {
      await page.evaluate((value) => window.conflictLayoutTest.setWidth(value), width);
      await fit();
    }
  }
  await page.evaluate(() => window.conflictLayoutTest.setWidth(1000));
  await settled();
  await page.getByLabel('Merge result / 合并结果', { exact: true }).fill('edited buffer');
  const startDrag = async (index) => {
    const rect = await page.getByRole('separator').nth(index).boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 100);
    await page.mouse.down();
    return { x: rect.x + rect.width / 2, y: rect.y + 100 };
  };
  for (const index of [0, 1]) {
    const before = await widths();
    const count = await page.evaluate(() => window.conflictLayoutTest.state.commits);
    const point = await startDrag(index);
    await page.mouse.move(point.x + 50, point.y, { steps: 5 });
    await settled();
    assert.equal(await page.evaluate(() => window.conflictLayoutTest.state.commits), count, 'drag preview stays local');
    await page.mouse.up();
    await settled();
    const after = await widths();
    close(after[index] - before[index], 50);
    close(before[index + 1] - after[index + 1], 50);
    close(after[index === 0 ? 2 : 0], before[index === 0 ? 2 : 0]);
    await fit();
    await page.getByRole('separator').nth(index).press('Enter');
    await settled();
  }
  const handle = page.getByRole('separator').first();
  await handle.press('Home'); await settled();
  close((await widths())[0], 100);
  await handle.press('End'); await settled();
  close((await widths())[1], 100);
  await handle.press('Enter'); await settled();
  const equal = await widths();
  await handle.press('Shift+ArrowRight'); await settled();
  close((await widths())[0] - equal[0], 50);
  await handle.dblclick(); await settled();
  close((await widths())[0], equal[0]);

  for (const reason of ['cancel', 'capture', 'blur', 'resize', 'hide']) {
    const committed = await page.evaluate(() => window.conflictLayoutTest.state.commits);
    const point = await startDrag(0);
    await page.mouse.move(point.x + 40, point.y);
    await settled();
    await page.evaluate((reason) => {
      const separator = document.querySelector('[role="separator"]');
      if (reason === 'cancel') separator.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
      if (reason === 'capture') separator.releasePointerCapture(1);
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      if (reason === 'resize') window.conflictLayoutTest.setWidth(640);
      if (reason === 'hide') window.conflictLayoutTest.setShown(false);
    }, reason);
    await settled();
    await page.mouse.up();
    await page.evaluate(() => { window.conflictLayoutTest.setShown(true); window.conflictLayoutTest.setWidth(1000); });
    await fit();
    assert.equal(await page.evaluate(() => window.conflictLayoutTest.state.commits), committed, reason);
    close((await widths())[0], equal[0]);
  }

  await page.evaluate(() => window.conflictLayoutTest.setZoom(1.25)); await settled();
  const zoomed = await widths();
  const point = await startDrag(0);
  await page.mouse.move(point.x + 50, point.y); await page.mouse.up(); await settled();
  close((await widths())[0] - zoomed[0], 50);
  await fit();
  assert.equal(await page.getByLabel('Merge result / 合并结果', { exact: true }).inputValue(), 'edited buffer');
  assert.deepEqual(await page.evaluate(() => [window.conflictLayoutTest.state.mounts, window.conflictLayoutTest.state.unmounts]), [3, 0]);
  const last = await startDrag(1); await page.mouse.move(last.x - 40, last.y);
  await page.evaluate(() => window.conflictLayoutTest.setMounted(false));
  await page.mouse.up(); await settled();
  assert.deepEqual(await page.evaluate(() => [window.conflictLayoutTest.state.mounts, window.conflictLayoutTest.state.unmounts]), [3, 3]);
  assert.deepEqual(errors, []);
});
