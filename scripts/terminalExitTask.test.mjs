import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldIncludeDaemonExitTask,
  shouldIncludeTerminalExitTask,
} from "../src/lib/terminalExitTask.ts";

test("keeps the existing running PTY task rule for hook and shell tasks", () => {
  for (const hookStatus of ["running", "none"]) {
    assert.equal(shouldIncludeTerminalExitTask({
      kind: "pty",
      processStatus: "running",
      mergedStatus: "running",
      hookStatus,
    }), true);
  }
});

test("excludes non-PTY sessions", () => {
  assert.equal(shouldIncludeTerminalExitTask({
    kind: "file-editor",
    processStatus: "running",
    mergedStatus: "running",
    hookStatus: "running",
  }, true), false);
});

test("does not change attention handling", () => {
  const candidate = {
    kind: "pty",
    processStatus: "running",
    mergedStatus: "attention",
    hookStatus: "attention",
  };

  assert.equal(shouldIncludeTerminalExitTask(candidate), false);
  assert.equal(shouldIncludeTerminalExitTask(candidate, true), false);
});

test("includes finished hook tasks only when enabled", () => {
  for (const hookStatus of ["done", "failed"]) {
    const candidate = {
      kind: "pty",
      processStatus: "running",
      mergedStatus: hookStatus,
      hookStatus,
    };

    assert.equal(shouldIncludeTerminalExitTask(candidate), false);
    assert.equal(shouldIncludeTerminalExitTask(candidate, true), true);
  }
});

test("does not treat ordinary finished shell commands as CLI tasks", () => {
  for (const shellStatus of ["done", "failed"]) {
    assert.equal(shouldIncludeTerminalExitTask({
      kind: "pty",
      processStatus: "running",
      mergedStatus: shellStatus,
      hookStatus: "none",
    }, true), false);
  }
});

test("finished daemon tasks respect the include-finished setting even while alive", () => {
  for (const taskStatus of ["done", "failed", "completed"]) {
    const candidate = { alive: true, taskStatus };
    assert.equal(shouldIncludeDaemonExitTask(candidate), false);
    assert.equal(shouldIncludeDaemonExitTask(candidate, true), true);
  }
});

test("active daemon sessions preserve existing exit interception", () => {
  for (const taskStatus of ["running", "attention", null]) {
    assert.equal(shouldIncludeDaemonExitTask({ alive: true, taskStatus }), true);
  }
  assert.equal(shouldIncludeDaemonExitTask({ alive: false, taskStatus: null }), false);
});
