import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDesktopViewport, hasVisibleDesktopViewport, restoreDesktopViewportSize } from './terminalSizeOwnership.ts';

test('visible layout owns size before output subscribe; hidden parser does not', () => {
  let visible = true;
  let restores = 0;
  const dispose = registerDesktopViewport('a', { visible: () => visible, restore: () => restores++ });
  assert.equal(hasVisibleDesktopViewport('a'), true);
  restoreDesktopViewportSize('a');
  assert.equal(restores, 1);
  visible = false;
  assert.equal(hasVisibleDesktopViewport('a'), false);
  restoreDesktopViewportSize('a');
  assert.equal(restores, 1);
  visible = true;
  restoreDesktopViewportSize('a');
  assert.equal(restores, 2);
  dispose();
  assert.equal(hasVisibleDesktopViewport('a'), false);
});

test('overlapping layout cleanup cannot remove newer viewport or another session', () => {
  const old = registerDesktopViewport('a', { visible: () => true, restore() {} });
  const next = registerDesktopViewport('a', { visible: () => true, restore() {} });
  const other = registerDesktopViewport('b', { visible: () => true, restore() {} });
  old();
  assert.equal(hasVisibleDesktopViewport('a'), true);
  next();
  assert.equal(hasVisibleDesktopViewport('a'), false);
  assert.equal(hasVisibleDesktopViewport('b'), true);
  other();
});
