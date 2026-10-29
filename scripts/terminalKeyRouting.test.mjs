import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadKeyboardModule, loadSourceModule, Terminal, write } from "./helpers/loadTerminalKeyboard.mjs";

const { createTerminalKeyboardOptions, encodeTerminalKey } = loadKeyboardModule("terminalKeyboardProtocol");
const { createTerminalKeyRouting, isTerminalNewlineComposition } = loadKeyboardModule("terminalKeyRouting");
const { resolveTerminalNewlineKeyEvent } = loadSourceModule(new URL("../src/features/terminal/browser/TerminalNewlineShortcut.ts", import.meta.url));
const { shouldSwallowImeCompositionKeydown } = loadSourceModule(new URL("../src/features/terminal/lib/terminalImeKeyGuard.ts", import.meta.url));

function key(shortcut = "Shift+Enter", extra = {}) {
  return {
    type: "keydown", key: "Enter", code: "Enter", keyCode: 13, repeat: false,
    shiftKey: shortcut === "Shift+Enter", ctrlKey: shortcut === "Ctrl+Enter",
    altKey: shortcut === "Alt+Enter", metaKey: false, preventDefault() {}, ...extra,
  };
}

function fixture(t, escCr = false, extra = {}) {
  const terminal = new Terminal({ allowProposedApi: true, ...createTerminalKeyboardOptions(), ...extra });
  let shortcut = "Shift+Enter";
  let composing = false;
  const sent = [];
  const emissions = [];
  terminal.onData((data) => sent.push(data));
  const routing = createTerminalKeyRouting(terminal, (data, user, kind) => {
    emissions.push({ data, user, kind }); terminal.input(data, user);
  });
  const handler = routing.wrap((event) => {
    const result = resolveTerminalNewlineKeyEvent(event, { shortcut, usesEscCrComposerNewline: escCr });
    if (result.action === "write") { routing.newline(event, result.data); return false; }
    return result.action !== "swallow";
  }, (event) => shouldSwallowImeCompositionKeydown(event, composing) || isTerminalNewlineComposition(event, composing));
  // Simulate native evaluation only when the app did not consume the original.
  const dispatch = (event) => {
    const pass = handler(event);
    if (pass && event.type !== "keypress") {
      const bytes = encodeTerminalKey(terminal, event, event.type, event.repeat);
      if (bytes) terminal.input(bytes, event.type === "keydown");
    }
    return pass;
  };
  t.after(() => { routing.dispose(); terminal.dispose(); });
  return { terminal, sent, emissions, routing, handler, dispatch,
    shortcut: (value) => { shortcut = value; }, composing: (value) => { composing = value; } };
}

for (const shortcut of ["Shift+Enter", "Ctrl+Enter", "Alt+Enter"]) {
  for (const mode of ["legacy", "kitty", "kitty-events", "win32"]) {
    test(`configured ${shortcut} is semantic newline exactly once (${mode})`, async (t) => {
      const f = fixture(t, false, mode === "win32" ? { vtExtensions: { kittyKeyboard: true, win32InputMode: true } } : {});
      const negotiation = { legacy: "", kitty: "\x1b[>1u", "kitty-events": "\x1b[>11u", win32: "\x1b[?9001h" }[mode];
      if (negotiation) await write(f.terminal, negotiation);
      f.shortcut(shortcut);
      assert.equal(f.dispatch(key(shortcut)), false);
      f.dispatch(key(shortcut, { type: "keypress" }));
      f.dispatch(key(shortcut, { type: "keyup", shiftKey: false, ctrlKey: false, altKey: false }));
      const expected = { legacy: ["\n"], kitty: ["\x1b[13;2u"], "kitty-events": ["\x1b[13;2u", "\x1b[13;2:3u"],
        win32: ["\x1b[13;28;13;1;16;1_", "\x1b[13;28;13;0;16;1_"] }[mode];
      assert.deepEqual(f.sent, expected);
      f.sent.length = 0;
      f.dispatch(key("plain"));
      assert.equal(f.sent.length, 1, "plain Enter press is forwarded once");
    });
  }
}

test("held target survives settings/modifier changes, repeat and blur pair correctly", async (t) => {
  const f = fixture(t); await write(f.terminal, "\x1b[>11u");
  f.shortcut("Ctrl+Enter"); f.dispatch(key("Ctrl+Enter"));
  f.shortcut("Alt+Enter"); f.dispatch(key("plain", { repeat: true }));
  f.dispatch(key("plain", { type: "keyup" }));
  assert.deepEqual(f.sent, ["\x1b[13;2u", "\x1b[13;2:2u", "\x1b[13;2:3u"]);
  f.sent.length = 0;
  f.dispatch(key("Alt+Enter")); f.routing.release(); f.routing.release();
  assert.deepEqual(f.sent, ["\x1b[13;2u", "\x1b[13;2:3u"]);
  f.dispatch(key("Alt+Enter", { repeat: true }));
  f.dispatch(key("plain", { type: "keyup" }));
  assert.deepEqual(f.sent, ["\x1b[13;2u", "\x1b[13;2:3u"], "refocus must not leak physical keyup");
  f.dispatch(key("Alt+Enter")); f.routing.release();
  f.sent.length = 0; f.dispatch(key("plain"));
  assert.deepEqual(f.sent, ["\x1b[13u"], "a fresh plain Enter after blur is no longer mapped");
});

test("unmatched chords consume both phases; legacy Codex/Grok policy and native Alt exception remain", async (t) => {
  const f = fixture(t); await write(f.terminal, "\x1b[>11u");
  f.dispatch(key("Ctrl+Enter")); f.dispatch(key("Ctrl+Enter", { type: "keyup" }));
  assert.deepEqual(f.sent, []);
  const codex = fixture(t, true);
  for (const shortcut of ["Shift+Enter", "Ctrl+Enter", "Alt+Enter"]) {
    codex.shortcut(shortcut); codex.dispatch(key(shortcut)); codex.dispatch(key(shortcut, { type: "keyup" }));
  }
  assert.deepEqual(codex.sent, ["\x1b\r", "\x1b\r", "\x1b\r"]);
  codex.shortcut("Shift+Enter"); codex.dispatch(key("Alt+Enter"));
  assert.equal(codex.sent.at(-1), "\x1b\r");
});

test("IME owns initial and held-key events; mode reset drops stale release; dispose forgets", async (t) => {
  const f = fixture(t); await write(f.terminal, "\x1b[>11u");
  f.composing(true); f.dispatch(key()); f.dispatch(key("plain", { key: "Process", keyCode: 229 }));
  f.dispatch(key("plain", { type: "keyup" }));
  assert.deepEqual(f.sent, []);
  f.composing(false); f.dispatch(key());
  f.composing(true); f.dispatch(key("Shift+Enter", { repeat: true }));
  assert.deepEqual(f.sent, ["\x1b[13;2u"]);
  f.composing(false); await write(f.terminal, "\x1bc");
  f.dispatch(key("Shift+Enter", { type: "keyup" }));
  assert.deepEqual(f.sent, ["\x1b[13;2u"]);
  f.routing.dispose();
});

test("other application shortcuts suppress orphan enhanced keyup without swallowing unrelated keys", async (t) => {
  const f = fixture(t); await write(f.terminal, "\x1b[>11u");
  const handler = f.routing.wrap((event) => event.key !== "Home", () => false);
  assert.equal(handler(key("plain", { key: "Home", code: "Home", ctrlKey: true })), false);
  assert.equal(handler(key("plain", { key: "Home", code: "Home", type: "keyup" })), false);
  assert.equal(handler(key("plain", { key: "a", code: "KeyA", type: "keyup" })), true);
  assert.equal(handler(key("plain", { key: "p", code: "KeyP", defaultPrevented: true })), false);
  assert.equal(handler(key("plain", { key: "p", code: "KeyP", type: "keyup" })), false);
  assert.deepEqual(f.sent, []);
});

test("routing identifies legacy direct writes and native onData strokes; release is not user input", async (t) => {
  const f = fixture(t); f.dispatch(key()); f.dispatch(key("plain", { type: "keyup" }));
  assert.deepEqual(f.emissions, [{ data: "\n", user: true, kind: "legacy" }]);
  f.emissions.length = 0;
  await write(f.terminal, "\x1b[>11u");
  f.dispatch(key()); f.dispatch(key("plain", { type: "keyup" }));
  assert.deepEqual(f.emissions, [
    { data: "\x1b[13;2u", user: true, kind: "native" },
    { data: "\x1b[13;2:3u", user: false, kind: "native" },
  ]);
  const other = fixture(t); other.dispatch(key());
  assert.deepEqual(other.sent, ["\n"]);
  assert.equal(f.sent.length, 3, "another terminal cannot write through this instance");
});

test("desktop releases before input teardown and both snapshot sites use the keyboard wrapper", () => {
  const source = readFileSync(new URL("../src/features/terminal/hooks/useXTermController.ts", import.meta.url), "utf8");
  const release = source.indexOf("      keyRouting.release();");
  const detach = source.indexOf("      disposeTerminalSubsystem(inputDisposables);");
  assert.ok(release >= 0 && detach > release);
  assert.equal(source.match(/serializeTerminalWithKeyboardState\(terminal, \(\) => serializeTerminalSnapshot\(terminal, serializeAddon\)\)/g)?.length, 2);
  assert.match(source, /serializeTerminalAfterWrite\([\s\S]*serializeTerminalWithKeyboardState/);
  assert.match(source, /if \(kind === "legacy"\)[\s\S]*terminalProcessManager\.write\(sessionId, data\)/);
});
