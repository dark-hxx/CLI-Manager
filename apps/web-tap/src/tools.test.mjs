import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandResult, commandText, fileName, firstLine, mcpName, processText, stepDetailText, stepView, stepViews, turnChanges,
} from "./tools.ts";
import { groupTurns } from "./turns.ts";

// 主機匯出的形狀：Claude 的 input 是 pretty JSON，Codex function_call 的 arguments 是 JSON 字串，custom_tool_call 是原始文字。
const call = (id, toolName, input, extra = {}) => ({
  id: `call-${id}`, kind: "tool_call", toolName, callId: id, text: typeof input === "string" ? input : JSON.stringify(input, null, 2), ...extra,
});
const result = (id, text, extra = {}) => ({ id: `result-${id}`, kind: "tool_result", callId: id, text, ...extra });
const step = (part, ...results) => ({ id: `tool:${part.callId}`, role: "tool", text: "", parts: [part, ...results] });
const view = (part, ...results) => stepView(step(part, ...results));

test("Claude 工具：標籤、圖示與關鍵參數", () => {
  const cases = [
    [call("1", "Read", { file_path: "/repo/src/app.ts", limit: 20 }), "toolRead", "read", "/repo/src/app.ts", true],
    [call("2", "Grep", { pattern: "useState", path: "src" }), "toolGrep", "search", "useState · src"],
    [call("3", "Glob", { pattern: "**/*.css" }), "toolGlob", "files", "**/*.css"],
    [call("4", "WebFetch", { url: "https://example.test/doc", prompt: "summary" }), "toolFetch", "web", "https://example.test/doc"],
    [call("5", "WebSearch", { query: "tauri 2 updater" }), "toolWebSearch", "web", "tauri 2 updater"],
    [call("6", "Task", { description: "Find callers", prompt: "long prompt", subagent_type: "Explore" }), "toolAgent", "agent", "Find callers"],
    [call("7", "NotebookEdit", { notebook_path: "/repo/a.ipynb", new_source: "x" }), "toolNotebook", "edit", "/repo/a.ipynb", true],
    [call("8", "Skill", { skill: "frontend-design" }), "toolSkill", "skill", "frontend-design"],
    [call("9", "BashOutput", { bash_id: "shell-2" }), "toolBashOutput", "bash", "shell-2"],
    [call("10", "ExitPlanMode", { plan: "## Ship the parser\n- step" }), "toolExitPlan", "plan", "Ship the parser"],
    [call("11", "AskUserQuestion", { questions: [{ question: "Which port?", header: "Port" }] }), "toolAsk", "ask", "Which port?"],
  ];
  for (const [part, label, icon, summary, path = false] of cases) {
    const item = view(part);
    assert.equal(item.label, label, part.toolName);
    assert.equal(item.icon, icon, part.toolName);
    assert.equal(item.summary, summary, part.toolName);
    assert.equal(Boolean(item.path), path, part.toolName);
    assert.equal(item.detail.type, "generic", `${part.toolName} keeps the original input/output presentation`);
  }
  const bash = view(call("b", "Bash", { command: "\n  npm test -- --grep chat\nnpm run build", description: "Run the chat tests" }));
  assert.deepEqual([bash.label, bash.icon, bash.summary, bash.title], ["toolBash", "bash", "npm test -- --grep chat", "Run the chat tests"]);
  assert.deepEqual(bash.detail, { type: "command", command: "\n  npm test -- --grep chat\nnpm run build", description: "Run the chat tests" });
});

test("Codex 工具：殼層命令、apply_patch、update_plan、view_image 與 write_stdin", () => {
  const shell = view(call("s", "shell", JSON.stringify({ command: ["bash", "-lc", "git status --short"], workdir: "/repo" })));
  assert.deepEqual([shell.label, shell.summary, shell.detail.command], ["toolBash", "git status --short", "git status --short"]);
  const exec = view(call("e", "exec_command", JSON.stringify({ cmd: "rg -n TODO src", yield_time_ms: 1000 })));
  assert.equal(exec.summary, "rg -n TODO src");
  const windows = view(call("w", "shell_command", JSON.stringify({ command: "Get-ChildItem -Force", workdir: "C:\\repo" })));
  assert.equal(windows.summary, "Get-ChildItem -Force");
  const patch = view(call("p", "apply_patch", "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Add File: docs/new.md\n+# New\n*** End Patch"));
  assert.deepEqual([patch.label, patch.icon, patch.summary, patch.path], ["toolEdit", "edit", "app.ts, new.md", false]);
  assert.equal(patch.title, "src/app.ts\ndocs/new.md");
  assert.deepEqual(patch.changes, { added: 2, removed: 1, exactness: "exact" });
  const created = view(call("c", "apply_patch", JSON.stringify({ input: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" })));
  assert.deepEqual([created.label, created.summary, created.path], ["toolWrite", "a.txt", true]);
  const viaShell = view(call("h", "shell", JSON.stringify({ command: ["apply_patch", "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch"] })));
  assert.equal(viaShell.detail.type, "diff");
  assert.equal(viaShell.detail.files[0].op, "delete");
  const plan = view(call("u", "update_plan", JSON.stringify({ explanation: "Port step by step", plan: [
    { step: "Parse", status: "completed" }, { step: "Render", status: "in_progress" }, { step: "Test", status: "pending" },
  ] })));
  assert.deepEqual([plan.label, plan.icon, plan.summary], ["toolPlan", "todo", "Render"]);
  assert.equal(plan.detail.explanation, "Port step by step");
  const image = view(call("i", "view_image", JSON.stringify({ path: "/tmp/shot.png" })));
  assert.deepEqual([image.label, image.icon, image.summary, image.path], ["toolImage", "image", "/tmp/shot.png", true]);
  const stdin = view(call("t", "write_stdin", JSON.stringify({ session_id: 7, chars: "y\n" })));
  assert.deepEqual([stdin.label, stdin.summary, stdin.detail.stdin], ["toolBashOutput", "y", "y\n"]);
});

test("MCP 與不認得的工具顯示名稱與第一個簡短參數", () => {
  const mcp = view(call("m", "mcp__claude_ai_Gmail__search_threads", { query: "invoice" }));
  assert.deepEqual([mcp.label, mcp.rawLabel, mcp.icon, mcp.summary], [undefined, "claude_ai_Gmail", "mcp", "search_threads"]);
  assert.deepEqual(mcpName("github__create_issue"), { server: "github", tool: "create_issue" });
  assert.equal(mcpName("Read"), undefined);
  assert.equal(mcpName("__private"), undefined);
  const custom = view(call("x", "exec", "await tools.exec_command({cmd:'pwd'})\nawait more()"));
  assert.deepEqual([custom.rawLabel, custom.icon, custom.summary], ["exec", "tool", "await tools.exec_command({cmd:'pwd'})"]);
  const unknown = view(call("y", "LookupThing", { body: "multi\nline", key: "abc-123" }));
  assert.equal(unknown.summary, "abc-123", "multi-line values are skipped");
  assert.equal(view(call("z", "WebSearch", { query: "q".repeat(300) })).summary.length, 201);
});

test("被截斷或不完整的 JSON 參數退回原本的過程卡呈現", () => {
  const cut = '{\n  "content": "very long file';
  for (const part of [
    call("1", "Write", cut, { truncated: true }),
    call("2", "Edit", '{\n  "file_path": "/a.ts",\n  "new_string": "x', { truncated: true }),
    call("3", "shell", '{"command":["bash","-lc","cat <<EOF', { truncated: true }),
    call("4", "Bash", "{ not json }"),
    call("5", "Bash", "[1, 2]"),
  ]) assert.equal(view(part), undefined, part.text);
  assert.equal(stepView({ id: "x", role: "tool", text: "", parts: [{ id: "r", kind: "tool_result", text: "out", callId: "q" }] }), undefined,
    "results without their call keep the original card");
  assert.equal(stepView({ id: "r", role: "tool", text: "", parts: [{ id: "p", kind: "reasoning", text: "plan" }] }), undefined);
  assert.equal(view(call("6", undefined, { command: "ls" })), undefined, "a call without a tool name is not guessed");
  // 原始文字的 apply_patch 被截斷時仍解析讀得到的部分，但明確標示且行數不計入。
  const partial = view(call("7", "apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n+z", { truncated: true }));
  assert.equal(partial.detail.truncated, true);
  assert.deepEqual(partial.changes, { added: 2, removed: 1, exactness: "unknown" });
});

test("只有 CLI 明確寫出的失敗才標成失敗，結束碼與輸出內容分開", () => {
  assert.deepEqual(commandResult("Exit code: 0\nWall time: 0.2 seconds\nOutput:\nclean\n"), { exit: 0, body: "clean\n" });
  assert.deepEqual(commandResult("Chunk ID: a\nWall time: 1 seconds\nProcess exited with code 2\nOutput:\nfail"), { exit: 2, body: "fail" });
  assert.deepEqual(commandResult('{"output":"done\\n","metadata":{"exit_code":1,"duration_seconds":0.1}}'), { exit: 1, body: "done\n" });
  assert.deepEqual(commandResult("Exit code 127\nbash: foo: command not found"), { exit: 127, body: "bash: foo: command not found" });
  assert.deepEqual(commandResult("plain output"), { exit: undefined, body: "plain output" });
  assert.deepEqual(commandResult('{"output":"cut'), { exit: undefined, body: '{"output":"cut' });
  const bash = (text) => view(call("b", "Bash", { command: "npm test" }), result("b", text));
  assert.equal(bash("all good").failed, false);
  assert.equal(bash("all good").exit, undefined, "output alone never means success");
  assert.deepEqual([bash("Exit code 1\nFAIL").failed, bash("Exit code 1\nFAIL").exit], [true, 1]);
  const edit = (text) => view(call("e", "Edit", { file_path: "/a", old_string: "a", new_string: "b" }), result("e", text));
  assert.equal(edit("<tool_use_error>String to replace not found</tool_use_error>").failed, true);
  assert.equal(edit("The user doesn't want to proceed with this tool use. The tool use was rejected.").failed, true);
  assert.equal(edit("The file /a has been updated.").failed, false);
  assert.equal(view(call("n", "Bash", { command: "sleep 9" })).failed, false, "a call without a result is not a failure");
  const patch = view(call("p", "apply_patch", "*** Begin Patch\n*** Update File: a\n@@\n-x\n+y\n*** End Patch"),
    result("p", '{"output":"apply_patch verification failed: Failed to find expected lines","metadata":{"exit_code":1}}'));
  assert.deepEqual([patch.failed, patch.exit], [true, 1], "a Codex patch with a non-zero exit code is a recorded failure");
  const read = view(call("r", "Read", { file_path: "/log.txt" }), result("r", "Exit code 1\nfrom the file itself"));
  assert.deepEqual([read.failed, read.exit], [false, undefined], "other tools' output content is never parsed as a status");
});

test("命令文字：殼層包裝只顯示命令本身，其餘參數加上殼層引號", () => {
  assert.equal(commandText(["/bin/zsh", "-lc", "make test"]), "make test");
  assert.equal(commandText(["powershell.exe", "-NoProfile", "-Command", "Get-Item", "x"]), "Get-Item x");
  assert.equal(commandText(["cmd.exe", "/c", "dir"]), "dir");
  assert.equal(commandText(["git", "commit", "-m", "it's done"]), "git commit -m 'it'\\''s done'");
  assert.equal(commandText("echo hi"), "echo hi");
  assert.equal(commandText(42), "");
  assert.equal(firstLine("\n \n  first  \nsecond"), "first");
  assert.equal(fileName("C:\\repo\\src\\a.ts"), "a.ts");
  assert.equal(fileName("/repo/src/"), "src");
});

test("任務清單：TodoWrite 與 update_plan 的狀態，空白項目略過", () => {
  const todos = view(call("t", "TodoWrite", { todos: [
    { content: "Write parser", status: "completed", activeForm: "Writing parser" },
    { content: "Render rows", status: "in_progress" }, { content: "  ", status: "pending" }, { content: "Ship", status: "cancelled" },
    { content: "Docs" },
  ] }));
  assert.equal(todos.detail.type, "todos");
  assert.deepEqual(todos.detail.items, [
    { text: "Write parser", status: "completed" }, { text: "Render rows", status: "in_progress" },
    { text: "Ship", status: "cancelled" }, { text: "Docs", status: "pending" },
  ]);
  assert.equal(todos.summary, "Render rows");
  assert.equal(view(call("u", "TodoWrite", { todos: [{ content: "A", status: "completed" }] })).summary, "");
  const broken = view(call("v", "update_plan", JSON.stringify({ plan: "not a list" })));
  assert.deepEqual([broken.label, broken.detail.type], ["toolPlan", "generic"]);
});

test("Edit、MultiEdit 與 Write 的改動與行數", () => {
  const edit = view(call("e", "Edit", { file_path: "/a.ts", old_string: "keep\nold\ntail", new_string: "keep\nnew\nmore\ntail" }));
  assert.deepEqual(edit.detail.files[0].hunks[0].lines, [" keep", "-old", "+new", "+more", " tail"]);
  assert.deepEqual(edit.changes, { added: 2, removed: 1, exactness: "exact" });
  assert.equal(edit.detail.showFiles, false, "a single file is already in the summary");
  const multi = view(call("m", "MultiEdit", { file_path: "/a.ts", edits: [
    { old_string: "a", new_string: "b" }, { old_string: "x", new_string: "y", replace_all: true },
  ] }));
  assert.equal(multi.detail.files[0].hunks.length, 2);
  assert.equal(multi.detail.files[0].hunks[1].replaceAll, true);
  assert.deepEqual(multi.changes, { added: 2, removed: 2, exactness: "lower" });
  assert.equal(view(call("n", "MultiEdit", { file_path: "/a.ts", edits: "nope" })), undefined);
  const write = view(call("w", "Write", { content: "one\ntwo\n", file_path: "/new.ts" }));
  assert.deepEqual(write.detail.files[0].hunks[0], { oldStart: 0, newStart: 1, lines: ["+one", "+two"] });
  assert.deepEqual(write.changes, { added: 2, removed: 0, exactness: "exact" });
});

test("每一輪的增刪行數：失敗的不算，截斷、replace_all、被省略與開頭沒讀到時標「約」", () => {
  const prompt = { id: "s:0", role: "user", text: "Fix" };
  const msg = (index, part) => ({ id: `s:${index}`, role: "assistant", text: "", parts: [part] });
  const tool = (index, part) => ({ id: `s:${index}`, role: "tool", text: "", parts: [part] });
  const answer = (index) => ({ id: `s:${index}`, role: "assistant", text: "Done", parts: [{ id: `s:${index}:p`, kind: "text", text: "Done" }] });
  const changes = (messages) => {
    const [turn] = groupTurns(messages);
    return turnChanges(turn, stepViews(turn.steps));
  };
  const edit = (id, before, after) => call(id, "Edit", { file_path: "/a.ts", old_string: before, new_string: after });
  assert.deepEqual(changes([prompt, msg(1, edit("a", "1", "2\n3")), tool(2, result("a", "ok")),
    msg(3, call("b", "Write", { content: "x\ny\nz", file_path: "/b.ts" })), answer(4)]), { added: 5, removed: 1, approximate: false });
  assert.deepEqual(changes([prompt, msg(1, edit("a", "1", "2")), tool(2, result("a", "<tool_use_error>no</tool_use_error>")),
    msg(3, edit("b", "x", "y")), answer(4)]), { added: 1, removed: 1, approximate: false }, "explicit failures are excluded");
  assert.deepEqual(changes([prompt, msg(1, edit("a", "1", "2")), msg(2, call("b", "Write", '{\n  "content": "cut', { truncated: true })),
    answer(3)]), { added: 1, removed: 1, approximate: true }, "an unreadable edit is not counted and marks the sum");
  assert.deepEqual(changes([prompt, msg(1, edit("a", "1", "2")),
    msg(2, call("p", "apply_patch", "*** Begin Patch\n*** Update File: a\n@@\n-q\n+r", { truncated: true })), answer(3)]),
  { added: 1, removed: 1, approximate: true });
  assert.deepEqual(changes([prompt, msg(1, call("m", "MultiEdit", { file_path: "/a", edits: [{ old_string: "a", new_string: "b", replace_all: true }] })),
    answer(2)]), { added: 1, removed: 1, approximate: true });
  assert.deepEqual(changes([prompt, { ...msg(1, edit("a", "1", "2")), partsTruncated: true }, answer(2)]),
    { added: 1, removed: 1, approximate: true }, "omitted process parts may hide edits");
  assert.deepEqual(changes([msg(1, edit("a", "1", "2")), answer(2)]), { added: 1, removed: 1, approximate: true },
    "the start of a turn cut by the page boundary may hide edits");
  assert.equal(changes([prompt, msg(1, call("r", "Read", { file_path: "/a" })), answer(2)]), undefined);
  assert.equal(changes([prompt, msg(1, call("b", "Write", '{\n  "content": "cut', { truncated: true })), answer(2)]), undefined,
    "no known counts means no number at all");
});

test("推導結果沿用同一個呼叫物件；搜尋文字涵蓋展開後的內容", () => {
  const part = call("a", "Bash", { command: "npm test", description: "Run tests" });
  const output = result("a", "Exit code: 1\nOutput:\n1 failing");
  const first = stepView(step(part, output));
  assert.equal(stepView(step(part, output)), first, "the same call/result objects reuse the derived view");
  assert.notEqual(stepView(step(part, output, result("a", "more"))), first, "a new result recomputes the view");
  assert.match(stepDetailText(first), /npm test[\s\S]*Run tests[\s\S]*1 failing/);
  assert.doesNotMatch(stepDetailText(first), /Exit code/, "search text matches what the detail shows");
  const patch = view(call("p", "apply_patch", "*** Begin Patch\n*** Update File: src/a.ts\n@@ fn main\n-old line\n+new line\n*** End Patch"));
  assert.match(stepDetailText(patch), /src\/a\.ts[\s\S]*fn main[\s\S]*old line[\s\S]*new line/);
  const steps = [{ id: "s:1", role: "assistant", text: "Checking the parser" }, step(part, output)];
  assert.match(processText(steps, stepViews(steps)), /Checking the parser[\s\S]*npm test/);
});
