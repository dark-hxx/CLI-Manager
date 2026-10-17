import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignStart, buildTimeline, foldModel, groupCommands, insertedKeys, itemText, keepUnchanged, noticeKey, statusModel, turnModel, workFolds,
} from "./transcript.ts";
import { duration } from "./format.ts";

// 只比對 expected 裡有寫的欄位（對應 vitest 的 toMatchObject）。
const like = (actual, expected) => {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual?.[key], value, key);
};

const events = [
  { kind: "user", uuid: "u1", at: 1000, text: "修一下登录页" },
  { kind: "thinking", uuid: "a1", at: 1100, text: "先看看" },
  { kind: "tool", uuid: "a1", at: 1200, id: "t1", name: "Read", summary: "src/Login.tsx" },
  { kind: "result", uuid: "r1", at: 1300, id: "t1", ok: true },
  { kind: "tool", uuid: "a2", at: 1400, id: "t2", name: "Edit", summary: "src/Login.tsx" },
  {
    kind: "result", uuid: "r2", at: 1500, id: "t2", ok: true,
    diff: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }], added: 1, removed: 1,
  },
  { kind: "task", at: 1550, op: "create", id: "1", subject: "修复遮挡" },
  { kind: "task", at: 1560, op: "update", id: "1", status: "in_progress" },
  { kind: "assistant", uuid: "a3", at: 1600, text: "改好了。" },
  { kind: "turn", at: 1700, ms: 700 },
  { kind: "title", text: "修复登录页" },
  { kind: "mode", value: "acceptEdits" },
  { kind: "cost", usd: 0.5 },
];

test("回覆帶上自己的模型，思考強度取當時最新的狀態", () => {
  const timeline = buildTimeline([
    { kind: "status", effort: "max" },
    { kind: "user", uuid: "u1", text: "改一下" },
    { kind: "assistant", uuid: "a1", text: "好", model: "claude-opus-5-5" },
    { kind: "status", effort: "low" },
    { kind: "assistant", uuid: "a2", text: "再來", model: "claude-sonnet-5-5[1m]", fast: true },
  ]);
  const replies = timeline.items.filter((item) => item.type === "assistant");
  like(replies[0], { model: "claude-opus-5-5", effort: "max", fast: undefined });
  like(replies[1], { model: "claude-sonnet-5-5[1m]", effort: "low", fast: true });
});

test("摺疊列上的模型名稱只寫系列與版本；Codex 的照原樣，合成的不顯示", () => {
  assert.equal(turnModel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(turnModel("claude-sonnet-5-5[1m]"), "Sonnet 5.5");
  assert.equal(turnModel("claude-opus-4-1"), "Opus 4.1");
  assert.equal(turnModel("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
  assert.equal(turnModel("claude-3-5-haiku-20241022"), "Haiku 3.5");
  assert.equal(turnModel("claude-opus-4-20250514"), "Opus 4");
  assert.equal(turnModel("gpt-5.5-codex"), "gpt-5.5-codex");
  assert.equal(turnModel("<synthetic>"), undefined);
  assert.equal(turnModel(undefined), undefined);
});

test("摺疊列與工作中膠囊標的模型：思考強度照 CLI 的英文名稱，快速模式另外標", () => {
  const answer = { type: "assistant", key: "a", text: "好", model: "claude-opus-5-5", effort: "xhigh", fast: true };
  const work = [{ type: "assistant", key: "w", text: "先看看", model: "gpt-5.5-codex" }];
  assert.deepEqual(foldModel(answer, work), { model: "Opus 5.5", effort: "Extra high", fast: true });
  assert.deepEqual(foldModel({ type: "turn", key: "d", ms: 1 }, work), { model: "gpt-5.5-codex", effort: undefined, fast: undefined });
  assert.equal(foldModel(undefined, []), null);
  assert.deepEqual(statusModel({ model: "claude-opus-5-5", effort: "max", speed: "fast" }), { model: "Opus 5.5", effort: "Max", fast: true });
  assert.equal(statusModel({ effort: "max" }), null);
});

test("開頭的思考自成一行，工具收成一段步驟，結果接回對應的工具；花費與審批模式不進時間軸", () => {
  const timeline = buildTimeline(events);
  assert.deepEqual(timeline.items.map((item) => item.type), ["user", "thought", "steps", "assistant", "turn"]);
  like(timeline.items[1], { type: "thought", text: "先看看" });
  const steps = timeline.items[2];
  assert.equal(steps.steps.length, 2);
  assert.equal(steps.steps[1].result.added, 1);
  assert.equal(timeline.title, "修复登录页");
  assert.deepEqual(timeline.tasks, [{ id: "1", subject: "修复遮挡", status: "in_progress" }]);
  assert.equal(timeline.open, undefined);
  assert.equal(timeline.lastPromptAt, 1000);
  assert.equal("mode" in timeline, false);
  assert.equal("cost" in timeline, false);
  // 收尾列記下這一輪的回覆、提問與編輯的增刪行數。
  like(timeline.items[4], { text: "改好了。", prompt: timeline.items[0].key, added: 1, removed: 1, ms: 700 });
});

test("沒有內容的思考只留思考時間，工具之間的不列出，有內容的才算一步", () => {
  const timeline = buildTimeline([
    { kind: "user", uuid: "u", text: "看一下" },
    { kind: "thinking", uuid: "a", ms: 2000 },
    { kind: "thinking", uuid: "b", ms: 1000 },
    { kind: "tool", uuid: "c", id: "t", name: "Read", summary: "a.ts" },
    { kind: "result", uuid: "r", id: "t", ok: true },
    { kind: "thinking", uuid: "d", ms: 500 },
    { kind: "thinking", uuid: "e", text: "再看测试", ms: 800 },
    { kind: "tool", uuid: "f", id: "s", name: "Read", summary: "a.test.ts" },
    { kind: "thinking", uuid: "g" },
  ]);
  assert.deepEqual(timeline.items.map((item) => item.type), ["user", "thought", "steps"]);
  like(timeline.items[1], { type: "thought", ms: 3000 });
  assert.ok(!timeline.items[1].text);
  const steps = timeline.items[2];
  assert.deepEqual(steps.steps.map((step) => step.type), ["tool", "thinking", "tool"]);
  like(steps.steps[1], { text: "再看测试", ms: 800 });
});

test("最後一個沒有結果的工具視為正在執行或等批准", () => {
  const timeline = buildTimeline([
    { kind: "user", uuid: "u", text: "跑测试" },
    { kind: "tool", uuid: "a", id: "b1", name: "Bash", summary: "npm test", detail: "npm test" },
  ]);
  assert.equal(timeline.open?.summary, "npm test");
});

test("計劃獨立成卡片，結果接回計劃；排隊中的訊息顯示為使用者訊息", () => {
  const timeline = buildTimeline([
    { kind: "tool", uuid: "a", id: "p", name: "ExitPlanMode", summary: "", detail: "# 计划" },
    { kind: "result", uuid: "r", id: "p", ok: true },
    { kind: "queued", text: "顺便看看测试" },
  ]);
  like(timeline.items[0], { type: "plan", text: "# 计划" });
  assert.equal(timeline.items[0].result.ok, true);
  like(timeline.items[1], { type: "user", queued: true });
});

test("TodoWrite 的整份清單取代原本的任務；刪除的任務不再顯示", () => {
  const timeline = buildTimeline([
    { kind: "task", op: "create", id: "9", subject: "旧的" },
    { kind: "tasks", items: [{ id: "0", subject: "一", status: "completed" }, { id: "1", subject: "二", status: "pending" }] },
    { kind: "task", op: "update", id: "0", status: "deleted" },
  ]);
  assert.deepEqual(timeline.tasks.map((task) => task.subject), ["二"]);
});

test("收尾列記得這一輪的提問：插入的訊息不算，被打斷的那一輪由下一則接手", () => {
  const timeline = buildTimeline([
    { kind: "user", uuid: "u1", text: "第一轮" },
    { kind: "queued", text: "顺便看看测试" },
    { kind: "assistant", uuid: "a1", text: "好" },
    { kind: "turn", ms: 1000 },
    { kind: "user", uuid: "u2", text: "被打断的一轮" },
    { kind: "notice", code: "turn_interrupted", text: "[Request interrupted by user]" },
    { kind: "user", uuid: "u3", text: "重新问" },
    { kind: "assistant", uuid: "a2", text: "好" },
    { kind: "turn", ms: 1000 },
    { kind: "command", uuid: "c1", name: "/review" },
    { kind: "assistant", uuid: "a3", text: "审查完了" },
    { kind: "turn", ms: 1000 },
    { kind: "notice", text: "背景任务完成" },
    { kind: "assistant", uuid: "a4", text: "看到了" },
    { kind: "turn", ms: 1000 },
  ]);
  const key = (type, text) => timeline.items.find((item) => item.type === type && (item.text === text || item.name === text))?.key;
  const prompts = timeline.items.flatMap((item) => item.type === "turn" ? [item.prompt] : []);
  assert.deepEqual(prompts, [key("user", "第一轮"), key("user", "重新问"), key("command", "/review"), undefined]);
});

test("命令輸出保留帶顏色的版本；錯誤記下重試次數", () => {
  const ansi = `${String.fromCharCode(27)}[1mContext Usage`;
  const timeline = buildTimeline([
    { kind: "command", uuid: "c", name: "/context" },
    { kind: "commandOutput", uuid: "o", text: "Context Usage", ansi },
    { kind: "error", at: 9, text: "API Error: overloaded", attempt: 2, max: 10 },
    { kind: "compact", at: 10 },
  ]);
  like(timeline.items[1], { type: "output", text: "Context Usage", ansi });
  like(timeline.items[2], { type: "error", attempt: 2, max: 10 });
  assert.equal(timeline.items[3].type, "compact");
});

test("duration 依長短換單位", () => {
  assert.equal(duration(450), "0.5s");
  assert.equal(duration(12_000), "12s");
  assert.equal(duration(83_000), "1m 23s");
  assert.equal(duration(3_900_000), "1h 5m");
});

const tool = (key, name) => ({ type: "tool", key, id: key, name, summary: key });
const shape = (steps) => groupCommands(steps).map((entry) =>
  entry.type === "commands" ? `[${entry.steps.map((step) => step.key).join(",")}]×${entry.count}` : entry.step.key);

test("連續的命令合成一組，中間夾了別的步驟就斷開", () => {
  assert.deepEqual(shape([
    tool("a", "Bash"), tool("b", "Bash"), tool("c", "BashOutput"), tool("d", "Bash"), tool("r", "Read"), tool("e", "Bash"), tool("f", "Bash"),
  ]), ["[a,b,c,d]×3", "r", "[e,f]×2"]);
});

test("只有一條命令時照常一列；思考也會斷開", () => {
  assert.deepEqual(shape([tool("a", "Bash"), { type: "thinking", key: "t", text: "想一下" }, tool("b", "Bash"), tool("c", "BashOutput")]),
    ["a", "t", "b", "c"]);
});

test("組的 key 跟著第一個步驟，後面加命令時不變", () => {
  const first = groupCommands([tool("a", "Bash"), tool("b", "Bash")]);
  const later = groupCommands([tool("a", "Bash"), tool("b", "Bash"), tool("c", "Bash")]);
  assert.equal(first[0].key, "commands:a");
  assert.equal(later[0].key, "commands:a");
});

const user = (key, at) => ({ type: "user", key, text: key, at });
const steer = (key, at) => ({ type: "user", key, text: key, at, queued: true });
const say = (key, at) => ({ type: "assistant", key, text: key, at });
const steps = (key, at) => ({ type: "steps", key, steps: [], at });
const think = (key) => ({ type: "thought", key, ms: 1000 });
const turn = (key) => ({ type: "turn", key, ms: 83_000 });
const ranges = (items, live = false) => workFolds(items, live)
  .map((fold) => `${items.slice(fold.start, fold.end).map((item) => item.key).join(",")}${fold.ms ? ` ${fold.ms}` : ""}`);

test("做完的一輪：提問之後、最後回答之前的過程收起來，有收尾列時用它的用時", () => {
  assert.deepEqual(ranges([user("q"), think("t"), steps("s1"), say("interim"), steps("s2"), say("a1"), say("a2"), turn("end")]),
    ["t,s1,interim,s2 83000"]);
});

test("沒有收尾列（SDK 跑的對話）也收：後面有新的提問，或 CLI 已經停下來", () => {
  const items = [user("q", 0), steps("s", 1000), say("a", 61_000), user("q2", 90_000), steps("s2"), say("b")];
  assert.deepEqual(ranges(items), ["s 61000", "s2"]);
  // 最後一輪還在做：先不收
  assert.deepEqual(ranges(items, true), ["s 61000"]);
});

test("沒有回答、只有回答的那一輪不收", () => {
  assert.deepEqual(ranges([user("q"), steps("s"), turn("end")]), []);
  assert.deepEqual(ranges([user("q"), say("a"), turn("end")]), []);
  assert.deepEqual(ranges([{ type: "command", key: "c", name: "/context" }, { type: "output", key: "o", text: "..." }]), []);
});

test("只讀了最後一頁、頁首落在一輪中間：開頭到第一則提問之間也照樣收", () => {
  assert.deepEqual(ranges([steps("s0", 0), say("mid", 5000), steps("s1", 9000), say("a", 12_000), user("q"), say("b")]), ["s0,mid,s1"]);
});

test("SDK 在工具結果後面直接送進來的訊息算中途插入，不切斷這一輪", () => {
  const items = [user("q", 0), steps("s1", 1000), user("mid", 20_000), steps("s2", 21_000), say("a", 50_000), user("q2", 60_000), say("b")];
  assert.deepEqual(ranges(items), ["s1 20000", "s2 30000"]);
  assert.deepEqual([...insertedKeys(items)], ["mid"]);
});

test("回答後面的通知（背景工作完成）不影響：照樣收，下一則訊息是新的一輪", () => {
  const notice = (key) => ({ type: "notice", key, text: key });
  assert.deepEqual(ranges([user("q", 0), steps("s1", 1000), say("a", 9000), notice("n"), user("q2", 20_000), steps("s2"), say("b")]),
    ["s1 9000", "s2"]);
});

test("中途插入的訊息把過程分成兩段，各自收起，插入的訊息留在外面", () => {
  const items = [user("q", 0), steps("s1", 1000), steer("x", 20_000), steps("s2", 21_000), say("a", 50_000), turn("end")];
  assert.deepEqual(ranges(items), ["s1 20000", "s2 30000"]);
  assert.deepEqual([...insertedKeys(items)], ["x"]);
});

test("前面讀進更早的內容時，後面項目的 key 不變（清單不重建、畫面不跳）", () => {
  const later = [
    { kind: "user", uuid: "u2", at: 3000, text: "第二个问题" },
    { kind: "assistant", uuid: "a2", at: 4000, text: "回答二" },
    { kind: "notice", at: 5000, text: "后台命令完成" },
  ];
  const older = [{ kind: "user", uuid: "u1", at: 1000, text: "第一个问题" }, { kind: "assistant", uuid: "a1", at: 2000, text: "回答一" }];
  const keys = (list) => buildTimeline(list).items.map((item) => item.key);
  const before = keys(later);
  assert.deepEqual(keys([...older, ...later]).slice(-before.length), before);
});

test("同一行紀錄出了幾項時 key 加上序號，不會重複", () => {
  const timeline = buildTimeline([
    { kind: "assistant", uuid: "x", text: "先说一句" },
    { kind: "assistant", uuid: "x", text: "再说一句" },
  ]);
  assert.deepEqual(timeline.items.map((item) => item.key), ["a-x", "a-x-1"]);
});

test("內容沒變的項目沿用上一次的物件；有變（例如步驟拿到結果）才換新的", () => {
  const step = (result) => ({
    type: "steps", key: "s",
    steps: [{ type: "tool", key: "k", id: "k", name: "Bash", summary: "npm test", result: result === undefined ? undefined : { kind: "result", id: "k", ok: result } }],
  });
  const first = keepUnchanged([{ type: "user", key: "u", text: "问" }, step()], new Map());
  const again = keepUnchanged([{ type: "user", key: "u", text: "问" }, step()], first.cache);
  assert.equal(again.items[0], first.items[0]);
  assert.equal(again.items[1], first.items[1]);
  const done = keepUnchanged([{ type: "user", key: "u", text: "问" }, step(true)], again.cache);
  assert.equal(done.items[0], first.items[0]);
  assert.notEqual(done.items[1], first.items[1]);
});

test("長對話先畫最後一段：起點落在收起來的過程中間時，改從那一輪的提問開始", () => {
  const items = [
    { type: "user", key: "u1", text: "a" },
    { type: "steps", key: "s1", steps: [] },
    { type: "steps", key: "s2", steps: [] },
    { type: "assistant", key: "a1", text: "done" },
    { type: "user", key: "u2", text: "b" },
  ];
  const folds = [{ key: "f1", start: 1, end: 3 }];
  assert.equal(alignStart(items, folds, 2), 0);
  assert.equal(alignStart(items, folds, 1), 0);
  assert.equal(alignStart(items, folds, 3), 3);
  assert.equal(alignStart(items, folds, 4), 4);
  assert.equal(alignStart(items, folds, -5), 0);
});

test("收起來的內容裡可以搜尋的字：步驟的摘要、命令、輸出與改動", () => {
  const timeline = buildTimeline([
    { kind: "tool", id: "b", name: "Bash", summary: "npm test", detail: "npm test -- --watch" },
    { kind: "result", id: "b", ok: false, text: "1 failed" },
    { kind: "tool", id: "e", name: "Edit", summary: "a.ts" },
    { kind: "result", id: "e", ok: true, diff: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old line", "+new line"] }] },
  ]);
  const text = itemText(timeline.items[0]);
  for (const part of ["npm test -- --watch", "1 failed", "a.ts", "old line", "new line"]) assert.ok(text.includes(part), part);
  assert.equal(itemText({ type: "compact", key: "x" }), "");
});

test("有代碼的通知照介面語言顯示：已知代碼對到文案，不認得的代碼與沒有代碼的照原文", () => {
  const timeline = buildTimeline([
    { kind: "user", uuid: "u", text: "跑一下" },
    { kind: "notice", at: 1, code: "turn_interrupted", text: "Turn interrupted" },
    { kind: "notice", at: 2, code: "turn_replaced", text: "Turn replaced by a new request" },
    { kind: "notice", at: 3, code: "turn_aborted", text: "Turn aborted" },
    { kind: "notice", at: 4, code: "something_new", text: "Something new" },
    { kind: "notice", at: 5, text: "后台命令完成" },
  ]);
  const notices = timeline.items.filter((item) => item.type === "notice");
  assert.deepEqual(notices.map((item) => item.code), ["turn_interrupted", "turn_replaced", "turn_aborted", "something_new", undefined]);
  assert.deepEqual(notices.map((item) => noticeKey(item.code)), ["noticeInterrupted", "noticeReplaced", "noticeAborted", undefined, undefined]);
  assert.equal(noticeKey("toString"), undefined);
  assert.equal(noticeKey("line_truncated"), "noticeTruncated");
  // 搜尋找的是畫面上的字：有代碼的用介面文案，其他照原文。
  const label = (key) => ({ noticeInterrupted: "已中断本轮对话", noticeReplaced: "本轮被新的请求取代", noticeAborted: "本轮已中止" })[key];
  assert.deepEqual(notices.map((item) => itemText(item, label)), ["已中断本轮对话", "本轮被新的请求取代", "本轮已中止", "Something new", "后台命令完成"]);
  assert.equal(itemText(notices[0]), "Turn interrupted");
});

test("代碼不同的通知換了內容指紋，畫面會更新", () => {
  const notice = (code) => ({ type: "notice", key: "n", text: "Turn interrupted", code });
  const first = keepUnchanged([notice("turn_interrupted")], new Map());
  const again = keepUnchanged([notice("turn_aborted")], first.cache);
  assert.notEqual(again.items[0], first.items[0]);
});
