import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translator, fill } from "./i18n.ts";
import { groupTurns } from "./turns.ts";
import * as format from "./format.ts";
import * as tools from "./tools.ts";
import * as chatFind from "./chatFind.ts";
import * as turnRail from "./turnRail.ts";
import * as chatScroll from "./chatScroll.ts";
import { hookHarness, loadModule, nodes, textContent } from "../tests/reactHarness.mjs";

const deps = (react) => ({
  ...(react ? { react } : {}), "react-markdown": { default: "Markdown" }, "remark-gfm": {},
  "./turns": { groupTurns }, "./format": format, "./i18n": { fill }, "./ConversationCodeBlock": {},
  "./ConversationActivity": { ConversationActivity: "Activity" }, "./ConversationStep": { ConversationStep: "Step" },
  "./tools": tools, "./chatFind": chatFind, "./turnRail": turnRail, "./chatScroll": chatScroll, "./TurnRail": { TurnRail: "TurnRail" },
  "./ChatSearch": { SearchProvider: "SearchProvider", useChatSearch: () => ({ hits: null, bar: null, button: null, layer: null }) },
});
const part = (id, kind, text, extra = {}) => ({ id, kind, text, ...extra });
const json = (value) => JSON.stringify(value, null, 2);
const turnMessages = [
  { id: "s:0", role: "user", text: "Fix the parser", at: "2026-10-17T09:00:00Z" },
  { id: "s:1", role: "assistant", text: "", parts: [
    part("s:1:p0", "reasoning", "Look at the parser first"),
    part("s:1:p1", "tool_call", json({ file_path: "/repo/parser.ts", new_string: "b\nc", old_string: "a" }), { toolName: "Edit", callId: "e1" }),
    part("s:1:p2", "tool_call", '{\n  "content": "cut', { toolName: "Write", callId: "w1", truncated: true }),
  ] },
  { id: "s:2", role: "tool", text: "", parts: [part("s:2:p0", "tool_result", "updated", { callId: "e1" })] },
  { id: "s:3", role: "assistant", text: "Fixed.", at: "2026-10-17T09:02:17Z", parts: [part("s:3:p0", "text", "Fixed.")] },
];

test("過程裡讀得出參數的工具用新的步驟列，其他（思考、截斷的參數）沿用原本的過程卡；收尾列拿到本輪行數", () => {
  const h = hookHarness(), t = translator("zh-CN");
  const { TurnView } = loadModule("Conversation.tsx", deps(h.react), {}, ["TurnView"]);
  const [turn] = groupTurns(turnMessages);
  h.mount(() => TurnView({ turn, live: false, t }));
  const process = nodes(h.value).find((node) => node.props.className === "tap-process");
  assert.equal(process.props.hidden, true, "the process stays folded by default");
  const children = [process.props.children].flat(Infinity).filter(Boolean);
  assert.deepEqual(children.map((node) => node.type), ["Activity", "Step", "Activity"]);
  assert.equal(children[1].props.view.summary, "/repo/parser.ts");
  assert.equal(children[2].props.message.parts[0].toolName, "Write", "truncated JSON falls back to the original card");
  const footer = nodes(h.value).find((node) => node.type?.name === "Footer");
  assert.deepEqual(footer.props.changes, { added: 2, removed: 1, approximate: true });
  assert.equal(nodes(h.value).find((node) => node.props.className === "tap-turn").props["data-key"], "s:0", "the rail scrolls to this key");
  h.dispose();
});

test("搜尋命中收起來的過程時暫時展開，關掉搜尋回到使用者的選擇；命中長提問時展開提問", () => {
  const h = hookHarness(), t = translator("en-US");
  const { TurnView } = loadModule("Conversation.tsx", deps(h.react), {}, ["TurnView"]);
  const long = { id: "s:0", role: "user", text: `${"context line\n".repeat(20)}needle at the end` };
  const [turn] = groupTurns([long, ...turnMessages.slice(1)]);
  let hits = chatFind.createHits("parser.ts");
  h.mount(() => TurnView({ turn, live: false, hits, t }));
  const process = () => nodes(h.value).find((node) => node.props.className === "tap-process");
  const activity = () => [process().props.children].flat(Infinity).find((node) => node?.type === "Activity");
  assert.equal(process().props.hidden, false);
  hits = chatFind.createHits("look at the parser");
  h.render();
  assert.equal(activity().props.hit, true, "a hit inside a folded card opens it while searching");
  hits = chatFind.createHits("needle");
  h.render();
  assert.equal(process().props.hidden, true);
  assert.equal(nodes(h.value).find((node) => node.type?.name === "UserBubble").props.hit, true);
  hits = null;
  h.render();
  assert.equal(process().props.hidden, true);
  h.dispose();
});

test("收尾列：複製、回到提問、24 小時制完成時刻、用時與本輪行數，兩種語言", () => {
  const { Footer } = loadModule("Conversation.tsx", deps(), {}, ["Footer"]);
  const [turn] = groupTurns(turnMessages);
  for (const language of ["zh-CN", "en-US"]) {
    const t = translator(language);
    const render = (changes, value = turn) => renderToStaticMarkup(React.createElement(Footer, { message: value.answer, turn: value, changes, t }));
    const html = render({ added: 2, removed: 1, approximate: false });
    const escaped = (text) => text.replace(/'/g, "&#x27;");
    assert.ok(html.includes(t("copyAnswer")) && html.includes(escaped(t("toPrompt"))));
    assert.ok(html.includes(`>${format.clock(turn.answer.at)}</time>`));
    assert.match(format.clock(turn.answer.at), /^(?:\d{1,2}\/\d{1,2} )?\d{2}:\d{2}$/, "24-hour clock without AM/PM");
    assert.ok(html.includes(fill(t("finishedAt"), { time: format.fullTime(turn.answer.at) })));
    assert.ok(html.includes("2m 17s"));
    assert.ok(html.includes(">+2<") && html.includes(">−1<") && !html.includes(`>${t("approx")}<`));
    assert.ok(html.includes(fill(t("turnChanges"), { added: 2, removed: 1 })));
    const rough = render({ added: 2, removed: 1, approximate: true });
    assert.ok(rough.includes(`>${t("approx")}<`) && rough.includes(fill(t("turnChangesApprox"), { added: 2, removed: 1 })));
    const plain = render(undefined, { ...turn, prompt: undefined, elapsed: undefined });
    assert.ok(!plain.includes(escaped(t("toPrompt"))) && !plain.includes("tap-turn-changes"));
  }
});

test("複製最終回答：成功只換圖示，截斷時說明只複製到顯示的部分，失敗時提示", async () => {
  const written = [];
  let fail = false;
  const globals = {
    setTimeout: () => 1, clearTimeout() {}, window: { isSecureContext: true },
    navigator: { clipboard: { writeText: async (text) => { if (fail) throw Error("denied"); written.push(text); } } },
    document: { createElement: () => ({ setAttribute() {}, style: {}, select() {}, remove() {} }), body: { append() {} }, execCommand: () => false },
  };
  const t = translator("zh-CN");
  for (const truncated of [false, true]) {
    const h = hookHarness();
    const { Footer } = loadModule("Conversation.tsx", deps(h.react), globals, ["Footer"]);
    const [turn] = groupTurns(turnMessages);
    const message = { ...turn.answer, truncated };
    fail = false;
    h.mount(() => Footer({ message, turn, t }));
    const copy = () => nodes(h.value).find((node) => node.type === "button");
    const feedback = () => textContent(nodes(h.value).find((node) => node.props.className === "tap-turn-feedback"));
    copy().props.onClick(); await h.settle();
    assert.equal(written.at(-1), "Fixed.");
    assert.equal(copy().props["aria-label"], t(truncated ? "answerCopiedPartial" : "answerCopied"));
    assert.equal(feedback(), truncated ? t("answerCopiedPartial") : "");
    fail = true;
    copy().props.onClick(); await h.settle();
    assert.equal(feedback(), t("copyAnswerFailed"), "the fallback copy also failed");
    h.dispose();
  }
});

// 只模擬 Conversation 用到的捲動區：高度、位置與 `[data-anchor]` 項目。
function fakeScroller() {
  const state = { shift: 0, keys: ["s:6", "s:7"], scrollTop: 300 };
  const element = (key, index) => ({ dataset: { anchor: key }, getBoundingClientRect: () => {
    const top = 100 + index * 80 + state.shift - (state.scrollTop - 300);
    return { top, bottom: top + 60, height: 60 };
  } });
  return {
    state,
    get scrollTop() { return state.scrollTop; }, set scrollTop(value) { state.scrollTop = value; },
    scrollHeight: 2000, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 120 }),
    querySelectorAll: () => state.keys.map(element),
    querySelector: (selector) => state.keys.map(element).find((item) => selector === `[data-anchor="${item.dataset.anchor}"]`) ?? null,
  };
}

function mountConversation(respond) {
  globalThis.CSS ??= { escape: (value) => value };
  const h = hookHarness(), calls = [], stream = { subscribe: () => () => {} };
  const { Conversation } = loadModule("Conversation.tsx", deps(h.react), {
    setTimeout: () => 1, clearTimeout() {}, document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  });
  h.mount(() => Conversation({ sessionId: "pty", context: { projectId: "p" }, supported: true, active: true, chatSize: 15,
    t: translator("zh-CN"), onReconnect() {}, onTerminal() {}, stream,
    run: async (kind, payload) => { calls.push(payload); return respond.current(payload); } }));
  const find = (match) => nodes(h.value).find(match);
  return {
    h, calls,
    rail: () => find((node) => node.type === "TurnRail").props,
    chat: () => find((node) => node.props.className === "tap-chat").props,
    button: (label) => find((node) => node.type === "button" && textContent(node) === label),
  };
}
const transcript = (from, to, total = 10) => ({ available: true, cliSessionId: "cli", start: from, total, messages: Array.from({ length: to - from },
  (_, offset) => ({ id: `cli:${from + offset}`, role: (from + offset) % 2 ? "assistant" : "user", text: `message ${from + offset}` })) });

test("讀取更早的對話：畫面最上面那一項留在原位，跳轉點補上更早的提問", async () => {
  const respond = { current: () => transcript(6, 10) };
  const view = mountConversation(respond);
  await view.h.settle();
  assert.deepEqual(view.rail().prompts.map((prompt) => prompt.key), ["cli:6", "cli:8"]);
  assert.equal(view.rail().more, true);
  const scroller = fakeScroller();
  scroller.state.keys = ["cli:6", "cli:7"];
  view.chat().ref.current = scroller;
  // 往上翻閱：不在底部，新內容不會把畫面拉到最下面。
  view.chat().onScroll();
  respond.current = () => {
    // 前面插入 6 則更早的訊息，畫面上原本那一項被往下推了 420px。
    scroller.state.shift = 420;
    return transcript(0, 6);
  };
  view.rail().onOlder(); await view.h.settle();
  assert.equal(view.calls.at(-1).before, 6);
  assert.equal(view.calls.at(-1).includeDetails, true);
  assert.equal(scroller.scrollTop, 300 + 420, "the first visible item returns to where it was");
  assert.deepEqual(view.rail().prompts.map((prompt) => prompt.key), ["cli:0", "cli:2", "cli:4", "cli:6", "cli:8"]);
  assert.equal(view.rail().more, false);
  view.h.dispose();
});

test("讀取更早的對話失敗時不留下讀取前的位置：之後的刷新不會把畫面拉回去", async () => {
  const respond = { current: () => transcript(6, 10) };
  const view = mountConversation(respond);
  await view.h.settle();
  const scroller = fakeScroller();
  scroller.state.keys = ["cli:6", "cli:7"];
  view.chat().ref.current = scroller;
  view.chat().onScroll();
  respond.current = () => { throw Error("offline"); };
  view.button("读取更早的对话").props.onClick(); await view.h.settle();
  // 使用者接著往下捲了一段，再按重試讀到新內容。
  scroller.scrollTop = 500;
  respond.current = () => ({ ...transcript(6, 11, 11) });
  view.button("重试").props.onClick(); await view.h.settle();
  assert.equal(view.calls.at(-1).before, undefined);
  assert.equal(scroller.scrollTop, 500);
  view.h.dispose();
});
