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

test('short-window conflict workspace boundaries', { timeout: 180000 }, async (t) => {
  const runtime = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(process.env.CONFLICT_TEST_PLAYWRIGHT ?? runtime).href);
  const output = await mkdtemp(join(tmpdir(), 'cli-conflict-boundaries-'));
  let browser; let server;
  t.after(async () => {
    await browser?.close();
    await new Promise((done) => server ? server.httpServer.close(done) : done());
    await rm(output, { recursive: true, force: true });
  });
  await build({ configFile: false, plugins: [react(), tailwindcss()], logLevel: 'error',
    resolve: { alias: { '@': resolve('src') } },
    build: { outDir: output, emptyOutDir: false, rollupOptions: { input: resolve('scripts/fixtures/worktreeConflicts.html') } } });
  server = await preview({ configFile: false, build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  browser = await chromium.launch({ channel: process.env.CONFLICT_TEST_BROWSER ?? 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/worktreeConflicts.html?total=3&blocks=1');
  await page.locator('#open-conflicts').click();
  await page.locator('[data-file-index]').first().click();
  await conflictInput(page).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'workspace is not a focus-trapping modal');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-worktree-conflict-workspace]').count(), 1, 'Escape keeps the workspace open');
  assert.equal(await page.getByRole('button', { name: 'Edit manually', exact: true }).count(), 0);
  await page.evaluate(() => { window.__conflictTest.harness.controls.before = (name) => {
    if (name.endsWith('save_conflict_draft')) throw new Error('permission denied: long diagnostic '.repeat(100));
  }; });
  await replaceConflictText(page, 'preserve this buffer');
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saving and return', exact: true }).waitFor();
  for (const name of ['Retry saving and return', 'Save and return']) {
    const bounds = await page.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 400, '400px viewport: ' + JSON.stringify(bounds));
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-worktree-conflict-workspace]').count(), 1, 'Escape cannot discard a failed save');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Failure actions can cover the editor in short windows; the model must survive.
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await conflictValue(page), 'preserve this buffer');
  await page.evaluate(() => { window.__conflictTest.harness.controls.before = null; });
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-worktree-conflict-workspace]'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const detail = window.__conflictTest.harness.detail('file-1');
    const old = detail.blocks[0].base;
    const crlf = String.fromCharCode(13, 10);
    const base = '中文' + String.fromCharCode(9) + 'base ' + 'x'.repeat(1000) + crlf + 'second-base' + crlf;
    detail.source = detail.source.replace(old, base);
    detail.blocks[0].base = base;
    detail.blocks[0].end += new TextEncoder().encode(base).length - new TextEncoder().encode(old).length;
    detail.draft.sourceHash = 'long-copy-source';
  });
  await page.locator('#open-conflicts').click();
  await page.locator('[data-file-index]').nth(1).click();
  await conflictInput(page).waitFor();
  const selected = await page.evaluate(async () => {
    const { editor } = await window.__conflictTest.monaco();
    const panes = editor.getEditors().filter((pane) => pane.getModel()?.uri.authority === 'conflict');
    const left = panes.find((pane) => pane.getModel().uri.path.endsWith('/base'));
    const right = panes.find((pane) => pane.getModel().uri.path.endsWith('/worktree'));
    left.setSelection({ startLineNumber: 1, startColumn: 2, endLineNumber: 2, endColumn: 7 });
    left.setScrollLeft(500);
    const model = left.getModel();
    return { text: model.getValueInRange(left.getSelection()),
      expected: model.getLineContent(1).slice(1) + '\n' + model.getLineContent(2).slice(0, 6),
      leftScroll: left.getScrollLeft(), rightScroll: right.getScrollLeft(),
      sourceReadOnly: left.getOption(editor.EditorOption.readOnly), count: panes.length };
  });
  assert.equal(selected.text, selected.expected, 'source selection excludes other panes and line numbers');
  assert.equal(selected.sourceReadOnly, true);
  assert.equal(selected.count, 3);
  assert.ok(selected.leftScroll > 0);
  assert.equal(selected.rightScroll, 0, 'pane scroll positions are independent');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-worktree-conflict-workspace]').count(), 1);
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-worktree-conflict-workspace]'));
  assert.deepEqual(errors, []);
});
