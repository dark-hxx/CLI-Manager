import test from "node:test";
import assert from "node:assert/strict";
import { cleanupTerminalProcessesForExit } from "../src/lib/terminalExitCleanup.ts";

function createDependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      async closeAll() {
        calls.push(["closeAll"]);
      },
      async close(sessionId) {
        calls.push(["close", sessionId]);
      },
      async shutdownDaemonIfIdle() {
        calls.push(["shutdown"]);
        return true;
      },
      ...overrides,
    },
  };
}

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

test("shutdown failure prevents application exit", async () => {
  const { dependencies } = createDependencies({
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

test("missing daemon still allows application exit", async () => {
  const { calls, dependencies } = createDependencies({
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

test("closeAll failure still exits when daemon confirms it is idle", async () => {
  const { calls, dependencies } = createDependencies({
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
