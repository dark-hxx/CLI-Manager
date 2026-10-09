import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir, cpus, totalmem, release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { makeStressConflict } from './fixtures/worktreeConflictStress.mjs';
import { sampleConflictUI, summarizeConflictPerformance } from './fixtures/worktreeConflictMetrics.mjs';

test('production conflict capacity, latency and repeated-close memory', { timeout: 240000 }, async (t) => {
  const modulePath = process.env.CONFLICT_TEST_PLAYWRIGHT
    ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const output = await mkdtemp(join(tmpdir(), 'cli-conflict-perf-'));
  let server; let browser;
  t.after(async () => {
    await browser?.close();
    await new Promise((done) => server ? server.httpServer.close(done) : done());
    await rm(output, { recursive: true, force: true });
  });
  const detail = makeStressConflict();
  const fixture = { bytes: Buffer.byteLength(detail.source), lines: detail.source.split('\n').length - 1,
    maxLineBytes: Math.max(...detail.source.split('\n').map((line) => Buffer.byteLength(line))),
    blocks: detail.blocks.length, jsonBytes: Buffer.byteLength(JSON.stringify(detail)), metadata: 64887 };
  assert.ok(fixture.bytes <= 2 * 1024 ** 2 && fixture.bytes > 1.9 * 1024 ** 2);
  assert.equal(fixture.lines, 20000); assert.equal(fixture.blocks, 2000);
  assert.ok(fixture.maxLineBytes < 65536 && fixture.maxLineBytes > 64000);
  assert.ok(fixture.jsonBytes <= 8 * 1024 ** 2);
  await build({ configFile: false, plugins: [react(), tailwindcss()], logLevel: 'error',
    resolve: { alias: { '@': resolve('src') } },
    build: { outDir: output, emptyOutDir: false, rollupOptions: { input: resolve('scripts/fixtures/worktreeConflicts.html') } } });
  server = await preview({ configFile: false, build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  browser = await chromium.launch({ channel: process.env.CONFLICT_TEST_BROWSER ?? 'msedge', headless: true });
  const url = `${server.resolvedUrls.local[0]}scripts/fixtures/worktreeConflicts.html?stress`;
  const errors = [];
  const createPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url); await page.locator('#open-conflicts').waitFor();
    return page;
  };
  const cold = [];
  for (let i = 0; i < 5; i++) {
    const page = await createPage();
    if (i === 0 && process.env.CONFLICT_PERF_TRACE) await browser.startTracing(page, { path: process.env.CONFLICT_PERF_TRACE,
      categories: ['devtools.timeline', 'v8.execute', 'disabled-by-default-v8.cpu_profiler'] });
    cold.push(await page.evaluate(sampleConflictUI));
    if (i === 0 && process.env.CONFLICT_PERF_TRACE) await browser.stopTracing();
    await page.close();
  }
  const page = await createPage(); await page.evaluate(sampleConflictUI);
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const memory = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return { heap: metrics.find((item) => item.name === 'JSHeapUsedSize').value, ...(await cdp.send('Memory.getDOMCounters')) };
  };
  const baseline = await memory(); const checkpoints = []; const warm = [];
  for (let i = 0; i < 20; i++) { warm.push(await page.evaluate(sampleConflictUI)); if ((i + 1) % 5 === 0) checkpoints.push(await memory()); }
  const quantiles = summarizeConflictPerformance(cold, warm);
  const report = { measuredAt: new Date().toISOString(), scope: 'Edge production React, mocked IPC; NOT native Git or WebView2',
    environment: { os: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, memory: totalmem(), node: process.version, browser: browser.version() },
    fixture, baseline, checkpoints, quantiles, cold, warm, errors };
  if (process.env.CONFLICT_PERF_REPORT) await writeFile(process.env.CONFLICT_PERF_REPORT, JSON.stringify(report, null, 2) + '\n');
  t.diagnostic(JSON.stringify({ fixture, quantiles, baseline, checkpoints }));
  assert.deepEqual(errors, []);
  for (const kind of ['cold', 'warm']) {
    assert.ok(quantiles.metadataPaint[kind].p95 <= 500, 'metadata paint p95 <=500ms');
    assert.ok(quantiles.detailPaint[kind].p95 <= 2000, 'detail paint p95 <=2000ms');
    assert.ok(quantiles.choicePaint[kind].p95 <= 100, 'choice paint p95 <=100ms');
  }
  assert.ok(quantiles.scroll.p95 <= 100, 'scroll paint p95 <=100ms');
  const all = [...cold, ...warm];
  assert.ok(all.every((s) => s.fileNodes <= 41 && s.rowNodes <= 60 && s.peak === 1), 'bounded DOM and single in-flight IPC');
  assert.ok(all.every((s) => s.longTasks.every((duration) => duration <= 100)), 'no >100ms main-thread task in measured UI');
  assert.ok(checkpoints.at(-1).heap - baseline.heap <= Math.max(10 * 1024 ** 2, baseline.heap * .1), 'bounded post-GC heap growth');
  assert.ok(checkpoints.at(-1).nodes <= baseline.nodes + 50, 'closed modal DOM does not accumulate');
  assert.ok(checkpoints.at(-1).jsEventListeners <= baseline.jsEventListeners + 5, 'closed modal listeners do not accumulate');
});
