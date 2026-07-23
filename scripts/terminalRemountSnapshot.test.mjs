import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/XTermTerminal.tsx", import.meta.url),
  "utf8",
);

test("terminal remount snapshots the buffer during layout cleanup", () => {
  assert.match(source, /useLayoutEffect\(\(\) => \(\) => \{[\s\S]*?snapshotBeforeUnmountRef\.current\?\.\(\);[\s\S]*?snapshotBeforeUnmountRef\.current = null;/);
  assert.match(source, /const finishInitialDisplayRestore = \(\) => \{[\s\S]*?snapshotBeforeUnmountRef\.current = \(\) => \{[\s\S]*?updateSessionTerminalSnapshot\(sessionId, serializeAddon\.serialize\(\)\)[\s\S]*?markInitialDisplayReady\(\);/);
  assert.equal(source.match(/snapshotBeforeUnmountRef\.current = \(\) =>/g)?.length, 1);
});

test("PTY output subscription waits for display restore and remains cancellable", () => {
  assert.match(source, /const initialDisplayReady = new Promise<void>/);
  assert.match(source, /terminal\.scrollToBottom\(\);[\s\S]*?refreshTerminalViewport\(terminal\);[\s\S]*?finishInitialDisplayRestore\(\);/);
  assert.match(source, /const finishInitialDisplayRestore = \(\) => \{[\s\S]*?scheduleFit\(true\);[\s\S]*?markInitialDisplayReady\(\);/);
  assert.match(source, /initialDisplayReady\.then\(\(\) => \{[\s\S]*?attachOutputTimer = window\.setTimeout\(\(\) => \{[\s\S]*?attachOutput\(\);/);
  assert.match(source, /if \(attachOutputTimer !== null\) \{[\s\S]*?window\.clearTimeout\(attachOutputTimer\);[\s\S]*?ptyOutput\?\.dispose\(\);/);
});
