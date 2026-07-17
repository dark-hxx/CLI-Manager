import test from "node:test";
import assert from "node:assert/strict";
import * as terminalVisibility from "../src/lib/terminalVisibility.ts";

test("refreshTerminalViewport repaints the full visible terminal grid", () => {
  const calls = [];
  const terminal = {
    rows: 24,
    refresh(start, end) {
      calls.push([start, end]);
    },
  };

  const refreshed = terminalVisibility.refreshTerminalViewport(terminal);

  assert.equal(refreshed, true);
  assert.deepEqual(calls, [[0, 23]]);
});

test("refreshTerminalViewport skips terminals without visible rows", () => {
  const calls = [];
  const terminal = {
    rows: 0,
    refresh(start, end) {
      calls.push([start, end]);
    },
  };

  const refreshed = terminalVisibility.refreshTerminalViewport(terminal);

  assert.equal(refreshed, false);
  assert.deepEqual(calls, []);
});

test("didRenderFullTerminalViewport accepts a render covering every visible row", () => {
  assert.equal(
    terminalVisibility.didRenderFullTerminalViewport({ start: 0, end: 23 }, 24),
    true,
  );
});

test("didRenderFullTerminalViewport rejects partial or empty viewport renders", () => {
  assert.equal(
    terminalVisibility.didRenderFullTerminalViewport({ start: 0, end: 22 }, 24),
    false,
  );
  assert.equal(
    terminalVisibility.didRenderFullTerminalViewport({ start: 1, end: 23 }, 24),
    false,
  );
  assert.equal(
    terminalVisibility.didRenderFullTerminalViewport({ start: 0, end: 0 }, 0),
    false,
  );
});
