import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisplay, readDisplay, DEFAULT_DISPLAY } from './terminalDisplay.ts';

test('invalid and out of range preferences normalize safely', () => {
  assert.deepEqual(normalizeDisplay(null), DEFAULT_DISPLAY);
  assert.deepEqual(normalizeDisplay({ mode: 'bad', fontSize: Infinity, width: -10, height: 200 }),
    { mode: 'contain', fontSize: 14, width: 30, height: 100 });
  assert.deepEqual(normalizeDisplay({ mode: 'manual', fontSize: 28, width: 75, height: 50 }),
    { mode: 'manual', fontSize: 28, width: 75, height: 50 });
});

test('blocked or corrupt browser storage falls back without crashing', () => {
  globalThis.localStorage = { getItem() { throw new Error('blocked'); } };
  assert.deepEqual(readDisplay(), DEFAULT_DISPLAY);
  globalThis.localStorage = { getItem: () => '{broken' };
  assert.deepEqual(readDisplay(), DEFAULT_DISPLAY);
  delete globalThis.localStorage;
});
