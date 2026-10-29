import assert from "node:assert/strict";
import { test } from "node:test";
import { loadKeyboardModule, Terminal, SerializeAddon, write } from "./helpers/loadTerminalKeyboard.mjs";

const { createTerminalKeyboardOptions, readTerminalKeyboardState, encodeTerminalKey, encodeTerminalKeyStroke } =
  loadKeyboardModule("terminalKeyboardProtocol");
const { serializeTerminalWithKeyboardState } = loadKeyboardModule("terminalKeyboardSnapshot");
const enter = { key: "Enter", code: "Enter", keyCode: 13 };
function create(t, extra = {}) {
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 5, ...createTerminalKeyboardOptions(), ...extra });
  t.after(() => terminal.dispose());
  return terminal;
}

test("capability is opt-in, query advertises support without activating Kitty; Win32 is not advertised", async (t) => {
  const legacy = create(t, { vtExtensions: {} });
  const terminal = create(t);
  const replies = [];
  legacy.onData((data) => replies.push(data));
  await write(legacy, "\x1b[?u");
  assert.deepEqual(replies, []);
  terminal.onData((data) => replies.push(data));
  await write(terminal, "\x1b[?u\x1b[?9001h");
  assert.deepEqual(replies, ["\x1b[?0u"]);
  assert.equal(readTerminalKeyboardState(terminal).mode, "legacy");
  assert.equal(terminal.modes.win32InputMode, false);
  assert.equal(encodeTerminalKey(terminal, { ...enter, shiftKey: true }), "\r");
});

test("native evaluator encodes Shift+Enter and negotiated repeat/release, exit restores legacy", async (t) => {
  const terminal = create(t);
  await write(terminal, "\x1b[>1u");
  assert.equal(readTerminalKeyboardState(terminal).mode, "kitty");
  assert.equal(encodeTerminalKeyStroke(terminal, { ...enter, shiftKey: true }), "\x1b[13;2u");
  await write(terminal, "\x1b[=3u");
  assert.equal(encodeTerminalKey(terminal, { ...enter, shiftKey: true }, "keydown", true), "\x1b[13;2:2u");
  // Enter releases require REPORT_ALL_KEYS as well as REPORT_EVENT_TYPES.
  assert.equal(encodeTerminalKey(terminal, { ...enter, shiftKey: true }, "keyup"), "");
  await write(terminal, "\x1b[=11u");
  assert.equal(encodeTerminalKey(terminal, { ...enter, shiftKey: true }, "keyup"), "\x1b[13;2:3u");
  await write(terminal, "\x1b[<u");
  assert.equal(encodeTerminalKeyStroke(terminal, { ...enter, shiftKey: true }), "\r");
});

test("native Win32 encoding is supported by the adapter but not enabled in production options", async (t) => {
  const terminal = create(t, { vtExtensions: { kittyKeyboard: true, win32InputMode: true } });
  await write(terminal, "\x1b[>3u\x1b[?9001h");
  assert.equal(readTerminalKeyboardState(terminal).mode, "win32");
  assert.equal(encodeTerminalKey(terminal, { ...enter, shiftKey: true }), "\x1b[13;28;13;1;16;1_");
  assert.equal(encodeTerminalKey(terminal, { ...enter, shiftKey: true }, "keyup"), "\x1b[13;28;13;0;16;1_");
  await write(terminal, "\x1b[?9001l");
  assert.equal(readTerminalKeyboardState(terminal).mode, "kitty");
});

function state(terminal) {
  const keyboard = readTerminalKeyboardState(terminal);
  const alternate = terminal.buffer.active.type === "alternate";
  return {
    raw: keyboard,
    main: alternate ? keyboard.mainFlags : keyboard.flags,
    alt: alternate ? keyboard.flags : keyboard.altFlags,
    mainStack: keyboard.mainStack, altStack: keyboard.altStack,
    mode: keyboard.mode, buffer: terminal.buffer.active.type,
    cursor: [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY],
    normal: Array.from({ length: terminal.buffer.normal.length }, (_, i) => terminal.buffer.normal.getLine(i).translateToString()),
    active: Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i).translateToString()),
  };
}

for (const alternate of [false, true]) {
  test(`snapshot preserves both stacks, buffer, content and cursor (${alternate ? "alternate" : "normal"})`, async (t) => {
    const terminal = create(t);
    const restored = create(t);
    const serializer = new SerializeAddon(); terminal.loadAddon(serializer);
    await write(terminal, "first\r\nsecond\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>9u\x1b[>15uOVERLAY");
    if (!alternate) await write(terminal, "\x1b[?1049l");
    await write(restored, serializeTerminalWithKeyboardState(terminal, () => serializer.serialize()));
    assert.deepEqual(state(restored), state(terminal));
    for (const control of ["\x1b[<u", "\x1b[?47h", "\x1b[<u", "\x1b[<u", "\x1b[?47l", "\x1b[<u"]) {
      await write(terminal, control); await write(restored, control);
      const a = state(terminal); const b = state(restored);
      for (const key of ["main", "alt", "mainStack", "altStack", "mode", "buffer"]) assert.deepEqual(b[key], a[key], key);
    }
  });
}

test("snapshot resets stale stacks and preserves Win32; old unextended snapshots stay legacy", async (t) => {
  const terminal = create(t, { vtExtensions: { kittyKeyboard: true, win32InputMode: true } });
  const restored = create(t, { vtExtensions: { kittyKeyboard: true, win32InputMode: true } });
  const serializer = new SerializeAddon(); terminal.loadAddon(serializer);
  await write(terminal, "\x1b[>1u\x1b[?9001h");
  await write(restored, "\x1b[>31u\x1b[>31u");
  await write(restored, serializeTerminalWithKeyboardState(terminal, () => serializer.serialize()));
  assert.equal(readTerminalKeyboardState(restored).mode, "win32");
  assert.deepEqual(readTerminalKeyboardState(restored).mainStack, [0]);
  const old = create(t); await write(old, "old snapshot\r\n");
  assert.equal(readTerminalKeyboardState(old).mode, "legacy");
});

test("unsupported internal API is explicit, never silently encoded as LF", () => {
  assert.throws(() => readTerminalKeyboardState({}), /Unsupported xterm keyboard API/);
});

test("full 16-frame stacks and repeated checkpoint roundtrips retain raw flags and future pops", async (t) => {
  let terminal = create(t);
  await write(terminal, "main" + Array.from({ length: 20 }, (_, i) => `\x1b[>${(i % 15) + 1}u`).join("")
    + "\x1b[?1049h" + Array.from({ length: 18 }, (_, i) => `\x1b[>${(i % 7) + 1}u`).join("") + "overlay");
  assert.equal(readTerminalKeyboardState(terminal).mainStack.length, 16);
  assert.equal(readTerminalKeyboardState(terminal).altStack.length, 16);
  for (let round = 0; round < 3; round++) {
    const restored = create(t);
    const serializer = new SerializeAddon(); terminal.loadAddon(serializer);
    await write(restored, serializeTerminalWithKeyboardState(terminal, () => serializer.serialize()));
    assert.deepEqual(state(restored), state(terminal));
    for (const control of ["\x1b[<5u", "\x1b[?47l", "\x1b[<8u", "\x1b[?47h", "\x1b[<16u"]) {
      await write(terminal, control); await write(restored, control);
      assert.deepEqual(readTerminalKeyboardState(restored), readTerminalKeyboardState(terminal));
    }
    terminal = restored;
  }
});
