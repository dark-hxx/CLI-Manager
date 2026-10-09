import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/features/projects/lib/conflictColumnLayout.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { DEFAULT_CONFLICT_COLUMNS, conflictColumnMinimum, fitConflictColumns, resizeConflictColumns } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`,
);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('both dividers transfer width only inside their adjacent pair', () => {
  for (const divider of [0, 1]) {
    const next = resizeConflictColumns(DEFAULT_CONFLICT_COLUMNS, divider, 0.1, 900);
    close(next[divider], 1 / 3 + 0.1);
    close(next[divider + 1], 1 / 3 - 0.1);
    close(next[divider === 0 ? 2 : 0], 1 / 3);
  }
});

test('pointer extremes and keyboard Home/End preserve minimum widths and total space', () => {
  for (const width of [0, 1, 120, 299, 300, 480, 585.5, 1000, 2400]) {
    for (const divider of [0, 1]) {
      for (const delta of [-100, -1, -0.1, 0, 0.1, 1, 100]) {
        const next = resizeConflictColumns([0.1, 0.2, 0.7], divider, delta, width);
        close(next.reduce((sum, value) => sum + value, 0), 1);
        assert.ok(next.every((value) => value >= conflictColumnMinimum(width) - 1e-9));
      }
    }
  }
});

test('shrinking fits narrow hosts without destroying the preferred proportions', () => {
  const preferred = [0.1, 0.2, 0.7];
  const fitted = fitConflictColumns(preferred, 450);
  close(fitted[0], 100 / 450);
  close(fitted[1], 100 / 450);
  close(fitted[2], 250 / 450);
  assert.deepEqual(preferred, [0.1, 0.2, 0.7]);
  assert.deepEqual(fitConflictColumns(preferred, 1000), preferred);
});

test('hidden and sub-minimum containers keep three finite equal tracks', () => {
  for (const width of [0, 50, 299]) {
    fitConflictColumns([0.15, 0.25, 0.6], width).forEach((size) => close(size, 1 / 3));
  }
});
