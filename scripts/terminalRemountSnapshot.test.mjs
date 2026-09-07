import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/features/terminal/hooks/useXTermController.ts", import.meta.url),
  "utf8",
);

test("terminal remount snapshots the buffer during layout cleanup", () => {
  assert.match(source, /useLayoutEffect\(\(\) => \(\) => \{[\s\S]*?snapshotBeforeUnmountRef\.current\?\.\(\);[\s\S]*?snapshotBeforeUnmountRef\.current = null;/);
  assert.match(source, /const finishInitialDisplayRestore = \(hasSnapshot: boolean\) => \{[\s\S]*?snapshotBeforeUnmountRef\.current = \(\) => \{[\s\S]*?updateSessionTerminalSnapshot\(sessionId, serializeAddon\.serialize\(\)\)[\s\S]*?markInitialDisplayReady\(\);/);
  assert.equal(source.match(/snapshotBeforeUnmountRef\.current = \(\) =>/g)?.length, 1);
});

test("PTY output subscription waits for display restore and remains cancellable", () => {
  assert.match(source, /const initialDisplayReady = new Promise<void>/);
  assert.match(source, /terminal\.scrollToBottom\(\);[\s\S]*?refreshTerminalViewport\(terminal\);[\s\S]*?finishInitialDisplayRestore\(true\);/);
  assert.match(source, /const finishInitialDisplayRestore = \(hasSnapshot: boolean\) => \{[\s\S]*?scheduleFit\(true\);[\s\S]*?markInitialDisplayReady\(\);/);
  assert.match(source, /initialDisplayReady\.then\(\(\) => \{[\s\S]*?attachOutputTimer = window\.setTimeout\(\(\) => \{[\s\S]*?attachOutput\(\);/);
  assert.match(source, /if \(attachOutputTimer !== null\) \{[\s\S]*?window\.clearTimeout\(attachOutputTimer\);[\s\S]*?ptyOutput\?\.dispose\(\);/);
});

test("restored shell snapshots fit the current pane and leave a clean output line", () => {
  assert.match(source, /initialDisplayRestoreRaf = window\.requestAnimationFrame\(\(\) => \{[\s\S]*?fitAddon\.proposeDimensions\(\)[\s\S]*?terminal\.resize\(dimensions\.cols, dimensions\.rows\);/);
  assert.match(source, /const restoredCursor = shouldHideCodexCursor\(terminal\) \? "\\x1b\[\?25l" : "\\x1b\[\?25h";/);
  assert.match(source, /const restoredOutput = displayTransformOutputRef\.current\(initialTerminalOutput\);[\s\S]*?terminal\.write\(`\$\{restoredOutput\}\\x1b\[\?6l\\x1b\[r\\x1b\[0m\$\{restoredCursor\}\\x1b\[999B\\r\\n`/);
  assert.match(source, /terminal\.write\([\s\S]*?writeDeferredStartup\(\);[\s\S]*?finishInitialDisplayRestore\(true\);/);
  assert.match(source, /if \(initialDisplayRestoreRaf !== null\) \{[\s\S]*?window\.cancelAnimationFrame\(initialDisplayRestoreRaf\);/);
});

test("only restored snapshots repair the cursor after fit before releasing output", () => {
  const finish = source.slice(source.indexOf("const finishInitialDisplayRestore ="), source.indexOf("let initialDisplayRestoreRaf:"));
  assert.match(finish, /if \(!hasSnapshot\) \{\s*markInitialDisplayReady\(\);\s*return;/);
  assert.match(finish, /terminal\.write\("\\x1b\[999B\\r\\n", \(\) => \{\s*if \(terminalRef\.current !== terminal\) return;\s*terminal\.scrollToBottom\(\);\s*markInitialDisplayReady\(\);/);
  assert.match(source, /\} else \{\s*writeDeferredStartup\(\);\s*finishInitialDisplayRestore\(false\);/);
});
