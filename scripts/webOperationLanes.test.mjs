import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebOperationLanes } from "../src/shared/lib/webOperationLanes.ts";
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
test("transcript reads bypass slow writes with two lanes while other operations retain order and replay dedup", async () => {
  const started = [], releases = new Map(), errors = [];
  const lanes = createWebOperationLanes(async (item) => {
    started.push(item.id); await new Promise((resolve) => releases.set(item.id, resolve));
  }, (e) => errors.push(e));
  const items = [{ id: "slow", kind: "file.move" }, { id: "write2", kind: "git.commit" },
    ...[1, 2, 3].map((n) => ({ id: `read${n}`, kind: "terminal.transcript" }))];
  lanes.enqueue(items); lanes.enqueue(items); await flush();
  assert.deepEqual(started, ["read1", "read2", "slow"]);
  releases.get("read1")(); await flush();
  assert.deepEqual(started, ["read1", "read2", "slow", "read3"]);
  releases.get("slow")(); await flush();
  assert.equal(started.at(-1), "write2");
  for (const release of releases.values()) release(); await flush();
  assert.equal(errors.length, 0);
});
test("lane errors release capacity; pending queue is bounded", async () => {
  let count = 0;
  const errors = [];
  const lanes = createWebOperationLanes(async () => { count++; throw Error("fixture failure"); }, (e) => errors.push(e));
  lanes.enqueue(Array.from({ length: 1000 }, (_, n) => ({ id: String(n), kind: "terminal.transcript" })));
  for (let n = 0; n < 1000; n++) await Promise.resolve();
  assert.equal(count, 128); assert.equal(errors.length, 128);
});
