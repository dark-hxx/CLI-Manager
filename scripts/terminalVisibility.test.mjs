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

test("planTerminalVisibilityRestore resumes queued active writes when a hidden terminal becomes visible again", () => {
  const plan = terminalVisibility.planTerminalVisibilityRestore({
    wasVisible: false,
    isVisible: true,
    inactiveBufferLength: 0,
    activeWriteQueueLength: 128,
    activeWriteRafScheduled: false,
  });

  assert.deepEqual(plan, {
    shouldFlushInactiveBuffer: false,
    shouldRefreshViewport: true,
    shouldResumeActiveWriteQueue: true,
  });
});

test("planTerminalVisibilityRestore does not reschedule writes when the terminal never became visible", () => {
  const plan = terminalVisibility.planTerminalVisibilityRestore({
    wasVisible: true,
    isVisible: true,
    inactiveBufferLength: 64,
    activeWriteQueueLength: 128,
    activeWriteRafScheduled: false,
  });

  assert.deepEqual(plan, {
    shouldFlushInactiveBuffer: false,
    shouldRefreshViewport: false,
    shouldResumeActiveWriteQueue: false,
  });
});
