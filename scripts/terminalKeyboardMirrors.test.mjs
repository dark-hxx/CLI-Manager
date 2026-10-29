import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadKeyboardModule, loadSourceModule, Terminal, SerializeAddon, write } from "./helpers/loadTerminalKeyboard.mjs";

const { createTerminalKeyboardOptions, readTerminalKeyboardState, encodeTerminalKey, encodeTerminalKeyStroke } = loadKeyboardModule("terminalKeyboardProtocol");
const { createTerminalKeyRouting } = loadKeyboardModule("terminalKeyRouting");
const { isClipboardCopyShortcut, isClipboardPasteShortcut } = loadSourceModule(new URL("../apps/web/src/terminalClipboard.ts", import.meta.url));
const { installTerminalQueryPolicy, createTerminalQuerySession, claimTerminalQueryFrame, forgetTerminalQuerySession } = loadKeyboardModule("terminalQueryPolicy");
const { serializeTerminalWithKeyboardState } = loadKeyboardModule("terminalKeyboardSnapshot");
const { terminalKeyBytes } = loadSourceModule(new URL("../apps/web-tap/src/terminalKeys.ts", import.meta.url));
const { keyBytes } = loadSourceModule(new URL("../apps/web-tap/src/input.ts", import.meta.url));

function create(t, extra = {}) {
  const terminal = new Terminal({ allowProposedApi: true, ...createTerminalKeyboardOptions(), ...extra });
  t.after(() => terminal.dispose()); return terminal;
}

test("one hidden desktop owner replies; replay and Web/Tap mirrors parse setters but never reply", async (t) => {
  const owner = create(t), web = create(t), tap = create(t);
  let answer = true;
  const replies = [[], [], []];
  [owner, web, tap].forEach((terminal, index) => {
    terminal.onData((data) => replies[index].push(data));
    const policy = installTerminalQueryPolicy(terminal, () => index === 0 && answer);
    t.after(() => policy.dispose());
  });
  const frame = "\x1b[>3u\x1b[?u\x1b[?9001$p";
  await Promise.all([owner, web, tap].map((term) => write(term, frame)));
  assert.deepEqual(replies, [["\x1b[?3u", "\x1b[?9001;0$y"], [], []]);
  answer = false;
  await write(owner, "\x1b[?u\x1b[?9001$p");
  assert.equal(replies[0].length, 2);
  assert.deepEqual(readTerminalKeyboardState(web), readTerminalKeyboardState(owner));
  assert.deepEqual(readTerminalKeyboardState(tap), readTerminalKeyboardState(owner));
  const serializer = new SerializeAddon(); owner.loadAddon(serializer);
  const late = create(t); const lateReplies = []; late.onData((data) => lateReplies.push(data));
  installTerminalQueryPolicy(late, () => false);
  await write(late, serializeTerminalWithKeyboardState(owner, () => serializer.serialize()));
  assert.deepEqual(readTerminalKeyboardState(late), readTerminalKeyboardState(owner));
  assert.deepEqual(lateReplies, []);
  const id = "keyboard-startup-test";
  createTerminalQuerySession(id);
  assert.equal(claimTerminalQueryFrame(id, 1, true), true);
  assert.equal(claimTerminalQueryFrame(id, 1, true), false);
  assert.equal(claimTerminalQueryFrame(id, 2, false), true);
  forgetTerminalQuerySession(id);
  assert.equal(claimTerminalQueryFrame(id, 1, true), false);
  forgetTerminalQuerySession(id);
});

test("Tap virtual strokes follow native Kitty and Win32 encoding; legacy/application cursor behavior stays unchanged", async (t) => {
  const terminal = create(t, { vtExtensions: { kittyKeyboard: true, win32InputMode: true } });
  for (const sequence of ["", "\x1b[?1h", "\x1b[>11u", "\x1b[?9001h", "\x1b[?9001l\x1b[<u"]) {
    if (sequence) await write(terminal, sequence);
    for (const key of ["esc", "backtab", "interrupt", "slash", "up", "down", "left", "right", "pageup", "pagedown", "tab", "enter"]) {
      for (const modifiers of [{ ctrl: false, alt: false }, { ctrl: true, alt: true }]) {
        const data = terminalKeyBytes(terminal, key, modifiers);
        assert.ok(data.length > 0, `${key} in ${sequence}`);
        if (readTerminalKeyboardState(terminal).mode === "legacy") {
          assert.equal(data, keyBytes(key, modifiers, terminal.modes.applicationCursorKeysMode));
        }
      }
    }
    assert.equal(terminalKeyBytes(terminal, "enter", { ctrl: false, alt: true }),
      readTerminalKeyboardState(terminal).mode === "legacy" ? "\x1b\r"
        : encodeTerminalKeyStroke(terminal, { key: "Enter", code: "Enter", keyCode: 13, altKey: true }));
  }
});

test("Web clipboard consumption pairs release through selection/modifier changes and refocus", async (t) => {
  const terminal = create(t); await write(terminal, "\x1b[>11u");
  let selected = true;
  const sent = []; terminal.onData((data) => sent.push(data));
  const routing = createTerminalKeyRouting(terminal, (data, user) => terminal.input(data, user));
  t.after(() => routing.dispose());
  const handle = routing.wrap((event) => !isClipboardPasteShortcut(event)
    && !isClipboardCopyShortcut(event, selected), () => false);
  const event = (key, extra = {}) => ({ type: "keydown", key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0),
    ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, preventDefault() {}, ...extra });
  const dispatch = (value) => {
    const pass = handle(value);
    if (pass) {
      const bytes = encodeTerminalKey(terminal, value, value.type);
      if (bytes) terminal.input(bytes);
    }
    return pass;
  };
  assert.equal(dispatch(event("c")), false);
  selected = false;
  assert.equal(dispatch(event("c", { type: "keyup", ctrlKey: false })), false);
  assert.equal(dispatch(event("v")), false);
  routing.release();
  assert.equal(dispatch(event("v", { type: "keyup", ctrlKey: false })), false);
  assert.deepEqual(sent, [], "copy/paste must never emit orphan releases");
  assert.equal(dispatch(event("c")), true, "without selection Ctrl+C still interrupts");
  assert.ok(sent.length > 0);
  const source = readFileSync(new URL("../apps/web/src/WebTerminal.tsx", import.meta.url), "utf8");
  assert.match(source, /attachCustomKeyEventHandler\(keyRouting\.wrap\(/);
  assert.match(source, /removeEventListener\("blur", releaseConsumedKeys\)/);
  assert.match(source, /keyRouting\.dispose\(\)/);
});
