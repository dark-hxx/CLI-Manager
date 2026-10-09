import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { conflictInput, conflictValue, replaceConflictText } from './fixtures/worktreeConflictEditor.mjs';

// Explicitly opt in: npm-installed Playwright or the Codex bundled runtime. No package installation.
const playwrightPath = process.env.CONFLICT_TEST_PLAYWRIGHT ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
test('production conflict workspace: real browser interactions and bounded DOM', { timeout: 180000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const output = await mkdtemp(join(tmpdir(), 'cli-conflict-browser-'));
  let server; let browser;
  t.after(async () => { await browser?.close(); await new Promise((done) => server ? server.httpServer.close(done) : done()); await rm(output, { recursive: true, force: true }); });
  await build({ configFile: false, plugins: [react(), tailwindcss()], logLevel: 'error', resolve: { alias: { '@': resolve('src') } },
    build: { outDir: output, emptyOutDir: false, rollupOptions: { input: resolve('scripts/fixtures/worktreeConflicts.html') } } });
  server = await preview({ configFile: false, build: { outDir: output }, preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  browser = await chromium.launch({ channel: process.env.CONFLICT_TEST_BROWSER ?? 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__workerStats = { started: 0, active: 0 };
    window.Worker = class extends NativeWorker {
      stopped = false;
      tracked = false;
      constructor(...args) {
        super(...args);
        this.tracked = String(args[0]).includes('conflictEditor');
        if (this.tracked) { window.__workerStats.started++; window.__workerStats.active++; }
      }
      terminate() {
        if (!this.stopped && this.tracked) { this.stopped = true; window.__workerStats.active--; }
        super.terminate();
      }
    };
  });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/worktreeConflicts.html`);
  await page.locator('#open-conflicts').click();
  const file = (index) => page.locator(`[data-file-index="${index}"]`);
  await file(0).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('[data-worktree-conflict-workspace]').count(), 1);
  assert.ok(await page.locator('[data-file-index]').count() <= 41);
  await file(0).click();
  await conflictInput(page).waitFor();
  assert.equal(await page.locator('[data-conflict-pane]').count(), 3);
  assert.match(await conflictValue(page, 'base'), /target-0/);
  assert.match(await conflictValue(page, 'worktree'), /worktree-0/);
  const sourceWorkers = await page.evaluate(() => window.__workerStats.started);
  assert.equal(await page.evaluate(() => window.__workerStats.active), 0, 'completed worker terminates');
  await page.evaluate(() => window.__conflictTest.language('zh-CN'));
  const editor = conflictInput(page);
  await editor.waitFor({ state: 'visible' });
  assert.equal(await conflictValue(page), 'target-0\nworktree-0\n', 'editable preview is visible before selecting a resolution');
  assert.equal(await page.evaluate(() => window.__conflictTest.harness.detail('file-0').draft.choices['block-0']), undefined, 'preview does not resolve a block');
  await page.locator('[data-conflict-pane="result"]').getByRole('button', { name: '接受左侧', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '手动编辑', exact: true }).count(), 0);
  assert.equal(await conflictValue(page), 'target-0\n', 'direct editing keeps the prior side rather than replacing it with Worktree');
  await replaceConflictText(page, '中文😀\tmanual\nsecond line');
  await page.waitForFunction(() => window.__conflictTest.harness.calls.some((call) => call.name.endsWith('save_conflict_draft')));
  assert.equal(await editor.isEnabled(), true);
  assert.equal(await editor.evaluate((node) => document.activeElement === node), true);
  await page.waitForFunction(() => window.__conflictTest.harness.detail('file-0').draft.choices['block-0']?.text === '中文😀\tmanual\r\nsecond line');
  await page.evaluate(() => window.__conflictTest.language('en-US'));
  await page.getByRole('textbox', { name: 'Merge result', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__workerStats.started), sourceWorkers, 'draft-only refetch reuses source model');
  await page.evaluate(() => { window.__conflictTest.harness.controls.failSave = true; });
  await replaceConflictText(page, 'unsaved buffer');
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saving and return', exact: true }).waitFor();
  assert.equal(await conflictValue(page), 'unsaved buffer');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { window.__conflictTest.harness.controls.failSave = false; });
  await page.getByRole('button', { name: 'Last page', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-file-index="0"]')?.textContent.includes('file-64800'));
  await file(0).focus(); await page.keyboard.press('End');
  await file(86).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-file-index') === '86', null, { timeout: 3000 });
  assert.equal(await file(86).evaluate((node) => document.activeElement === node), true);
  assert.ok(await page.locator('[data-file-index]').count() <= 41);
  await file(86).click();
  await page.waitForFunction(() => window.__conflictTest.harness.calls.some((call) => call.args.fileId === 'file-64886'));
  assert.equal(await page.evaluate(() => window.__conflictTest.harness.controls.peak), 1);
  await page.setViewportSize({ width: 960, height: 540 });
  const footer = await page.getByRole('button', { name: 'Save and return', exact: true }).boundingBox();
  assert.ok(footer.y >= 0 && footer.y + footer.height <= 540, 'footer stays in short viewport');
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.waitForFunction(() => window.__conflictTest.returns === 1);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => window.__workerStats.active), 0, 'close leaves no active conflict parser workers');
  assert.equal(await page.evaluate(async () => (await window.__conflictTest.monaco()).editor.getModels()
    .filter((model) => model.uri.authority === 'conflict').length), 0, 'close disposes all conflict editor models');

  // Worker construction failure fails closed and a user retry restores the view.
  await page.evaluate(() => {
    window.__workingWorker = window.Worker;
    window.Worker = class { constructor() { throw new Error('worker unavailable'); } };
  });
  await page.locator('#open-conflicts').click(); await file(0).click();
  await page.getByRole('button', { name: 'Retry file view', exact: true }).waitFor();
  assert.equal(await page.locator('[data-conflict-pane]').count(), 0, 'failed model never exposes stale source');
  await page.evaluate(() => { window.Worker = window.__workingWorker; });
  await page.getByRole('button', { name: 'Retry file view', exact: true }).click();
  await conflictInput(page).waitFor();
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-worktree-conflict-workspace]'));

  // Delayed old-file work is canceled; its eventual response cannot replace B.
  await page.evaluate(() => {
    const second = window.__conflictTest.harness.detail('file-1');
    second.source = second.source.replaceAll('target-', 'second-');
    second.blocks.forEach((block) => { block.base = block.base.replaceAll('target-', 'second-'); });
    second.draft.sourceHash = 'source-one';
    window.Worker = class extends window.__workingWorker {
      pending;
      postMessage(...args) { this.pending = setTimeout(() => super.postMessage(...args), 400); }
      terminate() { clearTimeout(this.pending); super.terminate(); }
    };
  });
  await page.locator('#open-conflicts').click(); await file(0).click();
  await page.waitForFunction(() => window.__workerStats.active === 1);
  await file(1).click();
  await page.waitForFunction(() => document.querySelector('[data-conflict-pane="base"] .view-lines')?.textContent.includes('second-0'));
  assert.equal(await page.evaluate(() => window.__workerStats.active), 0);
  await file(2).click();
  await page.waitForFunction(() => window.__workerStats.active === 1);
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-worktree-conflict-workspace]') && window.__workerStats.active === 0);

  // Global owner docks in a native-kind tab, not a second outer tab bar/modal.
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/worktreeConflicts.html?host&total=3`);
  await page.locator('#open-conflicts').click();
  await page.getByRole('textbox').fill('preserved commit message');
  await page.getByRole('dialog').getByRole('button', { name: 'Resolve conflicts and merge', exact: true }).first().click();
  await file(0).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('[data-session-kind=worktree-conflict]').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-worktree-conflict-workspace]').count(), 1);
  assert.equal(await page.evaluate(() => window.__conflictTest.host().target.focus.id), 'open-conflicts');
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Resolve conflicts and merge', exact: true }).first().waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(await page.getByRole('textbox').inputValue(), 'preserved commit message');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'open-conflicts');
  await page.locator('#open-conflicts').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Resolve conflicts and merge', exact: true }).first().click();
  await file(0).waitFor();
  await page.evaluate(() => window.__conflictTest.compact());
  assert.equal(await page.locator('[data-worktree-conflict-workspace]').count(), 1, 'global owner survives launcher unmount');
  await page.evaluate(() => window.__conflictTest.removeProject());
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.waitForFunction(() => window.__conflictTest.host().phase === 'closed' && document.activeElement?.id === 'main-content');
  assert.equal(await page.getByRole('dialog').count(), 0, 'deleted project does not reopen stale finish context');
  assert.deepEqual(errors, []);
  t.diagnostic('Real production React components + Edge; mocked IPC only. This is not native Git/WebView2 performance evidence.');
});
