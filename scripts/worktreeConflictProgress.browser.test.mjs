import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Real confirmation/list components + controller; no Monaco, application, service or Git writes.
test('block completion enables Apply result and distinguishes drafts from applied files in both languages', { timeout: 60000 }, async (t) => {
  const runtime = process.env.CONFLICT_TEST_PLAYWRIGHT ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({ channel: process.env.CONFLICT_TEST_BROWSER ?? 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { useSyncExternalStore } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ConflictController } from './src/features/projects/lib/conflictController';
      import { ConflictFileConfirmation } from './src/features/projects/components/conflicts/ConflictFileConfirmation';
      import { ConflictFileList } from './src/features/projects/components/conflicts/ConflictFileList';
      import { createHarness } from './scripts/fixtures/worktreeConflictHarness.mjs';
      import { zh } from './src/shared/i18n/messages/projects.zh-CN';
      import { en } from './src/shared/i18n/messages/projects.en-US';
      if (!crypto.randomUUID) {
        let operation = 0;
        crypto.randomUUID = () => 'fixture-' + ++operation;
      }
      const root = createRoot(document.getElementById('root'));
      function App({ controller }) {
        const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
        const choose = (id) => controller.choose(id, { kind: 'worktree' });
        return <section className="conflict-workspace" style={{ width: 480 }}>
          <button onClick={() => choose('block-0')}>Accept right 1</button>
          <button onClick={() => choose('block-1')}>Accept right 2</button>
          <output data-applied>{view.snapshot?.resolved}</output>
          <output data-error>{view.error}</output>
          <ConflictFileList view={view} onPage={() => {}} onSelect={(id) => controller.select(id)} />
          {view.detail && <ConflictFileConfirmation detail={view.detail}
            disabled={view.busy || view.loading || view.needsRecheck}
            onConfirm={() => { void controller.resolve().catch(() => {}); }} />}
        </section>;
      }
      window.startProgress = async (language, failSave = false) => {
        window.progressTest?.controller.dispose();
        window.messages = language === 'zh-CN' ? zh : en;
        const harness = createHarness({ total: 1, blockCount: 2 });
        harness.controls.failSave = failSave;
        const controller = new ConflictController(harness.invoke, harness.context);
        window.progressTest = { controller, harness };
        await controller.initialize();
        root.render(<App key={language + failSave} controller={controller} />);
      };
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    plugins: [{ name: 'scoped-i18n', setup(build) {
      build.onResolve({ filter: /shared\/i18n\/index$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export function useI18n() { return { t: (key, params = {}) => {
          if (!window.messages[key]) throw new Error('Missing translation: ' + key);
          return window.messages[key].replace(/\\{(\\w+)\\}/g, (_, name) => params[name] ?? name);
        } }; }
      ` }));
    } }],
  });
  const css = await readFile('src/styles/components/worktree-conflicts.css', 'utf8');
  await page.setContent(`<style>*{box-sizing:border-box}.min-h-0{min-height:0}.flex-1{flex:1}.overflow-auto{overflow:auto}
    .conflict-file-list{display:flex;flex-direction:column;height:200px}${css}</style><div id="root"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const [language, apply, complete, partial, pending, applied] of [
    ['zh-CN', '应用结果', '冲突已解决', '已解决 1 / 2 个冲突块', '已解决 · 待应用', '已应用'],
    ['en-US', 'Apply result', 'Conflicts resolved', '1 / 2 conflict blocks resolved', 'Resolved · not applied', 'Applied'],
  ]) {
    await page.evaluate((language) => window.startProgress(language), language);
    const button = page.getByRole('button', { name: apply, exact: true });
    await button.waitFor();
    assert.equal(await button.isDisabled(), true);
    await page.getByRole('button', { name: 'Accept right 1', exact: true }).click();
    await page.getByText(partial, { exact: true }).waitFor();
    assert.equal(await button.isDisabled(), true);
    await page.getByRole('button', { name: 'Accept right 2', exact: true }).click();
    await page.getByText(complete, { exact: true }).waitFor();
    await page.getByRole('button', { name: `file-0.txt — ${pending}`, exact: true }).waitFor();
    assert.equal(await page.locator('[data-applied]').textContent(), '0');
    assert.equal(await page.evaluate(() => window.progressTest.harness.calls.some((call) => call.name.endsWith('resolve_conflict_file'))), false);
    await button.click();
    await page.getByRole('button', { name: `file-0.txt — ${applied}`, exact: true }).waitFor();
    assert.equal(await page.locator('[data-applied]').textContent(), '1');
    assert.equal(await button.count(), 0);
  }
  await page.evaluate(() => window.startProgress('en-US', true));
  await page.getByRole('button', { name: 'Accept right 1', exact: true }).click();
  await page.getByRole('button', { name: 'Accept right 2', exact: true }).click();
  await page.getByRole('button', { name: 'Apply result', exact: true }).click();
  await page.getByText('disk_full', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-applied]').textContent(), '0');
  assert.equal(await page.getByRole('button', { name: 'Apply result', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
});
