import assert from "node:assert/strict";
import { test } from "node:test";
import { publishWebTerminalBatch } from "./webTerminalBackpressure.ts";

test("retries the same explicitly rejected batch before allowing acknowledgement", async () => {
  const events = [];
  let attempts = 0;
  const accepted = await publishWebTerminalBatch(async () => {
    events.push("publish");
    if (++attempts < 3) throw "web device send queue is full";
  }, () => true, async () => { events.push("wait"); });
  if (accepted) events.push("ack");
  assert.deepEqual(events, ["publish", "wait", "publish", "wait", "publish", "ack"]);
});

test("never retries an ambiguous transport failure", async () => {
  let attempts = 0;
  await assert.rejects(publishWebTerminalBatch(async () => {
    attempts += 1;
    throw new Error("web daemon response missing");
  }, () => true, async () => assert.fail("must not retry")), /response missing/);
  assert.equal(attempts, 1);
});

test("generation cancellation stops retry and does not acknowledge", async () => {
  let current = true;
  let attempts = 0;
  assert.equal(await publishWebTerminalBatch(async () => {
    attempts += 1;
    throw "web device send queue is full";
  }, () => current, async () => { current = false; }), false);
  assert.equal(attempts, 1);
});

test("persistent full queue exhausts a bounded wait and reports the original error", async () => {
  let totalWait = 0;
  let attempts = 0;
  await assert.rejects(publishWebTerminalBatch(async () => {
    attempts += 1;
    throw new Error("web device send queue byte limit reached");
  }, () => true, async (milliseconds) => { totalWait += milliseconds; }), /byte limit/);
  assert.equal(attempts, 22);
  assert.ok(totalWait < 10_000);
});
