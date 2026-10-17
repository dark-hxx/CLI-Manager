import assert from "node:assert/strict";
import { test } from "node:test";
import { createHits, foldText, hitIn, locate, matchOffsets } from "./chatFind.ts";

test("搜尋不分大小寫，正規化後長度不變，位置對得回原文", () => {
  assert.equal(foldText("Hello WORLD 中文"), "hello world 中文");
  // 轉小寫會變長的字（İ → i̇）保持原樣。
  const text = "İstanbul";
  assert.equal(foldText(text).length, text.length);
  assert.equal(foldText(text), "İstanbul");
});

test("找出每一處符合的起點，不重疊", () => {
  assert.deepEqual(matchOffsets("abcabc aaaa", "abc"), [0, 3]);
  assert.deepEqual(matchOffsets("aaaa", "aa"), [0, 2]);
  assert.deepEqual(matchOffsets("abc", ""), []);
});

test("跨文字節點的位置：結尾落在交界時用前一個節點的末端", () => {
  // 三個節點："ab"、"cd"、"ef"
  const starts = [0, 2, 4];
  assert.deepEqual(locate(starts, 0, false), { index: 0, offset: 0 });
  assert.deepEqual(locate(starts, 2, false), { index: 1, offset: 0 });
  assert.deepEqual(locate(starts, 2, true), { index: 0, offset: 2 });
  assert.deepEqual(locate(starts, 5, true), { index: 2, offset: 1 });
});

test("搜尋命中判斷：空白關鍵字不算搜尋，正規表示式的特殊字元照字面比對", () => {
  assert.equal(createHits("   "), null);
  const hits = createHits("  Parse(Turns)  ");
  assert.equal(hits.query, "parse(turns)");
  assert.equal(hits.test("call PARSE(turns) twice"), true);
  assert.equal(hits.test("parse turns"), false);
  assert.equal(hitIn("a.b", createHits(".")), true);
  assert.equal(hitIn("ab", createHits("a.b")), false);
  assert.equal(hitIn("anything", null), false);
  assert.equal(hitIn(undefined, hits), false);
  assert.equal(hitIn("讀取更早的對話", createHits("更早")), true);
});
