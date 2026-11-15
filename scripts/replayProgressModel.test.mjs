import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/features/terminal/components/replayProgressModel.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  buildReplayProgressModel,
  createReplayEventMatcher,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function replayEvent(eventIndex, kind, event, overrides = {}) {
  return {
    id: eventIndex,
    sessionKey: "tab-1",
    eventIndex,
    kind,
    title: overrides.title ?? event,
    detail: overrides.detail ?? event,
    timestamp: overrides.timestamp ?? `2026-07-10T10:00:${String(eventIndex).padStart(2, "0")}.000Z`,
    durationMs: null,
    status: overrides.status ?? (event.endsWith("Stop") || event === "Stop" ? "completed" : "running"),
    tags: overrides.tags ?? [kind],
    payload: {
      event,
      source: "codex",
      ...overrides.payload,
    },
  };
}

function historyDetail(overrides = {}) {
  return {
    session_id: "cli-session-1",
    source: "codex",
    project_key: "project",
    title: "Task",
    file_path: "rollout.jsonl",
    cwd: "D:/work/project",
    created_at: 1,
    updated_at: 2,
    message_count: 0,
    messages: [],
    tool_events: [],
    file_changes: [],
    ...overrides,
  };
}

test("builds latest-first turns while keeping steps chronological", () => {
  const events = [
    replayEvent(1, "prompt", "UserPromptSubmit", { payload: { message: "first task" } }),
    replayEvent(2, "tool", "ToolStart", { title: "Read", payload: { toolUseId: "call-1", toolName: "Read" } }),
    replayEvent(3, "tool", "ToolStop", { title: "Read", payload: { toolUseId: "call-1", toolName: "Read" } }),
    replayEvent(4, "session", "Stop"),
    replayEvent(5, "prompt", "UserPromptSubmit", { payload: { message: "second task" } }),
    replayEvent(6, "session", "Stop"),
  ];
  const history = historyDetail({
    messages: [
      { role: "user", content: "first task", timestamp: "2026-07-10T10:00:01.000Z" },
      { role: "assistant", content: "first result", timestamp: "2026-07-10T10:00:04.000Z" },
      { role: "user", content: "second task", timestamp: "2026-07-10T10:00:05.000Z" },
      { role: "assistant", content: "second result", timestamp: "2026-07-10T10:00:06.000Z" },
    ],
  });

  const model = buildReplayProgressModel(events, history);

  assert.equal(model.turns.length, 2);
  assert.equal(model.turns[0].prompt, "second task");
  assert.equal(model.turns[0].response, "second result");
  assert.equal(model.turns[1].steps.length, 1);
  assert.deepEqual(model.turns[1].steps[0].rawEvents.map((event) => event.eventIndex), [2, 3]);
  assert.equal(model.turns[1].steps[0].status, "completed");
});

test("handles history turns that do not yet have matching replay prompts", () => {
  const events = [
    replayEvent(1, "prompt", "UserPromptSubmit", { payload: { message: "first task" } }),
  ];
  const history = historyDetail({
    messages: [
      { role: "user", content: "first task" },
      { role: "assistant", content: "first result" },
      { role: "user", content: "history-only task" },
      { role: "assistant", content: "history-only result" },
    ],
  });

  const model = buildReplayProgressModel(events, history);

  assert.equal(model.turns.length, 2);
  assert.equal(model.turns[0].prompt, "history-only task");
  assert.equal(model.turns[0].response, "history-only result");
});

test("pairs concurrent tool lifecycles only by exact toolUseId", () => {
  const events = [
    replayEvent(1, "prompt", "UserPromptSubmit", { payload: { message: "task" } }),
    replayEvent(2, "tool", "ToolStart", { title: "Read", payload: { toolUseId: "a", toolName: "Read" } }),
    replayEvent(3, "tool", "ToolStart", { title: "Read", payload: { toolUseId: "b", toolName: "Read" } }),
    replayEvent(4, "tool", "ToolStop", { title: "Read", payload: { toolUseId: "a", toolName: "Read" } }),
  ];

  const model = buildReplayProgressModel(events, null);
  const tools = model.turns[0].steps.filter((step) => step.kind === "tool");

  assert.equal(tools.length, 2);
  assert.equal(tools.find((step) => step.id === "tool-a")?.status, "completed");
  assert.equal(tools.find((step) => step.id === "tool-b")?.status, "running");
});

test("marks an unclosed action from an older turn as incomplete", () => {
  const events = [
    replayEvent(1, "prompt", "UserPromptSubmit", { payload: { message: "first" } }),
    replayEvent(2, "tool", "ToolStart", { title: "Read", payload: { toolUseId: "old", toolName: "Read" } }),
    replayEvent(3, "prompt", "UserPromptSubmit", { payload: { message: "second" } }),
  ];

  const model = buildReplayProgressModel(events, null, "running");

  assert.equal(model.turns[1].status, "completed");
  assert.equal(model.turns[1].steps[0].status, "incomplete");
});

test("uses history tool output, recognizes validation, and maps file operations to turns", () => {
  const events = [
    replayEvent(1, "prompt", "UserPromptSubmit", { payload: { message: "check project" } }),
    replayEvent(2, "tool", "ToolStart", { title: "PowerShell", payload: { toolUseId: "check-1", toolName: "PowerShell" } }),
    replayEvent(3, "tool", "ToolStop", { title: "PowerShell", payload: { toolUseId: "check-1", toolName: "PowerShell" } }),
    replayEvent(4, "session", "Stop"),
  ];
  const history = historyDetail({
    messages: [
      { role: "user", content: "check project", timestamp: "2026-07-10T10:00:01.000Z" },
      { role: "assistant", content: "done", timestamp: "2026-07-10T10:00:04.000Z" },
    ],
    tool_events: [{
      call_id: "check-1",
      name: "PowerShell",
      category: "builtin",
      message_index: 1,
      timestamp: "2026-07-10T10:00:02.000Z",
      status: "completed",
      duration_ms: 1200,
      input_summary: "npx tsc --noEmit",
      output_summary: "exit code 0",
    }],
    file_changes: [{
      file_path: "src/app/App.tsx",
      status: "M",
      additions: 2,
      deletions: 1,
      latest_message_index: 1,
      latest_operation_group_index: 1,
      latest_timestamp: "2026-07-10T10:00:03.000Z",
      operations: [{
        source: "patch",
        tool_name: "Edit",
        file_path: "src/app/App.tsx",
        patch: "@@\n-old\n+new",
        additions: 2,
        deletions: 1,
        message_index: 1,
        operation_group_index: 1,
        timestamp: "2026-07-10T10:00:03.000Z",
      }],
    }],
  });

  const model = buildReplayProgressModel(events, history);
  const turn = model.turns[0];
  const validation = turn.steps.find((step) => step.kind === "validation");
  const files = turn.steps.find((step) => step.kind === "file");

  assert.equal(validation?.outputSummary, "exit code 0");
  assert.equal(validation?.durationMs, 1200);
  assert.equal(files?.files[0].file_path, "src/app/App.tsx");
  assert.equal(turn.counts.files, 1);
  assert.equal(turn.counts.validations, 1);
});

test("falls back to hook prompts and searches structured raw fields", () => {
  const event = replayEvent(1, "mcp", "ToolStart", {
    title: "query",
    payload: { toolUseId: "mcp-1", toolName: "mcp__gitnexus__query", mcpServer: "gitnexus" },
  });
  const model = buildReplayProgressModel([
    replayEvent(0, "prompt", "UserPromptSubmit", { payload: { message: "trace flow" } }),
    event,
  ], null);

  assert.equal(model.turns[0].prompt, "trace flow");
  assert.equal(model.turns[0].steps[0].kind, "mcp");
  assert.equal(createReplayEventMatcher("gitnexus")(event), true);
  assert.equal(createReplayEventMatcher("missing")(event), false);
});

test("classifies raw tool names into readable activities and extracts real targets", () => {
  const history = historyDetail({
    messages: [
      { role: "user", content: "fix build", timestamp: "2026-07-10T10:00:00.000Z" },
      { role: "assistant", content: "done", timestamp: "2026-07-10T10:01:00.000Z" },
    ],
    tool_events: [
      { call_id: "c1", name: "exec_command", category: "tool", message_index: 1, timestamp: "2026-07-10T10:00:01.000Z", status: "completed", input_summary: "{\"cmd\":\"sed -n 1,80p src/App.tsx\",\"workdir\":\"D:/p\"}" },
      { call_id: "c2", name: "exec_command", category: "tool", message_index: 1, timestamp: "2026-07-10T10:00:02.000Z", status: "completed", input_summary: "{\"cmd\":\"rg -n useStore src\"}" },
      { call_id: "c3", name: "exec_command", category: "tool", message_index: 1, timestamp: "2026-07-10T10:00:03.000Z", status: "completed", input_summary: "{\"cmd\":\"rg -n other src\"}" },
      { call_id: "c4", name: "apply_patch", category: "tool", message_index: 1, timestamp: "2026-07-10T10:00:04.000Z", status: "completed", input_summary: "*** Begin Patch\n*** Update File: src/App.tsx\n@@" },
      { call_id: "c5", name: "shell", category: "tool", message_index: 1, timestamp: "2026-07-10T10:00:05.000Z", status: "failed", input_summary: "{\"command\":[\"bash\",\"-lc\",\"git status --short\"],\"timeout\":10" },
      { call_id: "c6", name: "Bash", category: "tool", message_index: 1, timestamp: "2026-07-10T10:00:06.000Z", status: "completed", input_summary: "{\"command\":\"npx tsc --noEmit\"}" },
    ],
  });

  const [turn] = buildReplayProgressModel([], history).turns;
  const byId = Object.fromEntries(turn.steps.map((step) => [step.id, step]));

  assert.equal(byId["tool-c1"].activity, "read");
  assert.equal(byId["tool-c1"].target, "sed -n 1,80p src/App.tsx");
  assert.equal(byId["tool-c2"].activity, "search");
  assert.equal(byId["tool-c4"].activity, "edit");
  assert.equal(byId["tool-c4"].target, "src/App.tsx");
  assert.equal(byId["tool-c5"].activity, "command");
  assert.equal(byId["tool-c5"].target, "git status --short");
  assert.equal(byId["tool-c6"].activity, "validation");
  assert.deepEqual(turn.phases.map((phase) => [phase.activity, phase.steps.length]), [
    ["read", 1],
    ["search", 2],
    ["edit", 1],
    ["command", 1],
    ["validation", 1],
  ]);
  assert.equal(turn.phases[3].status, "failed");
  assert.equal(turn.activityCounts.search, 2);
});

test("uses the user's real input as turn titles and skips CLI-injected user messages", () => {
  const history = historyDetail({
    messages: [
      { role: "user", content: "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>", timestamp: "2026-07-10T10:00:00.000Z" },
      { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>", timestamp: "2026-07-10T10:00:00.000Z" },
      { role: "user", content: "<local-command-stdout>Set model to opus</local-command-stdout>", timestamp: "2026-07-10T10:00:00.000Z" },
      { role: "user", content: "<system-reminder>\nCodebase instructions...\n</system-reminder>\n隐藏所有赞助商入口", timestamp: "2026-07-10T10:01:00.000Z" },
      { role: "assistant", content: "已隐藏", timestamp: "2026-07-10T10:02:00.000Z" },
      { role: "user", content: "[Image #1] [Image #2] 滚动条默认隐藏\n[Image: source: C:\a.png]\n[Image: source: C:\b.png]", timestamp: "2026-07-10T10:03:00.000Z" },
    ],
  });
  const events = [
    replayEvent(1, "prompt", "UserPromptSubmit", { payload: { message: "隐藏所有赞助商入口" } }),
    replayEvent(2, "session", "Stop"),
    replayEvent(3, "prompt", "UserPromptSubmit", { payload: { message: "[Image #1] [Image #2] 滚动条默认隐藏" } }),
    replayEvent(4, "snapshot", "Snapshot", { status: "saved" }),
  ];

  const turns = [...buildReplayProgressModel(events, history).turns].reverse();

  assert.deepEqual(turns.map((turn) => turn.prompt), ["/model opus", "隐藏所有赞助商入口", "滚动条默认隐藏"]);
  assert.equal(turns[0].response, "Set model to opus");
  assert.equal(turns[1].response, "已隐藏");
  assert.equal(turns[2].images, 2);
  assert.equal(turns[2].steps.find((step) => step.kind === "snapshot")?.id, "snapshot-4");
  // 跳转历史会话时定位到用户真实输入所在的消息。
  assert.deepEqual(turns.map((turn) => turn.messageIndex), [1, 3, 5]);
  assert.equal(buildReplayProgressModel(events, null).turns[0].messageIndex, null);
});
