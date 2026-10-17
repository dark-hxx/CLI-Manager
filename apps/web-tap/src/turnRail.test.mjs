import assert from "node:assert/strict";
import { test } from "node:test";
import { activeTick, buckets, railPrompts, readingAt } from "./turnRail.ts";
import { captureAnchor, restoreAnchor } from "./chatScroll.ts";
import { groupTurns } from "./turns.ts";

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

const page = (from, to) => Array.from({ length: to - from }, (_, offset) => {
  const index = from + offset;
  return index % 2 ? { id: `s:${index}`, role: "assistant", text: `answer ${index}`, at: `2026-10-17T10:${String(index).padStart(2, "0")}:00Z` }
    : { id: `s:${index}`, role: "user", text: `question ${index}`, at: `2026-10-17T10:${String(index).padStart(2, "0")}:00Z` };
});

test("跳轉點只列有提問的輪次；讀進更早的紀錄後新提問接在前面，原本的 key 不變", () => {
  // 讀取範圍從一輪的中間開始：開頭那一段沒有提問，不列。
  const latest = groupTurns([{ id: "s:5", role: "assistant", text: "tail of turn 4" }, ...page(6, 10)]);
  const first = railPrompts(latest);
  assert.deepEqual(first.map((prompt) => prompt.key), ["s:6", "s:8"]);
  assert.deepEqual(first[0], { key: "s:6", text: "question 6", at: "2026-10-17T10:06:00Z" });
  assert.equal(railPrompts(groupTurns([{ id: "s:5", role: "assistant", text: "tail of turn 4" }, ...page(6, 10)]), first), first,
    "unchanged prompts reuse the array so the rail does not repaint");
  const older = railPrompts(groupTurns(page(0, 10)), first);
  assert.deepEqual(older.map((prompt) => prompt.key), ["s:0", "s:2", "s:4", "s:6", "s:8"]);
  assert.notEqual(older, first);
  assert.deepEqual(older.slice(3), first, "existing anchors keep their keys after older turns are prepended");
});

// 只模擬用到的 DOM：捲動區的位置、`[data-anchor]` 項目與 scrollTop。
function fakeScroller(items, top = 50) {
  const elements = items.map((item) => ({ dataset: { anchor: item.key }, getBoundingClientRect: () => item.rect() }));
  return {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top }),
    querySelectorAll: () => elements,
    querySelector: (selector) => elements.find((element) => selector === `[data-anchor="${element.dataset.anchor}"]`) ?? null,
  };
}

test("讀進更早的內容：記下最上面看得到的那一項，換完內容後放回原來的位置", () => {
  globalThis.CSS ??= { escape: (value) => value };
  let shift = 0;
  const rect = (y, height = 40) => () => ({ top: y + shift, bottom: y + shift + height, height });
  const scroller = fakeScroller([
    { key: "hidden", rect: () => ({ top: 0, bottom: 0, height: 0 }) },
    { key: "s:0", rect: rect(-200) },
    { key: "s:1", rect: rect(30) },
    { key: "s:2", rect: rect(120) },
  ]);
  const anchor = captureAnchor(scroller);
  assert.deepEqual(anchor, { key: "s:1", top: 30 }, "collapsed items and items above the viewport are skipped");
  // 前面插入了 360px 的更早內容。
  shift = 360;
  assert.equal(restoreAnchor(scroller, anchor), true);
  assert.equal(scroller.scrollTop, 360);
  assert.equal(restoreAnchor(scroller, { key: "gone", top: 0 }), false, "a missing anchor lets the caller use the height difference");
  assert.equal(restoreAnchor(scroller, undefined), false);
});
