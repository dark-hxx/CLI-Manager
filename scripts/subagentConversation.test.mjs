import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load(file) {
  const result = await build({ entryPoints: [file], bundle: true, write: false, platform: "node", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { parseTranscriptLines: parse } = await load("src/shared/lib/subagentTranscriptMessages.ts");
const { buildWebSubagentSnapshots: snapshot } = await load("src/shared/lib/webSubagentSnapshot.ts");
const jsonl = (...rows) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const header = { type: "session_meta", payload: { timestamp: "2026-11-03T12:00:00Z",
  source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } } };
const turn = id => ({ type: "event_msg", payload: { type: "task_started", turn_id: id,
  turn_attribution: { turn_id: id, parent_turn_id: "parent-turn" } } });
const message = (role, text, options = {}) => ({ type: "response_item", timestamp: "2026-11-03T12:01:00Z", payload: {
  type: "message", role, content: [{ type: "text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: "child-turn", content_item_kinds: ["user.text"] }, ...options,
} });

test("Codex provenance, injection, phase, tools, reasoning and duplicate event messages", () => {
  const result = parse(jsonl(header, turn("child-turn"),
    message("developer", "system instructions"), message("user", "do the review"),
    message("assistant", "checking", { phase: "commentary" }),
    { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "patch data" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", output: "OK" } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] } },
    message("assistant", "done", { phase: "final_answer" }),
    { type: "event_msg", payload: { type: "agent_message", message: "done" } }), 1);
  assert.deepEqual(result.messages.map(m => m.kind), ["context", "text", "text", "tool_call", "tool_result", "reasoning", "text"]);
  assert.equal(result.messages[1].actor, "parent");
  assert.equal(result.messages[2].actor, "child");
  assert.equal(result.messages[2].phase, "progress");
  assert.equal(result.messages[6].phase, "final");
  assert.match(result.messages[3].text, /apply_patch\npatch data/);
});

test("inherited history is not passed off as a child reply; legacy fragments remain neutral", () => {
  const result = parse(jsonl(header, turn("child-turn"),
    message("assistant", "parent history", { internal_chat_message_metadata_passthrough: { turn_id: "parent-turn" } }),
    { ...message("user", "old"), timestamp: "2026-11-03T11:00:00Z" },
    message("user", "# AGENTS.md instructions for repo"),
    message("user", "Please review the literal <environment_context> marker"),
    message("user", "custom prefix", { internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions"] } })), 1);
  assert.deepEqual(result.messages.map(m => m.kind), ["context", "context", "context", "text", "context"]);
  assert.equal(result.messages[0].actor, "unknown");
  const fragment = parse(jsonl(message("assistant", "legacy", { phase: "final_answer" })), 1);
  assert.equal(fragment.messages[0].actor, "unknown");
  assert.equal(fragment.messages[0].text, "legacy");
});

test("incremental state and reset stay isolated; malformed records don't fail a batch", () => {
  const start = parse(jsonl(header, turn("child-turn"), message("user", "task")), 1);
  const append = parse(jsonl(message("assistant", "done")), start.nextId, undefined, start.state);
  const full = parse(jsonl(header, turn("child-turn"), message("user", "task"), message("assistant", "done")), 1);
  assert.deepEqual([...start.messages, ...append.messages], full.messages);
  assert.equal(start.nextId, 2);
  const reset = parse("bad line\nnull\n[]\n" + jsonl(message("user", "new")), 1);
  assert.equal(reset.messages.length, 1);
  assert.equal(reset.messages[0].actor, "unknown");
  const follow = parse(jsonl(turn("follow-up"), message("user", "next", {
    internal_chat_message_metadata_passthrough: { turn_id: "follow-up" },
  })), append.nextId, undefined, append.state);
  assert.equal(follow.messages[0].actor, "parent");
  assert.equal(start.state.turnId, "child-turn");
});

test("Claude mixed blocks retain separate tools and text, without assuming parent identity", () => {
  const { messages } = parse(jsonl({ type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "Starting" }, { type: "thinking", thinking: "Plan" },
    { type: "tool_use", name: "Read", input: { path: "file.ts" } },
  ] } }, { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "output" }] }] } }), 1);
  assert.deepEqual(messages.map(m => m.kind), ["text", "reasoning", "tool_call", "tool_result"]);
  assert.ok(messages.every(m => m.actor === "unknown"));
  assert.match(messages[2].text, /file.ts/);
  assert.equal(messages[3].text, "output");
});

test("Web snapshot keeps v1 classification, old clients, budget and parent isolation", () => {
  const content = jsonl(header, turn("child-turn"), message("user", "task"), message("assistant", "result", { phase: "final_answer" }));
  const session = { id: "child", title: "Child", kind: "subagent-transcript", subagent: { parentSessionId: "parent" } };
  const [child] = snapshot([session, { ...session, id: "other", subagent: { parentSessionId: "unrelated" } }],
    { child: { content, ended: true, source: { kind: "child-jsonl", transcriptPath: "PRIVATE_PATH" } } }, new Set(["parent"]));
  const actual = parse(child.content, 1).messages;
  assert.deepEqual(actual, parse(content, 1).messages);
  const legacy = child.content.trim().split("\n").map(line => JSON.parse(line).message.content);
  assert.deepEqual(legacy, ["task", "result"]);
  assert.ok(!child.content.includes("PRIVATE_PATH"));
  const sessions = Array.from({ length: 64 }, (_, index) => ({ ...session, id: `child-${index}` }));
  const transcripts = Object.fromEntries(sessions.map(s => [s.id, { content: jsonl(message("assistant", "中🙂".repeat(40000))), ended: false, source: { kind: "child-jsonl" } }]));
  const snapshots = snapshot(sessions, transcripts, new Set(["parent"]));
  assert.ok(snapshots.every(s => s.truncated && Buffer.byteLength(s.content) <= 2048));
  assert.ok(snapshots.reduce((sum, s) => sum + Buffer.byteLength(s.content), 0) <= 128 * 1024);
});

test("invalid snapshot metadata is ignored and binary attachments stay bounded", () => {
  const { messages } = parse(jsonl({ type: "assistant", cliManagerSubagent: { version: 1, kind: "BOGUS", actor: "child" },
    message: { content: "legacy" } }, { type: "user", message: { content: [{ type: "image", source: { data: "BASE64".repeat(9999) } }] } }), 1);
  assert.equal(messages[0].actor, "unknown");
  assert.equal(messages[1].text, "[image]");
});

test("Web bounded windows preserve original row IDs across appends", () => {
  const session = { id: "sliding", title: "Sliding", kind: "subagent-transcript", subagent: { parentSessionId: "parent" } };
  const content = jsonl(...Array.from({ length: 150 }, (_, i) => message("assistant", `reply ${i}`)));
  const make = data => parse(snapshot([session], { sliding: { content: data, ended: false, source: { kind: "child-jsonl" } } },
    new Set(["parent"]))[0].content, 1).messages;
  const before = make(content), after = make(content + jsonl(message("assistant", "new reply")));
  for (const row of before) {
    const matching = after.find(candidate => candidate.text === row.text);
    if (matching) assert.equal(matching.id, row.id);
  }
  assert.equal(after.at(-1).id, 151);
});
