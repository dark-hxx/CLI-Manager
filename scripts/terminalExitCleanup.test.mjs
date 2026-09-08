import test from "node:test";
import assert from "node:assert/strict";
import { cleanupTerminalProcessesForExit } from "../src/features/terminal/api/terminalExitCleanup.ts";

// 构造记录调用顺序的退出依赖桩并支持覆盖故障行为。
function createDependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      // 记录关闭全部 PTY 的调用。
      async closeAll() {
        calls.push(["closeAll"]);
      },
      // 记录关闭指定 PTY 的调用。
      async close(sessionId) {
        calls.push(["close", sessionId]);
      },
      // 记录空闲守护进程关闭并模拟成功。
      async shutdownDaemonIfIdle() {
        calls.push(["shutdown"]);
        return true;
      },
      ...overrides,
    },
  };
}

// 验证常规退出先关闭所有 PTY 再关闭守护进程。
test("normal exit closes all daemon PTYs before shutdown", async () => {
  const { calls, dependencies } = createDependencies();
  const result = await cleanupTerminalProcessesForExit({
    closePty: true,
    closeAllPty: true,
    foregroundSessionIds: [],
  }, dependencies);

  assert.equal(result.canExit, true);
  assert.deepEqual(calls, [["closeAll"], ["shutdown"]]);
});

// 验证后台运行模式保留 PTY 和守护进程。
test("background daemon exit preserves PTYs and daemon", async () => {
  const { calls, dependencies } = createDependencies();
  const result = await cleanupTerminalProcessesForExit({
    closePty: false,
    closeAllPty: true,
    foregroundSessionIds: ["foreground-1"],
  }, dependencies);

  assert.equal(result.canExit, true);
  assert.deepEqual(calls, []);
});

// 验证守护进程查询失败时仅关闭前台 PTY 后再请求退出。
test("failed daemon query closes only foreground PTYs before shutdown", async () => {
  const { calls, dependencies } = createDependencies();
  const result = await cleanupTerminalProcessesForExit({
    closePty: true,
    closeAllPty: false,
    foregroundSessionIds: ["foreground-1", "foreground-2"],
  }, dependencies);

  assert.equal(result.canExit, true);
  assert.deepEqual(calls, [
    ["close", "foreground-1"],
    ["close", "foreground-2"],
    ["shutdown"],
  ]);
});

// 验证守护进程关闭失败阻止应用退出。
test("shutdown failure prevents application exit", async () => {
  const { dependencies } = createDependencies({
    // 模拟会话仍活动导致守护进程关闭失败。
    async shutdownDaemonIfIdle() {
      throw new Error("sessions active");
    },
  });
  const result = await cleanupTerminalProcessesForExit({
    closePty: true,
    closeAllPty: true,
    foregroundSessionIds: [],
  }, dependencies);

  assert.equal(result.canExit, false);
  assert.match(String(result.shutdownError), /sessions active/);
});

// 验证守护进程不存在时仍允许应用退出。
test("missing daemon still allows application exit", async () => {
  const { calls, dependencies } = createDependencies({
    // 记录关闭请求并模拟守护进程不存在。
    async shutdownDaemonIfIdle() {
      calls.push(["shutdown"]);
      return false;
    },
  });
  const result = await cleanupTerminalProcessesForExit({
    closePty: true,
    closeAllPty: true,
    foregroundSessionIds: [],
  }, dependencies);

  assert.equal(result.canExit, true);
  assert.equal(result.daemonStopped, false);
  assert.deepEqual(calls, [["closeAll"], ["shutdown"]]);
});

// 验证全部关闭应答丢失但守护进程确认空闲时仍能退出。
test("closeAll failure still exits when daemon confirms it is idle", async () => {
  const { calls, dependencies } = createDependencies({
    // 记录全部关闭调用并模拟应答丢失。
    async closeAll() {
      calls.push(["closeAll"]);
      throw new Error("close_all response lost");
    },
  });
  const result = await cleanupTerminalProcessesForExit({
    closePty: true,
    closeAllPty: true,
    foregroundSessionIds: [],
  }, dependencies);

  assert.equal(result.canExit, true);
  assert.match(String(result.closeAllError), /response lost/);
  assert.deepEqual(calls, [["closeAll"], ["shutdown"]]);
});
