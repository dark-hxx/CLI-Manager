import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { loadKeyboardModule, Terminal, SerializeAddon, write } from "./helpers/loadTerminalKeyboard.mjs";

const { createTerminalKeyboardOptions, readTerminalKeyboardState } = loadKeyboardModule("terminalKeyboardProtocol");
const { serializeTerminalWithKeyboardState, preserveTerminalKeyboardSnapshotPrefix } = loadKeyboardModule("terminalKeyboardSnapshot");
const { serializeTerminalSnapshot, restoreTerminalSnapshot } = loadKeyboardModule("terminalSnapshot");

// Execute the production trim function without loading stores, Tauri or timers.
const persistenceSource = readFileSync(new URL("../src/features/terminal/api/sessionSnapshotPersistence.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("persistence.ts", persistenceSource, ts.ScriptTarget.Latest, true);
const trimSource = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === "trimToTailLines").getText(ast);
const trimJS = ts.transpileModule(trimSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const trim = new Function("preserveTerminalKeyboardSnapshotPrefix", `${trimJS}; return trimToTailLines;`)(preserveTerminalKeyboardSnapshotPrefix);
assert.match(persistenceSource, /const snapshot = trimToTailLines\(serialized, SNAPSHOT_MAX_LINES\)/);

function create(t) {
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 5, scrollback: 3000, ...createTerminalKeyboardOptions() });
  t.after(() => terminal.dispose());
  return terminal;
}

function visible(terminal) {
  const buffer = terminal.buffer.active;
  return {
    buffer: buffer.type,
    cursor: [buffer.cursorX, buffer.cursorY],
    lines: Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i).translateToString()),
  };
}

for (const alternate of [false, true]) {
  for (const trimmed of [false, true]) {
    test(`combined mouse/keyboard snapshot: ${alternate ? "alternate" : "normal"}, ${trimmed ? "2000-line tail" : "full"}`, async (t) => {
      const terminal = create(t);
      const restored = create(t);
      const addon = new SerializeAddon(); terminal.loadAddon(addon);
      await write(terminal, Array.from({ length: trimmed ? 2200 : 6 }, (_, i) => `row ${i}\r\n`).join("")
        + "MAIN\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>9u\x1b[>15uOVERLAY");
      if (!alternate) await write(terminal, "\x1b[?1049l");
      await write(terminal, "\x1b[?1002h\x1b[?1006h");
      // Reset onto an already negotiated receiver as well as a fresh one.
      await write(restored, "\x1b[>31u\x1b[>31u\x1b[?1016h\x1b[?1003h");
      for (let round = 0; round < 2; round++) {
        const snapshot = serializeTerminalWithKeyboardState(terminal, () => serializeTerminalSnapshot(terminal, addon));
        const persisted = trimmed ? trim(snapshot, 2000) : snapshot;
        if (trimmed) {
          assert.ok(persisted.length < snapshot.length);
          assert.equal(persisted.includes("row 0\r\n"), false);
          assert.equal((persisted.match(/\n/g) ?? []).length, 1999);
        }
        await write(restored, "\x1b[!p\x1b[?1049l\x1b[H\x1b[2J" + restoreTerminalSnapshot(persisted));
        assert.deepEqual(readTerminalKeyboardState(restored), readTerminalKeyboardState(terminal));
        assert.deepEqual(visible(restored), visible(terminal));
        assert.equal(restored.modes.mouseTrackingMode, "drag");
        assert.equal(restored._core.mouseStateService.activeEncoding, "SGR");
      }
      for (const control of ["\x1b[<u", "\x1b[?47h", "\x1b[<u", "\x1b[<u", "\x1b[?47l", "\x1b[<u"]) {
        await write(terminal, control); await write(restored, control);
        assert.deepEqual(readTerminalKeyboardState(restored), readTerminalKeyboardState(terminal), JSON.stringify(control));
      }
    });
  }
}

test("tail trimming keeps old snapshots unchanged and preserves only our bounded prefix", () => {
  assert.equal(trim("old\nsecond\nlast", 2), "second\nlast");
  assert.equal(trim("old\nsecond", 2), "old\nsecond");
  assert.equal(trim("", 2), "");
  for (const head of ["\x1b[?47l", "\x1b[?47l\x1b[<16u\x1b[=0u", "random PTY text"]) {
    assert.equal(preserveTerminalKeyboardSnapshotPrefix(head + "\nlast", "last"), "last");
  }
});
