import assert from "node:assert/strict";
import { test } from "node:test";
import { activeTick, buckets, railPrompts, readingAt } from "./turnRail.ts";

test("刻度夠多時一條一輪，不夠時平均分配、第一條一定是第一輪", () => {
  assert.deepEqual(buckets(3, 10), [0, 1, 2]);
  assert.deepEqual(buckets(10, 4), [0, 2, 5, 7]);
  assert.deepEqual(buckets(0, 4), []);
});

test("讀到的是最後一則頂端在閱讀線以上的提問；都在下面時是第一則", () => {
  const tops = [0, 400, 1200, 2000];
  assert.equal(readingAt(tops, 100), 0);
  assert.equal(readingAt(tops, 400), 1);
  assert.equal(readingAt(tops, 1999), 2);
  assert.equal(readingAt(tops, 5000), 3);
  assert.equal(readingAt([500, 900], 10), 0);
});

test("讀到的那一輪落在涵蓋它的刻度上", () => {
  const ticks = buckets(10, 4);
  assert.equal(activeTick(ticks, 0), 0);
  assert.equal(activeTick(ticks, 4), 1);
  assert.equal(activeTick(ticks, 5), 2);
  assert.equal(activeTick(ticks, 9), 3);
});

test("跳轉點只列每一輪開頭的提問；內容沒變時沿用同一個陣列", () => {
  const items = [
    { type: "user", key: "u1", text: "第一轮", at: 1 },
    { type: "steps", key: "s", steps: [] },
    { type: "user", key: "mid", text: "中途插入" },
    { type: "user", key: "q", text: "排队", queued: true },
    { type: "assistant", key: "a", text: "好" },
    { type: "user", key: "u2", text: "第二轮", at: 2 },
  ];
  const first = railPrompts(items, new Set(["mid"]));
  assert.deepEqual(first, [{ key: "u1", text: "第一轮", at: 1 }, { key: "u2", text: "第二轮", at: 2 }]);
  assert.equal(railPrompts([...items], new Set(["mid"]), first), first);
  assert.notEqual(railPrompts(items.slice(0, 1), new Set(), first), first);
});
