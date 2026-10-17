import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translator, fill } from "./i18n.ts";
import * as tools from "./tools.ts";
import * as diff from "./diff.ts";
import * as ansi from "./ansi.ts";
import * as chatFind from "./chatFind.ts";
import { hookHarness, loadModule, nodes, textContent } from "../tests/reactHarness.mjs";

// 搜尋狀態由測試直接切換；元件透過 useHit 讀取，不需要真的 Context。
let hits = null;
const deps = (react) => ({
  ...(react ? { react } : {}), "./ChatSearch": { useHit: (text) => chatFind.hitIn(text, hits) },
  "./ansi": ansi, "./diff": diff, "./tools": tools, "./i18n": { fill },
});
const call = (id, toolName, input, extra = {}) => ({
  id: `call-${id}`, kind: "tool_call", toolName, callId: id, text: typeof input === "string" ? input : JSON.stringify(input, null, 2), ...extra,
});
const result = (id, text, extra = {}) => ({ id: `result-${id}`, kind: "tool_result", callId: id, text, ...extra });
const view = (part, ...results) => tools.stepView({ id: `tool:${part.callId}`, role: "tool", text: "", parts: [part, ...results] });
const ESC = String.fromCharCode(27);

test("工具步驟預設收起；結果進來不展開，手動展開後同一步驟刷新仍保持展開（兩種語言）", () => {
  for (const language of ["zh-CN", "en-US"]) {
    const h = hookHarness(), t = translator(language);
    const { StepRow } = loadModule("ConversationStep.tsx", deps(h.react), {}, ["StepRow"]);
    const part = call("a", "Bash", { command: "npm test", description: "Run tests" });
    let item = view(part);
    h.mount(() => StepRow({ view: item, t }));
    const toggle = () => nodes(h.value).find((node) => node.type === "button");
    const body = () => nodes(h.value).find((node) => node.props.id === toggle().props["aria-controls"]);
    assert.equal(toggle().props["aria-expanded"], false);
    assert.equal(body().props.hidden, true);
    assert.equal(body().props.children, false, "details are not built while folded");
    assert.ok(textContent(toggle()).includes(t("toolBash")) && textContent(toggle()).includes("npm test"));
    assert.equal(toggle().props.title, "Run tests");
    item = view(part, result("a", "Exit code 1\nFAIL src/chat.test.ts"));
    h.render();
    assert.equal(toggle().props["aria-expanded"], false, "live results never open a step");
    assert.ok(textContent(toggle()).includes(fill(t("exitCode"), { code: 1 })));
    assert.ok(nodes(toggle()).some((node) => node.props["aria-label"] === t("stepFailed")));
    toggle().props.onClick(); h.render();
    assert.equal(body().props.hidden, false);
    // 下一次刷新是全新的物件（同一個步驟 id）：展開狀態保留。
    item = view({ ...part }, result("a", "Exit code 1\nFAIL src/chat.test.ts"), result("a", "retry"));
    h.render();
    assert.equal(toggle().props["aria-expanded"], true);
    toggle().props.onClick(); h.render();
    assert.equal(body().props.hidden, true);
    h.dispose();
  }
});

test("搜尋命中展開後才看得到的內容時暫時展開，關掉搜尋回到原本的折疊", () => {
  const h = hookHarness(), t = translator("zh-CN");
  const { StepRow } = loadModule("ConversationStep.tsx", deps(h.react), {}, ["StepRow"]);
  const item = view(call("a", "Bash", { command: "npm test" }), result("a", "3 failing tests"));
  h.mount(() => StepRow({ view: item, t }));
  const toggle = () => nodes(h.value).find((node) => node.type === "button");
  hits = chatFind.createHits("FAILING");
  h.render();
  assert.equal(toggle().props["aria-expanded"], true);
  hits = chatFind.createHits("npm");
  h.render();
  assert.equal(toggle().props["aria-expanded"], true, "the command is part of the detail");
  assert.match(toggle().props.className, /is-hit/, "a summary hit shows the full summary");
  hits = null;
  h.render();
  assert.equal(toggle().props["aria-expanded"], false);
  h.dispose();
});

test("展開內容：Edit 的差異沒有編造行號，Write 從第 1 行起，apply_patch 依檔案分組", () => {
  const { StepDetail } = loadModule("ConversationStep.tsx", deps(), {}, ["StepDetail"]);
  for (const language of ["zh-CN", "en-US"]) {
    const t = translator(language);
    const render = (item) => renderToStaticMarkup(React.createElement(StepDetail, { view: item, t }));
    const edit = render(view(call("e", "Edit", { file_path: "/a.ts", old_string: "keep\n<old>", new_string: "keep\n<new>" }),
      result("e", "The file /a.ts has been updated.")));
    assert.match(edit, /tap-hunk-line is-same.*keep/);
    assert.match(edit, /tap-hunk-line is-del.*&lt;old&gt;/);
    assert.match(edit, /tap-hunk-line is-add.*&lt;new&gt;/);
    assert.ok(!edit.includes("tap-hunk-num") && !edit.includes("tap-diff-head"), "unknown line numbers are not invented");
    assert.ok(edit.includes(t("toolOutput")) && !edit.includes("has been updated"), "tool output is folded under its own toggle");
    const write = render(view(call("w", "Write", { content: "one\ntwo", file_path: "/b.ts" })));
    assert.match(write, /tap-hunk is-numbered/);
    assert.match(write, /tap-hunk-num" aria-hidden="true">1<.*tap-hunk-num" aria-hidden="true">2</);
    const patch = render(view(call("p", "apply_patch",
      "*** Begin Patch\n*** Update File: src/app.ts\n@@ fn main\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** Delete File: old.ts\n*** End Patch")));
    for (const text of [t("fileUpdated"), t("fileAdded"), t("fileDeleted"), "src/app.ts", "src/new.ts", "old.ts", "fn main"]) {
      assert.ok(patch.includes(text), `${language}: ${text}`);
    }
    const cut = render(view(call("q", "apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y", { truncated: true })));
    assert.ok(cut.includes(t("truncated")), "a truncated patch is marked");
    const all = render(view(call("r", "Edit", { file_path: "/a", old_string: "x", new_string: "y", replace_all: true })));
    assert.ok(all.includes(t("replaceAll")));
  }
});

test("展開內容：命令與輸出照終端顏色、任務清單含狀態、其他工具維持原本的輸入與輸出", () => {
  const { StepDetail } = loadModule("ConversationStep.tsx", deps(), {}, ["StepDetail"]);
  for (const language of ["zh-CN", "en-US"]) {
    const t = translator(language);
    const render = (item) => renderToStaticMarkup(React.createElement(StepDetail, { view: item, t }));
    const command = render(view(call("c", "exec_command", JSON.stringify({ cmd: "npm test" })),
      result("c", `Wall time: 1 seconds\nProcess exited with code 2\nOutput:\n${ESC}[31merror${ESC}[0m <b>done</b>\n`)));
    assert.match(command, /\$ <\/span>npm test/);
    assert.match(command, /<span style="color:#f87171">error<\/span>/);
    assert.ok(command.includes("&lt;b&gt;done&lt;/b&gt;") && !command.includes(ESC) && !command.includes("Wall time"));
    assert.ok(command.includes(fill(t("exitCode"), { code: 2 })));
    const todos = render(view(call("t", "TodoWrite", { todos: [
      { content: "Parse", status: "completed" }, { content: "Render", status: "in_progress" }, { content: "Ship", status: "pending" },
      { content: "Later", status: "blocked" },
    ] })));
    for (const text of ["is-completed", "is-in_progress", "is-pending", "is-other", t("todoCompleted"), t("todoInProgress"), t("todoPending"), "blocked"]) {
      assert.ok(todos.includes(text), `${language}: ${text}`);
    }
    const generic = render(view(call("g", "Grep", { pattern: "<script>" }), result("g", "a.ts:1:<script>", { truncated: true })));
    assert.ok(generic.includes(t("toolInput")) && generic.includes(t("toolOutput")) && generic.includes(t("truncated")));
    assert.ok(generic.includes("&lt;script&gt;") && !generic.includes("<script>"));
  }
});
