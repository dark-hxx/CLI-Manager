import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMobileViewport } from './useMobileViewport.ts';

test('visual viewport keyboard resize and offset do not double subtract', () => {
  assert.deepEqual(calculateMobileViewport({ innerHeight: 800, baselineHeight: 800, focused: true,
    visual: { height: 450, offsetTop: 30, scale: 1 } }),
  { height: 450, top: 30, keyboardOpen: true, inset: 320 });
});
test('closing keyboard restores full viewport', () => {
  assert.deepEqual(calculateMobileViewport({ innerHeight: 800, baselineHeight: 800, focused: true,
    visual: { height: 800, offsetTop: 0, scale: 1 } }),
  { height: 800, top: 0, keyboardOpen: false, inset: 0 });
});
test('without visualViewport use resized innerHeight', () => {
  assert.deepEqual(calculateMobileViewport({ innerHeight: 420, baselineHeight: 800, focused: true }),
    { height: 420, top: 0, keyboardOpen: true, inset: 0 });
});
test('pinch zoom never classifies as keyboard or shrinks layout', () => {
  assert.deepEqual(calculateMobileViewport({ innerHeight: 800, baselineHeight: 800, focused: true,
    visual: { height: 350, offsetTop: 80, scale: 2 } }),
  { height: 800, top: 0, keyboardOpen: false, inset: 0 });
});
test('rotated baseline and unfocused browser chrome are not keyboard', () => {
  assert.equal(calculateMobileViewport({ innerHeight: 390, baselineHeight: 390, focused: true }).keyboardOpen, false);
  assert.equal(calculateMobileViewport({ innerHeight: 500, baselineHeight: 800, focused: false }).keyboardOpen, false);
});
test('VirtualKeyboard geometry can supply overlay height without forcing overlaysContent', () => {
  assert.deepEqual(calculateMobileViewport({ innerHeight: 800, baselineHeight: 800, focused: true, keyboardTop: 470 }),
    { height: 470, top: 0, keyboardOpen: true, inset: 330 });
});
