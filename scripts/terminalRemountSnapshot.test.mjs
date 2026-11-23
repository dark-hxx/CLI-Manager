import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/features/terminal/hooks/useXTermController.ts", import.meta.url),
  "utf8",
);

test("terminal remount snapshots the buffer during layout cleanup", () => {
  assert.match(source, /useLayoutEffect\(\(\) => \(\) => \{[\s\S]*?snapshotBeforeUnmountRef\.current\?\.\(\);[\s\S]*?snapshotBeforeUnmountRef\.current = null;/);
  assert.match(source, /const finishInitialDisplayRestore = \(hasSnapshot: boolean\) => \{[\s\S]*?snapshotBeforeUnmountRef\.current = \(\) => \{[\s\S]*?updateSessionTerminalSnapshot\(\s*sessionId, serializeTerminalWithKeyboardState\(terminal, \(\) => serializeTerminalSnapshot\(terminal, serializeAddon, 2000\)\),\s*\)[\s\S]*?markInitialDisplayReady\(\);/);
  assert.equal(source.match(/snapshotBeforeUnmountRef\.current = \(\) =>/g)?.length, 1);
});

test("PTY output subscription waits for display restore and remains cancellable", () => {
  assert.match(source, /const initialDisplayReady = new Promise<void>/);
  assert.match(source, /terminal\.scrollToBottom\(\);[\s\S]*?refreshTerminalViewport\(terminal\);[\s\S]*?finishInitialDisplayRestore\(true\);/);
  assert.match(source, /const finishInitialDisplayRestore = \(hasSnapshot: boolean\) => \{[\s\S]*?scheduleFit\(true\);[\s\S]*?markInitialDisplayReady\(\);/);
  assert.match(source, /initialDisplayReady\.then\(\(\) => \{[\s\S]*?attachOutputTimer = window\.setTimeout\(\(\) => \{[\s\S]*?attachOutput\(\);/);
  assert.match(source, /if \(attachOutputTimer !== null\) \{[\s\S]*?window\.clearTimeout\(attachOutputTimer\);[\s\S]*?ptyOutput\?\.dispose\(\);/);
});

test("restored snapshots fit the current pane; only a recreated PTY gets fresh default modes", () => {
  assert.match(source, /initialDisplayRestoreRaf = window\.requestAnimationFrame\(\(\) => \{[\s\S]*?fitAddon\.proposeDimensions\(\)[\s\S]*?terminal\.resize\(dimensions\.cols, dimensions\.rows\);/);
  assert.match(source, /const restoredCursor = shouldHideCodexCursor\(terminal\) \? "\\x1b\[\?25l" : "\\x1b\[\?25h";/);
  assert.match(source, /const freshPtyModes = recreatedPtyDisplay \? "\\x1b\[\?6l\\x1b\[r\\x1b\[0m" : "";/);
  assert.match(source, /const restoredOutput = displayTransformOutputRef\.current\(restoreTerminalSnapshot\(initialTerminalOutput\)\);[\s\S]*?terminal\.write\(`\$\{restoredOutput\}\$\{freshPtyModes\}\$\{restoredCursor\}`/);
  assert.match(source, /scheduleViewportRefresh\(\);\s*finishInitialDisplayRestore\(true\);/);
  assert.match(source, /if \(initialDisplayRestoreRaf !== null\) \{[\s\S]*?window\.cancelAnimationFrame\(initialDisplayRestoreRaf\);/);
});

test("a live PTY remount releases output at the serialized cursor without parking it", () => {
  const finish = source.slice(source.indexOf("const finishInitialDisplayRestore ="), source.indexOf("let initialDisplayRestoreRaf:"));
  assert.match(finish, /if \(!hasSnapshot \|\| !recreatedPtyDisplay\) \{\s*if \(hasSnapshot\) terminal\.scrollToBottom\(\);\s*markInitialDisplayReady\(\);\s*return;/);
  assert.match(source, /\} else \{\s*finishInitialDisplayRestore\(false\);/);
  // Cursor parking desynchronizes xterm from the live PTY's own cursor model.
  assert.doesNotMatch(source, /999B/);
});

test("a recreated PTY clears the restored viewport once before releasing output and never sends input", () => {
  assert.match(source, /const recreatedPtyDisplay = !!initialTerminalOutput\s*&& useTerminalStore\.getState\(\)\.recreatedPtyDisplayPendingSessionIds\.has\(sessionId\);/);
  const finish = source.slice(source.indexOf("const finishInitialDisplayRestore ="), source.indexOf("let initialDisplayRestoreRaf:"));
  assert.match(finish, /releaseViewportForRecreatedPty\(terminal, \(\) => \{\s*if \(terminalRef\.current !== terminal\) return;\s*terminal\.scrollToBottom\(\);\s*completeRecreatedPtyDisplay\(\);\s*markInitialDisplayReady\(\);\s*\}\);/);

  const complete = source.slice(source.indexOf("const completeRecreatedPtyDisplay ="), source.indexOf("let resolveInitialDisplayReady"));
  assert.match(complete, /recreatedPtyDisplayPendingSessionIds: new Set\(\s*\[\.\.\.state\.recreatedPtyDisplayPendingSessionIds\]\.filter\(\(id\) => id !== sessionId\)/);
  // Restore never replays a startup command from the display path.
  assert.doesNotMatch(complete, /terminalProcessManager\.write/);
  assert.doesNotMatch(source, /deferStartupUntilInitialOutput|formatStartupInputForPty/);
});
