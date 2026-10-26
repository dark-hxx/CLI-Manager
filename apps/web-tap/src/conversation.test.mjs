import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { translator, fill } from "./i18n.ts";
import { groupTurns, stableTurns, mergeTranscript } from "./turns.ts";
import * as format from "./format.ts";
import * as tools from "./tools.ts";
import * as chatFind from "./chatFind.ts";
import * as rail from "./rail.ts";
import * as chatScroll from "./chatScroll.ts";
import { hookHarness, loadModule, nodes, textContent } from "../tests/reactHarness.mjs";

const noTimers = { setTimeout: () => 1, clearTimeout() {} };
const conversationDeps = {
  "react-markdown": { default: Markdown, __esModule: true }, "remark-gfm": { default: remarkGfm, __esModule: true },
  "./i18n": { fill }, "./turns": { groupTurns, stableTurns, mergeTranscript }, "./format": format,
  "./ConversationActivity": loadModule("ConversationActivity.tsx"),
  // 工具步驟摘要、對話搜尋與跳轉點：純邏輯用實際模組，畫面元件以名稱代替（各自另有測試）。
  "./tools": tools, "./chatFind": chatFind, "./rail": rail, "./chatScroll": chatScroll,
  "./ConversationStep": { ConversationStep: "Step" }, "./ConversationTurnRail": { TurnRail: "TurnRail" },
  "./ChatSearch": { SearchProvider: "SearchProvider", useChatSearch: () => ({ hits: null, bar: null, button: null, layer: null }) },
};

test("conversation entry remains visible for old hosts, on desktop and phone, in both languages", () => {
  for (const language of ["zh-CN", "en-US"]) for (const phone of [false, true]) {
    const h = hookHarness(), changes = [], t = translator(language);
    const { SessionHeader } = loadModule("SessionHeader.tsx", {
      react: h.react, "./Menu": { Menu: "Menu" }, "./preferences": { TERMINAL_SIZES: { min: 9, max: 22 } }, "./format": format,
    });
    h.mount(() => SessionHeader({ sessionId: "pty-a", active: true, title: "Session", project: "Project", agent: "codex",
      status: "running", linkOk: true, view: "terminal", size: "80×24", chatAvailable: false, phone, fontSize: 13,
      onView: (view) => changes.push(view), t }));
    const tabs = nodes(h.value).filter((node) => node.props.role === "tab");
    assert.equal(tabs.length, 2, "unsupported capability must not hide the view switch");
    assert.deepEqual(tabs.map((tab) => tab.props["aria-label"]), [t("chat"), t("terminal")]);
    tabs[0].props.onClick();
    assert.deepEqual(changes, ["chat"]);
    assert.equal(tabs[0].props["aria-controls"], "chat-pty-a");
    h.dispose();
  }
});

test("selecting conversation on an old host preserves terminal, composer and registered worktree context", () => {
  const h = hookHarness(), saved = [];
  const { SessionView } = loadModule("SessionView.tsx", {
    react: { ...h.react, lazy: () => "Conversation" }, "react-dom": { flushSync: (run) => run() },
    "./Terminal": { Terminal: "Terminal" }, "./Composer": { Composer: "Composer" }, "./KeyBar": { KeyBar: "KeyBar" },
    "./SessionHeader": { SessionHeader: "Header" }, "./Dock": { DockStatus: "Dock" },
    "./git": { gitKey: () => "git", useGit: () => ({ summary: null }) }, "./format": format,
    "../../../src/shared/lib/webImageUpload": {},
    "./preferences": { resolved: (prefs) => ({ view: "terminal", fontSize: 13, chatSize: 15, ...prefs }), TERMINAL_SIZES: { min: 9, max: 22 } },
  }, noTimers);
  const model = { workspace: {
    terminals: [{ sessionId: "pty-a", projectId: "p", worktreeId: "wt" }],
    projects: [{ id: "p", name: "Project", source: "codex" }], worktrees: [{ id: "wt", name: "Branch" }],
  }, states: { "pty-a": { status: "running" } }, link: "open", device: { status: "online", capabilities: [] },
  user: { id: "u" }, deviceId: "host", reconnect() {} };
  h.mount(() => SessionView({ id: "pty-a", active: true, model, prefs: {}, setPrefs: (value) => saved.push(value), t: translator("zh-CN") }));
  nodes(h.value).find((node) => node.type === "Header").props.onView("chat");
  h.render();
  assert.match(h.value.props.className, /is-chat/);
  assert.equal(nodes(h.value).find((node) => node.props.id === "chat-pty-a").props.hidden, false);
  assert.equal(nodes(h.value).filter((node) => node.type === "Terminal").length, 1);
  assert.equal(nodes(h.value).filter((node) => node.type === "Composer").length, 1);
  const chat = nodes(h.value).find((node) => node.type === "Conversation");
  assert.equal(chat.props.supported, false);
  assert.equal(chat.props.context.projectId, "p");
  assert.equal(chat.props.context.worktreeId, "wt");
  assert.equal(saved[0].view, "chat");
  model.device.capabilities = ["terminal.transcript"];
  h.render();
  assert.equal(nodes(h.value).find((node) => node.type === "Conversation").props.supported, true);
  h.dispose();
});

test("old host explains update/reconnect, sends no unsupported request, and loads after capability arrives", async () => {
  const h = hookHarness(), calls = [];
  const stream = { subscribe: () => () => {} };
  let supported = false, reconnected = 0;
  const { Conversation } = loadModule("Conversation.tsx", {
    ...conversationDeps, react: h.react, "./ConversationCodeBlock": { ConversationCodeBlock: "CodeBlock" },
  }, { ...noTimers, document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
  h.mount(() => Conversation({ sessionId: "pty-a", context: { projectId: "p" }, supported, active: true, chatSize: 15,
    t: translator("zh-CN"), onReconnect: () => reconnected++, onTerminal() {}, stream,
    run: async (kind, payload) => {
      calls.push({ kind, payload });
      return { available: true, cliSessionId: "cli-a", start: 0, total: 2,
        messages: [{ id: "cli-a:0", role: "user", text: "Question" }, { id: "cli-a:1", role: "assistant", text: "Answer" }] };
    },
  }));
  await h.settle();
  assert.equal(calls.length, 0);
  assert.match(textContent(h.value), /切换到标注「支持对话」的设备/);
  nodes(h.value).find((node) => node.type === "button" && textContent(node) === "重新连接").props.onClick();
  assert.equal(reconnected, 1);
  supported = true; h.render(); await h.settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "terminal.transcript");
  assert.equal(calls[0].payload.sessionId, "pty-a");
  assert.equal(calls[0].payload.includeDetails, true);
  const turn = nodes(h.value).find((node) => (node.type?.name ?? node.type?.type?.name) === "TurnView").props.turn;
  assert.equal(turn.prompt.text, "Question");
  assert.equal(turn.answer.text, "Answer");
  h.dispose();
});

test("Markdown renders headings, lists, tables and escaped code with bilingual controls", () => {
  const codeBlock = loadModule("ConversationCodeBlock.tsx", { "./i18n": { translator } });
  const { Message } = loadModule("Conversation.tsx", {
    ...conversationDeps, "./ConversationCodeBlock": codeBlock,
  }, {}, ["Message"]);
  for (const language of ["zh-CN", "en-US"]) {
    const t = translator(language);
    const html = renderToStaticMarkup(React.createElement(Message, { t, message: {
      id: "m", role: "assistant", text: "## Answer\n\n- One\n- Two\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n```powershell\n<script>alert('x')</script>\n```\n\n[unsafe](javascript:alert)\n",
    } }));
    assert.match(html, /<h2>Answer<\/h2>/);
    assert.match(html, /<li>One<\/li>/);
    assert.match(html, /<table>/);
    assert.match(html, /powershell/);
    assert.ok(html.includes(t("copyCode")));
    assert.ok(html.includes(t("collapseCode")));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes('href="javascript:'));
  }
  const message = { id: "m", role: "assistant", text: "```ts\ncode();\n```" };
  const before = nodes(Message({ t: translator("en-US"), message })).find((node) => node.type === Markdown);
  const after = nodes(Message({ t: translator("en-US"), message: { ...message, text: `${message.text}\nmore text` } }))
    .find((node) => node.type === Markdown);
  assert.equal(before.props.components.pre, after.props.components.pre, "transcript refresh must not remount code blocks and lose folding state");
});

test("code folding preserves source and clipboard failure remains visible", async () => {
  const h = hookHarness(), copied = [];
  let fail = false;
  const { ConversationCodeBlock } = loadModule("ConversationCodeBlock.tsx", {
    react: { ...h.react, useContext: () => translator("en-US") }, "./i18n": { translator },
  }, {
    ...noTimers, navigator: { clipboard: { writeText: async (text) => { if (fail) throw Error("denied"); copied.push(text); } } },
  });
  const source = "  indented();\n\tsecond();\n";
  h.mount(() => ConversationCodeBlock({ children: React.createElement("code", { className: "language-ts" }, source) }));
  const button = (label) => nodes(h.value).find((node) => node.props["aria-label"] === label);
  button("Collapse code").props.onClick(); h.render();
  assert.equal(nodes(h.value).find((node) => node.type === "pre").props.hidden, true);
  button("Copy code").props.onClick(); await h.settle();
  assert.deepEqual(copied, [source]);
  assert.ok(button("Copied"));
  button("Expand code").props.onClick(); h.render();
  assert.equal(nodes(h.value).find((node) => node.type === "pre").props.hidden, false);
  fail = true; button("Copied").props.onClick(); await h.settle();
  assert.match(textContent(h.value), /Copy failed/);
  h.dispose();
});
