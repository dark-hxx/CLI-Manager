import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/shared/hooks/useFocusTrap.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the real hook against a minimal DOM boundary: hidden ancestors leave
// the child's computed display unchanged, but remove all its layout rectangles.
function mountTrap() {
  let cleanup;
  const listeners = new Map();
  const document = {
    activeElement: null,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); },
  };
  const element = (visible) => ({
    visible,
    focus() { if (this.visible) document.activeElement = this; },
    getClientRects() { return this.visible ? [{}] : []; },
  });
  const desktop = element(false);
  const compact = element(true);
  const close = element(true);
  const hiddenLast = element(false);
  const container = {
    ...element(true),
    hasAttribute: () => true,
    querySelectorAll: () => [desktop, compact, close, hiddenLast],
  };
  const exports = {};
  new Function('require', 'exports', 'window', 'document', compiled)(
    () => ({ useEffect: (effect) => { cleanup = effect(); } }), exports,
    { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }, document,
  );
  exports.useFocusTrap({ current: container }, true);
  return { document, desktop, compact, close, container, listeners, cleanup };
}

test('compact settings focus skips the hidden sidebar at entry and at both Tab boundaries', () => {
  const trap = mountTrap();
  assert.equal(trap.document.activeElement, trap.compact);
  let prevented = 0;
  const pressTab = (shiftKey = false) => trap.listeners.get('keydown')({
    key: 'Tab', shiftKey, preventDefault: () => { prevented += 1; },
  });
  trap.close.focus();
  pressTab();
  assert.equal(trap.document.activeElement, trap.compact);
  pressTab(true);
  assert.equal(trap.document.activeElement, trap.close);
  assert.equal(prevented, 2);

  // Re-evaluate visibility on each keypress after a responsive breakpoint change.
  trap.compact.visible = false;
  trap.desktop.visible = true;
  pressTab();
  assert.equal(trap.document.activeElement, trap.desktop);
  trap.cleanup();
  assert.equal(trap.listeners.size, 0);
});

test('focus falls back to the settings shell when no controls have layout boxes', () => {
  const trap = mountTrap();
  trap.compact.visible = false;
  trap.close.visible = false;
  let prevented = false;
  trap.listeners.get('keydown')({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(trap.document.activeElement, trap.container);
  trap.cleanup();
});
