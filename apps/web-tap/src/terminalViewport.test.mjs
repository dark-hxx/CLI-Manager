import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "../tests/reactHarness.mjs";

function fixture(menu = false) {
  const frames = new Map(), listeners = new Map();
  let nextFrame = 0, rendered;
  const screen = { clientHeight: 1072, clientWidth: 1910 };
  const container = { clientHeight: 600, clientWidth: 380, scrollHeight: 1072, scrollWidth: 1910,
    scrollTop: 0, scrollLeft: 0, querySelector: () => screen,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  let top = 0, left = 0;
  Object.defineProperties(container, {
    scrollTop: { get: () => top, set: (value) => { top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, value)); } },
    scrollLeft: { get: () => left, set: (value) => { left = Math.max(0, Math.min(container.scrollWidth - container.clientWidth, value)); } },
  });
  const term = { rows: 67, cols: 191, buffer: { active: { cursorY: 66, cursorX: 2, viewportY: 0, baseY: 0 } },
    onRender: (fn) => { rendered = fn; return { dispose: () => { rendered = undefined; } }; } };
  const { installTerminalViewport } = loadModule("terminalViewport.ts", {}, {
    requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const cleanup = installTerminalViewport(term, container, menu);
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  const render = () => { rendered?.(); flush(); };
  const event = (name, values = {}) => {
    const result = { deltaX: 0, deltaY: 0, deltaMode: 0, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    listeners.get(name)?.(result);
    return result;
  };
  flush();
  return { container, term, event, render, cleanup, listeners, frames };
}

test("native viewport reveals the complete cursor row, pauses for reading and resumes at the end", () => {
  const f = fixture();
  assert.equal(f.container.scrollTop, 472);
  f.event("scroll"); f.render();
  assert.equal(f.container.scrollTop, 472, "programmatic reveal must not disable following");
  f.container.scrollTop = 100; f.event("scroll"); f.render();
  assert.equal(f.container.scrollTop, 100);
  f.container.scrollTop = 472; f.event("scroll");
  f.container.clientHeight = 400; f.render();
  assert.equal(f.container.scrollTop, 672, "shrinking the viewport preserves the full row");
  f.cleanup(); assert.equal(f.listeners.size, 0); assert.equal(f.frames.size, 0);
});

test("wheel pans the outer screen, preserves manual position and leaves boundary/zoom events to xterm/browser", () => {
  const f = fixture();
  const up = f.event("wheel", { deltaY: -200 });
  assert.equal(up.prevented, true); assert.equal(up.stopped, true);
  assert.equal(f.container.scrollTop, 272); f.render(); assert.equal(f.container.scrollTop, 272);
  f.container.scrollTop = 0; f.event("scroll");
  assert.equal(f.event("wheel", { deltaY: -200 }).prevented, false, "xterm scrollback works at the outer edge");
  assert.equal(f.event("wheel", { deltaY: 200, ctrlKey: true }).prevented, false, "pinch/zoom is not intercepted");
  f.event("wheel", { deltaY: 5, deltaMode: 1 }); assert.equal(f.container.scrollTop, 80);
  f.event("wheel", { deltaY: 100, shiftKey: true }); assert.equal(f.container.scrollLeft, 100);
  f.render(); assert.equal(f.container.scrollLeft, 100, "output must not undo horizontal reading");
  f.cleanup();
});

test("touch pans both axes, pinch is untouched and xterm history is not pulled to the live cursor", () => {
  const f = fixture();
  f.event("touchstart", { touches: [{ clientX: 200, clientY: 100 }] });
  const move = f.event("touchmove", { touches: [{ clientX: 80, clientY: 200 }] });
  assert.equal(move.prevented, true); assert.equal(f.container.scrollLeft, 120); assert.equal(f.container.scrollTop, 372);
  assert.equal(f.event("touchmove", { touches: [{ clientX: 50, clientY: 220 }, { clientX: 120, clientY: 220 }] }).prevented, false);
  f.term.buffer.active.baseY = 20; f.term.buffer.active.viewportY = 0;
  f.container.scrollTop = 472; f.event("scroll"); f.term.buffer.active.cursorY = 0; f.render();
  assert.equal(f.container.scrollTop, 472, "inner scrollback stays under user control");
  f.cleanup();
});
