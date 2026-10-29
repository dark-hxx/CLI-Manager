import assert from "node:assert/strict";
import { test } from "node:test";
import { hookHarness, loadModule, nodes } from "../tests/reactHarness.mjs";
import * as completion from "./completion.ts";
import * as input from "./input.ts";
import * as format from "./format.ts";
import { loadKeyboardModule, loadSourceModule } from "../../../scripts/helpers/loadTerminalKeyboard.mjs";

const keyboard = loadKeyboardModule("terminalKeyboardProtocol");
const terminalKeys = loadSourceModule(new URL("./terminalKeys.ts", import.meta.url));

function setup() {
  const h = hookHarness(), bytes = [], resize = [], ref = { current: null };
  let term, chunkHandler;
  const noop = () => {}, disposable = () => ({ dispose: noop });
  const frames = new Map(); let frameId = 0;
  const globals = {
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  const viewport = loadModule("terminalViewport.ts", {}, globals);
  class FakeTerminal {
    constructor(options) {
      term = this; this.options = options; this.cols = 120; this.rows = 40;
      this.modes = { bracketedPasteMode: true }; this.textarea = {};
      this.buffer = { active: { cursorX: 90, cursorY: 35 } };
    }
    loadAddon() {} open() {} dispose() {} focus() {} blur() {}
    onData = disposable; onBinary = disposable;
    onRender(fn) { this.render = fn; return { dispose: () => { this.render = null; } }; }
  }
  const host = { scrollTop: 0, scrollLeft: 0, clientWidth: 320, clientHeight: 240,
    querySelector: () => ({ clientWidth: 960, clientHeight: 640 }) };
  const { Terminal } = loadModule("Terminal.tsx", {
    react: { ...h.react, useImperativeHandle: (target, create, deps) => h.react.useLayoutEffect(() => {
      target.current = create(); return () => { target.current = null; };
    }, deps) },
    "react-dom": { flushSync: (fn) => fn() }, "@xterm/xterm": { Terminal: FakeTerminal },
    "@xterm/addon-fit": { FitAddon: class { proposeDimensions() { return { cols: 120, rows: 40 }; } } },
    "@xterm/addon-web-links": { WebLinksAddon: class {} },
    "@xterm/xterm/css/xterm.css": {},
    "../../../src/shared/lib/terminalKeyboardProtocol": keyboard,
    "../../../src/shared/lib/terminalUnicode": { installTerminalUnicode: noop },
    "../../../src/shared/lib/terminalQueryPolicy": { installTerminalQueryPolicy: disposable },
    "../../../src/shared/lib/webTerminalRenderQueue": { createWebTerminalFrames: () => ({ pending: () => false, accept: () => { throw Error("buffer full"); } }) },
    "../../../src/shared/lib/terminalColorQueryFilter": { createTerminalColorQueryFilter: () => ({}) },
    "./terminalWrites": { terminalWrites: { cancel: noop } }, "./completion": completion, "./input": input, "./format": format,
    "./terminalKeys": terminalKeys,
    "./preferences": { PHONE_QUERY: "(max-width: 767px)" }, "./terminalViewport": viewport,
  }, {
    ...globals,
    TextDecoder, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    document: { addEventListener: noop, removeEventListener: noop, visibilityState: "visible" },
  });
  const stream = () => ({ subscribe: (_id, callback) => { chunkHandler = callback; return noop; } });
  const props = { ref, sessionId: "s", stream: stream(), active: true, visible: true, connected: true,
    state: { controlMode: "desktop", cols: 120, rows: 40 }, fontSize: 13, t: (key) => key,
    onInput: (value) => { bytes.push(value); return true; }, onResize: (...value) => resize.push(value), onError: noop, onRetry: noop };
  h.mount(() => Terminal(props));
  assert.equal(ref.current.command("/"), false, "no input before renderer is ready");
  nodes(h.value).find((node) => node.props?.className === "tap-terminal-screen").props.ref.current = host;
  host.addEventListener = noop; host.removeEventListener = noop;
  props.stream = stream(); h.render(); flush();
  return { h, ref, props, bytes, resize, host, flush, get term() { return term; }, breakRenderer: () => chunkHandler({}) };
}

test("production terminal writes a native prefix once, without paste wrappers or submission", () => {
  const f = setup();
  assert.equal(f.ref.current.command("/plugin:skill"), true);
  assert.deepEqual(f.bytes, ["/plugin:skill"]);
  for (const value of ["/mcp\r", "/mcp\n", "/skill args", "\x1b/"]) assert.equal(f.ref.current.command(value), false);
  f.props.connected = false; f.h.render(); assert.equal(f.ref.current.command("/"), false);
  f.props.connected = true; f.props.active = false; f.h.render(); assert.equal(f.ref.current.command("/"), false);
  f.props.active = true; f.h.render(); f.breakRenderer(); assert.equal(f.ref.current.command("/"), false);
  assert.deepEqual(f.bytes, ["/plugin:skill"]);
  f.h.dispose();
});

test("embedded native menu reveals an offscreen prompt without changing the desktop grid", () => {
  const f = setup();
  f.props.nativeMenu = true; f.h.render(); f.flush();
  const promptY = 35 * 16, promptX = 90 * 8;
  assert.ok(f.host.scrollTop <= promptY && f.host.scrollTop + f.host.clientHeight >= promptY + 16);
  assert.ok(f.host.scrollLeft <= promptX && f.host.scrollLeft + f.host.clientWidth >= promptX + 8);
  assert.deepEqual(f.resize, []); assert.equal(f.term.rows, 40); assert.equal(f.term.cols, 120);
  f.term.buffer.active.cursorY = 0; f.term.buffer.active.cursorX = 0; f.term.render(); f.flush();
  assert.equal(f.host.scrollTop, 0); assert.equal(f.host.scrollLeft, 0);
  f.props.nativeMenu = false; f.h.render(); f.flush(); assert.equal(typeof f.term.render, "function");
  f.h.dispose(); assert.equal(f.term.render, null);
});
