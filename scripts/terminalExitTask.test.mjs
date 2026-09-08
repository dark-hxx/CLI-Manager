import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldIncludeDaemonExitTask,
  shouldIncludeTerminalExitTask,
} from "../src/features/terminal/api/terminalExitTask.ts";

// 验证运行中的 Hook 与普通 Shell PTY 保持既有退出任务判定。
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

// 验证非 PTY 会话不参与终端退出任务。
test("excludes non-PTY sessions", () => {
  assert.equal(shouldIncludeTerminalExitTask({
    kind: "file-editor",
    processStatus: "running",
    mergedStatus: "running",
    hookStatus: "running",
  }, true), false);
});

// 验证等待关注状态不受已完成任务选项影响。
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

// 验证仅启用选项时才纳入已完成或失败的 Hook 任务。
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

// 验证普通 Shell 完成状态不被当作 CLI 任务。
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

// 验证存活守护会话的已完成任务仍遵守包含选项。
test("finished daemon tasks respect the include-finished setting even while alive", () => {
  for (const taskStatus of ["done", "failed", "completed"]) {
    const candidate = { alive: true, taskStatus };
    assert.equal(shouldIncludeDaemonExitTask(candidate), false);
    assert.equal(shouldIncludeDaemonExitTask(candidate, true), true);
  }
});

// 验证活动守护会话保留既有退出拦截规则。
test("active daemon sessions preserve existing exit interception", () => {
  for (const taskStatus of ["running", "attention", null]) {
    assert.equal(shouldIncludeDaemonExitTask({ alive: true, taskStatus }), true);
  }
  assert.equal(shouldIncludeDaemonExitTask({ alive: false, taskStatus: null }), false);
});
