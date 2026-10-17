import assert from "node:assert/strict";
import { test } from "node:test";
import { translator, fill } from "./i18n.ts";
import * as chatFind from "./chatFind.ts";
import { hookHarness, loadModule, nodes, textContent } from "../tests/reactHarness.mjs";

// 只模擬搜尋列用到的 document：鍵盤事件註冊與目前的焦點。
function setup({ visible = true, more = false, overlay = false } = {}) {
  const h = hookHarness(), listeners = new Map(), timers = [], older = [];
  const document = {
    activeElement: null,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
  const { useChatSearch } = loadModule("ChatSearch.tsx", {
    react: h.react, "react-dom": { flushSync: (run) => run() }, "./chatFind": chatFind,
    "./overlay": { overlayOpen: () => overlay }, "./i18n": { fill },
  }, { document, setTimeout: (run) => { timers.push(run); return timers.length; }, clearTimeout() {} });
  const root = { current: { getClientRects: () => visible ? [{}] : [] } };
  const refs = { list: { current: null }, scroller: { current: null } };
  const t = translator("en-US");
  let search;
  h.mount(() => (search = useChatSearch({ root, ...refs, items: [], more, older: false, onOlder: () => older.push(1), t })));
  const key = (init) => {
    const event = { key: "f", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...init };
    listeners.get("keydown")?.(event);
    h.render();
    return event;
  };
  const input = () => nodes(search.bar).find((node) => node.type === "input");
  const type = (text) => {
    input().props.onChange({ target: { value: text } }); h.render();
    timers.splice(0).forEach((run) => run()); h.render();
  };
  return { h, t, key, input, type, older, get search() { return search; } };
}

test("Ctrl+F 只在對話顯示時打開搜尋；終端聚焦或有彈層時不搶", () => {
  const hidden = setup({ visible: false });
  assert.equal(hidden.key({ ctrlKey: true }).defaultPrevented, false);
  assert.equal(hidden.search.bar, null);
  hidden.h.dispose();
  const overlay = setup({ overlay: true });
  assert.equal(overlay.key({ ctrlKey: true }).defaultPrevented, false);
  overlay.h.dispose();
  const terminal = setup();
  assert.equal(terminal.key({ ctrlKey: true, target: { closest: (selector) => selector === ".tap-terminal" } }).defaultPrevented, false,
    "Ctrl+F belongs to the CLI while the terminal is focused");
  const view = setup();
  assert.equal(view.key({ ctrlKey: true, shiftKey: true }).defaultPrevented, false);
  assert.ok(view.search.button, "the floating search button shows while closed");
  assert.equal(view.key({ ctrlKey: true }).defaultPrevented, true);
  assert.ok(view.search.bar);
  assert.equal(view.search.button, null);
  terminal.h.dispose();
  view.h.dispose();
});

test("輸入停一下才搜尋，命中狀態給摺疊的內容判斷；Esc 關掉後回到沒有搜尋", () => {
  const view = setup({ more: true });
  view.search.button.props.onClick(); view.h.render();
  assert.equal(view.search.hits, null, "an empty query is not a search");
  view.type("  Parse(Turns) ");
  assert.equal(view.search.hits.query, "parse(turns)");
  assert.equal(chatFind.hitIn("calls parse(turns) twice", view.search.hits), true);
  // 還有更早的紀錄沒讀：說明只搜了已讀取的部分，並可以接著讀。
  const note = nodes(view.search.bar).find((node) => node.props?.className === "tap-chat-find-note");
  assert.ok(textContent(note).includes(view.t("searchedLoaded")));
  nodes(note).find((node) => node.type === "button").props.onClick();
  assert.deepEqual(view.older, [1]);
  const escape = { key: "Escape", nativeEvent: { isComposing: false, keyCode: 27 }, preventDefault() {} };
  view.input().props.onKeyDown(escape); view.h.render();
  assert.equal(view.search.bar, null);
  assert.equal(view.search.hits, null);
  view.h.dispose();
});

test("輸入法選字時按 Enter 或 Esc 不會移動或關閉搜尋", () => {
  const view = setup();
  view.search.button.props.onClick(); view.h.render();
  view.type("對話");
  view.input().props.onKeyDown({ key: "Escape", nativeEvent: { isComposing: true, keyCode: 229 }, preventDefault() { throw Error("must not handle"); } });
  view.h.render();
  assert.ok(view.search.bar);
  assert.equal(view.search.hits.query, "對話");
  view.h.dispose();
});
