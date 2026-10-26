import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { groupTurns, stableTurns, mergeTranscript } from "./turns.ts";
import { translator, fill } from "./i18n.ts";
import * as format from "./format.ts";
import * as tools from "./tools.ts";
import * as chatFind from "./chatFind.ts";
import { hookHarness, loadModule, nodes, textContent } from "../tests/reactHarness.mjs";

const part = (id, kind, text, extra = {}) => ({ id, kind, text, ...extra });
const message = (id, role, text, parts) => ({ id, role, text, ...(parts ? { parts } : {}) });

test("Claude user-role results and Codex tool results stay in the originating turn", () => {
  for (const role of ["user", "tool"]) {
    const turns = groupTurns([
      message("s:0", "user", "Inspect"),
      message("s:1", "assistant", "I will check", [
        part("s:1:p0", "reasoning", "Check repository"),
        part("s:1:p1", "text", "I will check"),
        part("s:1:p2", "tool_call", "git status", { callId: "c1", toolName: "Bash" }),
        part("s:1:p3", "tool_call", "pwd", { callId: "c2", toolName: "Bash" }),
      ]),
      message("s:2", role, "", [part("s:2:p0", "tool_result", "C:/repo", { callId: "c2" })]),
      message("s:3", role, "", [part("s:3:p0", "tool_result", "clean", { callId: "c1" })]),
      message("s:4", "assistant", "Done", [part("s:4:p0", "text", "Done")]),
      message("s:5", "user", "Next"),
    ]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].answer.text, "Done");
    assert.deepEqual(turns[0].steps.map((item) => item.parts?.[0].kind ?? "text"), ["reasoning", "text", "tool_call", "tool_call"]);
    const tools = turns[0].steps.filter((item) => item.parts?.[0].kind === "tool_call");
    assert.deepEqual(tools.map((item) => item.parts.map((part) => part.text)), [["git status", "clean"], ["pwd", "C:/repo"]]);
  }
});

test("partial pages, missing IDs, reasoning-only turns and repeated refreshes keep truthful details", () => {
  const result = message("s:3", "tool", "", [part("s:3:p0", "tool_result", "result", { callId: "c" })]);
  const partial = groupTurns([result]);
  assert.equal(partial[0].answer, undefined);
  assert.equal(partial[0].steps[0].parts[0].kind, "tool_result");
  const prefix = [message("s:0", "user", "Run"), message("s:1", "assistant", "", [
    part("s:1:p0", "tool_call", "cmd", { callId: "c", toolName: "exec" }),
  ])];
  const full = groupTurns([...prefix, result]);
  assert.equal(full[0].steps[0].id, partial[0].steps[0].id);
  assert.equal(full[0].steps[0].parts.length, 2);
  assert.deepEqual(full, groupTurns([...prefix, result]), "grouping must not mutate source parts");
  const missing = groupTurns([message("s:4", "assistant", "", [
    part("s:4:p0", "tool_call", "cmd", { toolName: "Bash" }),
    part("s:4:p1", "tool_result", "output", { toolName: "Bash" }),
    part("s:4:p2", "reasoning", "Plan"),
  ])]);
  assert.equal(missing[0].steps.length, 3, "names must not pair unrelated tool calls");
  assert.equal(missing[0].answer, undefined);
  const truncated = groupTurns([{ ...message("s:5", "assistant", "Final answer", [
    part("s:5:p0", "tool_call", "long input"), part("s:5:p1", "text", "Final answer"),
  ]), partsTruncated: true }]);
  assert.equal(truncated[0].answer.text, "Final answer", "omission notices must not fold the final answer");
});

test("activity body remains folded through updates; manual expansion persists in both locales", () => {
  for (const language of ["zh-CN", "en-US"]) for (const kind of ["tool_call", "reasoning"]) {
    const h = hookHarness(), t = translator(language);
    const { ConversationActivity } = loadModule("ConversationActivity.tsx", { react: h.react });
    let item = message("activity", "tool", "", [part("p1", kind, "<script>unsafe()</script>", { toolName: kind === "tool_call" ? "Bash" : undefined })]);
    h.mount(() => ConversationActivity({ message: item, t }));
    const toggle = () => nodes(h.value).find((node) => node.type === "button");
    const body = () => nodes(h.value).find((node) => node.props.id === toggle().props["aria-controls"]);
    assert.equal(toggle().props["aria-expanded"], false);
    assert.equal(body().props.hidden, true);
    assert.equal(nodes(h.value).some((node) => node.type === "pre"), false);
    item = { ...item, parts: [...item.parts, part("p2", kind === "tool_call" ? "tool_result" : "reasoning", "Updated")] };
    h.render();
    assert.equal(toggle().props["aria-expanded"], false);
    toggle().props.onClick(); h.render();
    assert.equal(body().props.hidden, false);
    assert.ok(textContent(body()).includes("Updated"));
    if (kind === "tool_call") assert.ok(textContent(body()).includes(t("toolInput")) && textContent(body()).includes(t("toolOutput")));
    item = { ...item, parts: item.parts.map((part) => ({ ...part, truncated: true })) };
    h.render();
    assert.equal(toggle().props["aria-expanded"], true);
    assert.ok(textContent(body()).includes(t("truncated")));
    const html = renderToStaticMarkup(h.value);
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
    toggle().props.onClick(); h.render();
    assert.equal(body().props.hidden, true);
    h.dispose();
  }
});

test("the process group does not auto-expand during live output or after completion", () => {
  const h = hookHarness(), t = translator("zh-CN");
  const { TurnView } = loadModule("Conversation.tsx", {
    react: h.react, "react-markdown": { default: "Markdown" }, "remark-gfm": {},
    "./turns": { groupTurns, stableTurns, mergeTranscript }, "./format": format, "./i18n": { fill },
    "./ConversationCodeBlock": {}, "./ConversationActivity": { ConversationActivity: "Activity" },
    // TurnView 用到步驟摘要與搜尋比對；其餘新模組只在 Conversation 本身使用。
    "./tools": tools, "./chatFind": chatFind, "./ConversationStep": { ConversationStep: "Step" },
    "./ChatSearch": {}, "./ConversationTurnRail": {}, "./rail": {}, "./chatScroll": {},
  }, {}, ["TurnView"]);
  let live = true;
  let turn = groupTurns([message("s:0", "user", "Run"), message("s:1", "assistant", "", [part("p1", "tool_call", "cmd")])])[0];
  h.mount(() => TurnView({ turn, live, t }));
  const toggle = () => nodes(h.value).find((node) => node.props.className === "tap-fold");
  const process = () => nodes(h.value).find((node) => node.props.className === "tap-process");
  assert.equal(toggle().props["aria-expanded"], false);
  assert.equal(process().props.hidden, true);
  toggle().props.onClick(); h.render();
  assert.equal(process().props.hidden, false);
  live = false; turn = { ...turn, answer: message("s:2", "assistant", "Done") }; h.render();
  assert.equal(process().props.hidden, false);
  toggle().props.onClick(); h.render();
  live = true; h.render();
  assert.equal(process().props.hidden, true);
  h.dispose();
});
