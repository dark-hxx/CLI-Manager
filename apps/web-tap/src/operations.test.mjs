import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationRunner } from "./operations.ts";

test("a completed event arriving before POST resolves completes the matching request", async () => {
  let submitted;
  let finishPost;
  const runner = createOperationRunner({
    createOperation: async (deviceId, kind, payload, idempotencyKey) => {
      submitted = { id: "op-a", deviceId, kind, payload, idempotencyKey, status: "running", result: null };
      return new Promise((resolve) => { finishPost = resolve; });
    },
    operation: async () => { throw Error("completed requests must not poll"); },
  });
  const result = runner.run("device-a", "project.start", { targetId: "p1" });
  assert.equal(typeof finishPost, "function", "subscribe and dispatch synchronously before accepting completion events");
  runner.publish({ ...submitted, status: "succeeded", result: { sessionIds: ["pty-a"] } });
  finishPost({ operation: submitted });
  assert.deepEqual(await result, { sessionIds: ["pty-a"] });
});
test("changing scope aborts pending operations and ignores another device's completion", async () => {
  let submitted;
  const runner = createOperationRunner({
    createOperation: async (deviceId, kind, payload, idempotencyKey) => {
      submitted = { id: "op-a", deviceId, kind, payload, idempotencyKey, status: "running", result: null };
      return { operation: submitted };
    }, operation: async () => ({ operation: submitted }),
  });
  const result = runner.run("device-a", "file.list", { projectId: "p1" });
  const rejected = assert.rejects(result, { name: "AbortError" });
  runner.publish({ ...submitted, deviceId: "device-b", status: "succeeded", result: ["wrong"] });
  runner.cancel();
  await rejected;
});

// HTTP 本身挂起时仍应释放对话的单请求占用；虚拟时钟不触发真实网络或长等待。
for (const stalledAt of ["create", "poll"]) test(`a transcript request expires while HTTP ${stalledAt} never returns`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let signal, submitted, outcome;
  const runner = createOperationRunner({
    createOperation: async (deviceId, kind, payload, idempotencyKey, requestSignal) => {
      signal = requestSignal;
      submitted = { id: "op-stalled", deviceId, kind, payload, idempotencyKey, status: "running", result: null };
      return stalledAt === "create" ? new Promise(() => {}) : { operation: submitted };
    },
    operation: async (_, requestSignal) => { signal = requestSignal; return new Promise(() => {}); },
  });
  t.after(() => runner.cancel());
  const pending = runner.run("device-a", "terminal.transcript", { sessionId: "pty-a" });
  void pending.then(() => { outcome = "resolved"; }, (error) => { outcome = error; });
  await Promise.resolve();
  t.mock.timers.tick(59_999);
  await Promise.resolve();
  assert.equal(outcome, undefined);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(outcome?.message, "operation_timed_out");
  assert.equal(signal.aborted, true);
  runner.publish({ ...submitted, status: "succeeded", result: { messages: [] } });
  await Promise.resolve();
  assert.equal(outcome.message, "operation_timed_out", "late completion cannot reclaim an expired request");
});
