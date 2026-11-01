import test from "node:test";
import assert from "node:assert/strict";
import { createExitStageRunner, runExitBackup } from "../src/app/exitStages.ts";

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("settings loading is inside the backup deadline and cannot launch a late backup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const load = deferred(), events = [];
  let backups = 0;
  const runner = createExitStageRunner(event => events.push(event));
  const task = runExitBackup(runner, { load: () => load.promise, backup: async () => { backups++; return "success"; } });
  await settle();
  t.mock.timers.tick(8000);
  assert.equal((await task).outcome, "timeout");
  load.resolve();
  await settle();
  assert.equal(backups, 0);
  assert.equal(runner.isPending("backup"), false);
  assert.equal(events.at(-1).outcome, "timeout");
});

test("a timed-out noncancellable cleanup blocks duplicate destructive work until it settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wait = deferred();
  const runner = createExitStageRunner();
  let calls = 0;
  const work = () => { calls++; return wait.promise; };
  const task = runner.run("terminals", work, 100);
  await settle();
  t.mock.timers.tick(100);
  assert.equal((await task).outcome, "timeout");
  assert.equal((await runner.run("terminals", work, 100)).outcome, "pending");
  assert.equal(calls, 1);
  wait.resolve(true);
  await settle();
  assert.equal(runner.isPending("terminals"), false);
  assert.equal((await runner.run("terminals", async () => false, 100)).value, false);
});

test("stage success and failure clear timers and record truthful outcomes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [], runner = createExitStageRunner(event => events.push(event));
  assert.equal((await runner.run("snapshots", async () => 7, 100)).value, 7);
  assert.equal((await runner.run("snapshots", async () => { throw new Error("disk failed"); }, 100)).outcome, "failed");
  t.mock.timers.tick(100);
  assert.deepEqual(events.map(event => event.outcome), ["started", "completed", "started", "failed"]);
});
