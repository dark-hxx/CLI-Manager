import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { loadKeyboardModule, Terminal, write } from "./helpers/loadTerminalKeyboard.mjs";

const { applyTerminalScrollShortcut } = loadKeyboardModule("terminalScrollShortcuts");
const { createTerminalKeyboardOptions } = loadKeyboardModule("terminalKeyboardProtocol");
// Evaluate the real defaults/action registry/migration, without mounting Zustand
// or initializing the user's Tauri settings store.
const settings = readFileSync(new URL("../src/shared/preferences/settingsStore.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("settingsStore.ts", settings, ts.ScriptTarget.Latest, true);
const names = new Set(["SHORTCUT_ACTIONS", "DEFAULT_KEYBOARD_SHORTCUTS", "migrateKeyboardShortcuts"]);
const relevant = ast.statements.filter((node) => names.has(node.name?.text)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.has(item.name.getText(ast)))));
const source = relevant.map((node) => node.getText(ast)).join("\n")
  + "\nexport { SHORTCUT_ACTIONS, migrateKeyboardShortcuts };";
const exports = {};
new Function("exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(exports);
const { DEFAULT_KEYBOARD_SHORTCUTS, SHORTCUT_ACTIONS, migrateKeyboardShortcuts } = exports;

test("old settings acquire Ctrl+Home; customized/disabled bindings and unrelated shortcuts survive", () => {
  assert.equal(DEFAULT_KEYBOARD_SHORTCUTS.scrollToTop, "Ctrl+Home");
  assert.equal(SHORTCUT_ACTIONS.filter((value) => value === "scrollToTop").length, 1);
  assert.equal(migrateKeyboardShortcuts({ copyAi: "Alt+Q" }).scrollToTop, "Ctrl+Home");
  assert.equal(migrateKeyboardShortcuts({ scrollToTop: "Alt+Home" }).scrollToTop, "Alt+Home");
  assert.equal(migrateKeyboardShortcuts({ scrollToTop: "" }).scrollToTop, "");
  assert.equal(migrateKeyboardShortcuts({ scrollToTop: "  " }).scrollToTop, "");
  assert.equal(migrateKeyboardShortcuts({ copyAi: "Alt+Q" }).copyAi, "Alt+Q");
  assert.equal(migrateKeyboardShortcuts(null).scrollToTop, "Ctrl+Home");
});

for (const enhanced of [false, true]) {
  test(`normal history scrolls locally with zero PTY data; alternate passes; typing still returns bottom (${enhanced})`, async (t) => {
    const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 4, scrollback: 100, ...createTerminalKeyboardOptions() });
    t.after(() => terminal.dispose());
    await write(terminal, Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join("") + (enhanced ? "\x1b[>11u" : ""));
    const sent = []; terminal.onData((data) => sent.push(data));
    assert.equal(applyTerminalScrollShortcut(terminal, "Ctrl+Home", DEFAULT_KEYBOARD_SHORTCUTS), true);
    assert.equal(terminal.buffer.active.viewportY, 0);
    assert.equal(applyTerminalScrollShortcut(terminal, "Ctrl+End", DEFAULT_KEYBOARD_SHORTCUTS), true);
    assert.equal(terminal.buffer.active.viewportY, terminal.buffer.active.baseY);
    assert.equal(applyTerminalScrollShortcut(terminal, "PageUp", DEFAULT_KEYBOARD_SHORTCUTS), true);
    assert.ok(terminal.buffer.active.viewportY < terminal.buffer.active.baseY);
    assert.equal(applyTerminalScrollShortcut(terminal, "PageDown", DEFAULT_KEYBOARD_SHORTCUTS), true);
    assert.equal(applyTerminalScrollShortcut(terminal, "Ctrl+Home", { ...DEFAULT_KEYBOARD_SHORTCUTS, scrollToTop: "" }), false);
    assert.equal(applyTerminalScrollShortcut(terminal, "Alt+Home", { ...DEFAULT_KEYBOARD_SHORTCUTS, scrollToTop: "Alt+Home" }), true);
    assert.deepEqual(sent, []);
    terminal.input("x", true);
    assert.equal(terminal.buffer.active.viewportY, terminal.buffer.active.baseY);
    await write(terminal, "\x1b[?1049h");
    assert.equal(applyTerminalScrollShortcut(terminal, "Ctrl+Home", DEFAULT_KEYBOARD_SHORTCUTS), false);
    assert.deepEqual(sent, ["x"]);
  });
}

test("scroll-to-top is discoverable in both settings languages", () => {
  for (const lang of ["zh-CN", "en-US"]) {
    const dictionary = readFileSync(new URL(`../src/shared/i18n/messages/terminal.${lang}.ts`, import.meta.url), "utf8");
    assert.match(dictionary, /"terminal.scrollToTop":\s*"[^\"]+"/);
  }
  const page = readFileSync(new URL("../src/features/settings/components/pages/ShortcutSettingsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /scrollToTop: "terminal.scrollToTop"/);
});
