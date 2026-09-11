import assert from "node:assert/strict";
import test from "node:test";
import { startWebBridgePolling } from "./webBridgePolling.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const calls = { status: 0, terminal: 0, operations: 0, connected: 0, errors: 0 };
  let online = false;
  const polling = startWebBridgePolling({
    getStatus: async () => { calls.status++; return { connected: online, paired: true }; },
    drainTerminalCommands: async () => { calls.terminal++; },
    drainOperations: async () => { calls.operations++; },
    onConnected: () => { calls.connected++; },
    onError: () => { calls.errors++; },
    ...overrides,
  });
  t.after(() => polling.stop());
  return { calls, polling, setOnline: (value) => { online = value; } };
}

test("offline/never configured does not poll operations or terminals", async (t) => {
  const { calls } = fixture(t);
  await settle();
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(3_000); await settle(); }
  assert.equal(calls.status, 11);
  assert.equal(calls.terminal, 0);
  assert.equal(calls.operations, 0);
});

test("connect, stop service, reconnect resumes polling and republishes workspace", async (t) => {
  const { calls, polling, setOnline } = fixture(t);
  await settle();
  setOnline(true);
  polling.wake();
  await settle();
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(calls.connected, 1);
  assert.ok(calls.terminal > 0 && calls.operations > 0);
  setOnline(false);
  polling.wake();
  await settle();
  const previous = { ...calls };
  t.mock.timers.tick(6_000);
  await settle();
  assert.equal(calls.terminal, previous.terminal);
  assert.equal(calls.operations, previous.operations);
  setOnline(true);
  polling.wake();
  await settle();
  assert.equal(calls.connected, 2);
  t.mock.timers.tick(1_000);
  await settle();
  assert.ok(calls.terminal > previous.terminal);
});

test("slow status and wake bursts do not create overlapping probes; unmount ignores pending result", async (t) => {
  let resolveStatus;
  let count = 0;
  const { polling, calls } = fixture(t, {
    getStatus: () => { count++; return new Promise((resolve) => { resolveStatus = resolve; }); },
  });
  for (let i = 0; i < 100; i++) polling.wake();
  t.mock.timers.tick(60_000);
  assert.equal(count, 1);
  polling.stop();
  resolveStatus({ connected: true, paired: true });
  await settle();
  t.mock.timers.tick(60_000);
  assert.equal(count, 1);
  assert.equal(calls.connected, 0);
  assert.equal(calls.terminal, 0);
});

test("transport errors and unpaired connections stay on slow status probes", async (t) => {
  let fail = true;
  const { calls, polling } = fixture(t, {
    getStatus: async () => {
      if (fail) throw new Error("daemon unavailable");
      return { connected: true, paired: false };
    },
  });
  await settle();
  assert.equal(calls.errors, 1);
  fail = false;
  polling.wake();
  await settle();
  t.mock.timers.tick(3_000);
  await settle();
  assert.equal(calls.terminal, 0);
  assert.equal(calls.operations, 0);
});

test("slow operation does not stall terminal polling or overlap operation drains", async (t) => {
  let operations = 0;
  let release;
  const { calls, setOnline, polling } = fixture(t, {
    drainOperations: () => { operations++; return new Promise((resolve) => { release = resolve; }); },
  });
  await settle();
  setOnline(true);
  polling.wake();
  await settle();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(1_000); await settle(); }
  assert.equal(operations, 1);
  assert.ok(calls.terminal >= 5);
  release();
  await settle();
});
