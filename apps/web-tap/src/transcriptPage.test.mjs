import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptOlder, acceptPage, linesUp, mergePage, parsePage } from "./transcriptPage.ts";

const page = (events, start, cursor, extra = {}) => ({
  available: true, agentSessionId: "s1", parser: 3, start, cursor, size: cursor, more: start > 0, events, ...extra,
});
const a = { kind: "notice", text: "a" };
const b = { kind: "notice", text: "b" };
const c = { kind: "notice", text: "c" };

test("mergePage：增量接在後面、較早的接在前面、重設時整個換掉", () => {
  let state = mergePage(null, page([b], 100, 200), "initial");
  state = mergePage(state, page([c], 200, 300), "newer");
  assert.deepEqual(state.events, [b, c]);
  assert.equal(state.cursor, 300);
  state = mergePage(state, page([a], 0, 100), "older");
  assert.deepEqual(state.events, [a, b, c]);
  assert.equal(state.start, 0);
  assert.equal(state.cursor, 300);
  state = mergePage(state, page([c], 0, 50, { reset: true }), "newer");
  assert.deepEqual(state.events, [c]);
  // 沒有新事件的增量只前進游標，沿用同一個陣列。
  const same = mergePage(state, page([], 50, 60), "newer");
  assert.equal(same.events, state.events);
  assert.equal(same.cursor, 60);
});

test("parsePage 收窄主機的回傳：缺欄位、不認得的事件略過，可有可無的欄位型別不對就拿掉", () => {
  assert.equal(parsePage(null), null);
  assert.equal(parsePage({ available: true, start: 0 }), null);
  assert.equal(parsePage({ available: "yes", start: 0, cursor: 0 }), null);
  const parsed = parsePage({
    parser: 2, available: true, agentSessionId: "abc", start: 10, cursor: 20, size: 30, more: true, reason: "weird", extra: 1,
    events: [
      { kind: "user", uuid: "u", at: 5, text: "hi", images: 2 },
      { kind: "user", text: 42 },
      { kind: "assistant", text: "ok", at: "later", fast: "yes" },
      { kind: "tool", id: "t", name: "Bash" },
      { kind: "result", id: "t", ok: true, diff: [{ oldStart: 1 }] },
      { kind: "tasks", items: [{ id: "1", subject: "一", status: "pending" }, { id: 2 }] },
      { kind: "turn", ms: -1 },
      { kind: "statusLine", text: "x" },
      "junk",
    ],
  });
  assert.deepEqual(parsed, {
    parser: 2, available: true, reason: undefined, agentSessionId: "abc", start: 10, cursor: 20, size: 30, reset: undefined, more: true,
    partial: undefined,
    events: [
      { kind: "user", uuid: "u", at: 5, text: "hi", images: 2 },
      { kind: "assistant", text: "ok" },
      { kind: "result", id: "t", ok: true },
      { kind: "tasks", items: [{ id: "1", subject: "一", status: "pending" }] },
    ],
  });
  assert.equal(parsePage({ available: true, start: 0, cursor: 5, size: 9, more: false, partial: true }).partial, true);
  assert.equal(parsePage({ available: true, start: 0, cursor: 5, size: 9, more: false, partial: "yes" }).partial, undefined);
  const unbound = parsePage({ available: false, reason: "unbound", start: 0, cursor: 0, size: 0, more: false });
  assert.equal(unbound.reason, "unbound");
  assert.deepEqual(unbound.events, []);
});

test("acceptPage：第一次讀到是整頁；增量接在後面，前面還有沒有更早的內容維持原判斷", () => {
  const first = acceptPage(null, false, page([b], 100, 200));
  assert.equal(first.kind, "merged");
  assert.deepEqual(first.meta, { available: true, loaded: true, more: true });
  const next = acceptPage(first.state, true, page([c], 200, 300, { more: false }));
  assert.equal(next.kind, "merged");
  assert.deepEqual(next.state.events, [b, c]);
  assert.equal(next.meta.more, true);
  // 紀錄檔被改寫：整頁換掉，more 照這一頁。
  const reset = acceptPage(next.state, true, page([a], 0, 40, { reset: true, more: false }));
  assert.deepEqual(reset.state.events, [a]);
  assert.equal(reset.meta.more, false);
});

test("acceptPage：換了對話或解析方式要重讀；還沒對上時顯示原因", () => {
  const state = { id: "s1", parser: 3, events: [a], start: 0, cursor: 10 };
  assert.deepEqual(acceptPage(state, false, page([], 0, 0, { agentSessionId: "s2" })), { kind: "rebind" });
  assert.deepEqual(acceptPage(state, false, page([], 0, 0, { parser: 4 })), { kind: "rebind" });
  assert.deepEqual(acceptPage(state, false, { available: false, reason: "unbound", start: 0, cursor: 0, size: 0, more: false, events: [] }),
    { kind: "unbound", meta: { available: false, loaded: true, more: false, reason: "unbound" } });
  // 已經知道是哪段對話、只是還沒寫出第一行：算對上了，對話先顯示空白。
  const empty = acceptPage(null, false, { available: false, reason: "missing", agentSessionId: "s9", start: 0, cursor: 0, size: 0, more: false, events: [] });
  assert.equal(empty.kind, "merged");
  assert.equal(empty.meta.available, true);
  assert.equal(empty.state.id, "s9");
});

test("acceptOlder：同一段對話、範圍沒變才接在前面；對話換了要重讀，範圍變了作廢", () => {
  const state = { id: "s1", parser: 3, events: [b], start: 100, cursor: 200 };
  const requested = { id: "s1", parser: 3, start: 100 };
  const merged = acceptOlder(state, requested, page([a], 0, 100, { more: false }));
  assert.deepEqual(merged.state.events, [a, b]);
  assert.equal(merged.state.start, 0);
  assert.equal(merged.state.cursor, 200);
  assert.equal(merged.more, false);
  assert.equal(acceptOlder(state, requested, page([a], 0, 100, { agentSessionId: "s2" })), "rebind");
  assert.equal(acceptOlder(state, requested, { ...page([a], 0, 100), available: false }), "rebind");
  assert.equal(acceptOlder({ ...state, start: 50 }, requested, page([a], 0, 100)), null);
  assert.equal(acceptOlder(null, requested, page([a], 0, 100)), null);
});

test("linesUp：增量讀取期間只多了更早的內容才接得上；重讀過、換了對話就作廢", () => {
  const requested = { id: "s1", parser: 3, events: [b], start: 100, cursor: 200 };
  assert.equal(linesUp(null, null), true);
  assert.equal(linesUp(requested, { ...requested, events: [a, b], start: 0 }), true);
  assert.equal(linesUp(requested, { ...requested, cursor: 300 }), false);
  assert.equal(linesUp(requested, { ...requested, id: "s2" }), false);
  assert.equal(linesUp(requested, null), false);
  assert.equal(linesUp(null, requested), false);
});

test("parsePage 保留通知的代碼；代碼型別不對就拿掉，照原文顯示", () => {
  const parsed = parsePage({
    available: true, start: 0, cursor: 10, size: 10, more: false,
    events: [
      { kind: "notice", at: 1, code: "turn_interrupted", text: "Turn interrupted" },
      { kind: "notice", at: 2, code: 7, text: "Turn aborted" },
    ],
  });
  assert.deepEqual(parsed.events, [
    { kind: "notice", at: 1, code: "turn_interrupted", text: "Turn interrupted" },
    { kind: "notice", at: 2, text: "Turn aborted" },
  ]);
});

test("acceptPage：同一段對話暫時讀不到時保留手上的內容與游標，不歸零", () => {
  const state = { id: "s1", parser: 3, events: [a, b], start: 0, cursor: 20 };
  const missing = { available: false, reason: "missing", agentSessionId: "s1", start: 0, cursor: 0, size: 0, more: false, events: [] };
  const kept = acceptPage(state, true, missing);
  assert.equal(kept.kind, "merged");
  assert.equal(kept.state, state);
  assert.equal(kept.meta.more, true);
  // 換了對話時照樣重讀。
  assert.deepEqual(acceptPage(state, false, { ...missing, agentSessionId: "s2" }), { kind: "rebind" });
});

test("acceptPage：空白的待寫出狀態直接接受第一頁，不因版本號不同而重讀", () => {
  const pending = { id: "s1", parser: undefined, events: [], start: 0, cursor: 0 };
  const first = acceptPage(pending, false, page([a], 0, 10));
  assert.equal(first.kind, "merged");
  assert.deepEqual(first.state.events, [a]);
  assert.equal(first.state.cursor, 10);
  assert.equal(first.state.parser, 3);
});

test("parsePage：任務項目沒有狀態時當成 pending，不整項丟掉", () => {
  const parsed = parsePage({ available: true, start: 0, cursor: 1, size: 1, more: false, events: [
    { kind: "tasks", items: [{ id: "1", subject: "寫測試" }, { id: "2", subject: "發布", status: "completed" }, { subject: "缺 id" }] },
  ] });
  assert.deepEqual(parsed.events[0].items, [
    { id: "1", subject: "寫測試", status: "pending" },
    { id: "2", subject: "發布", status: "completed" },
  ]);
});
