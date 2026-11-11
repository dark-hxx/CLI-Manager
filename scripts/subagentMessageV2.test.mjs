import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

async function load(file) {
  const result = await build({ entryPoints: [file], bundle: true, write: false, platform: "node", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { parseTranscriptLines: parse } = await load("src/shared/lib/subagentTranscriptMessages.ts");
const { boundSubagentTranscript: bound } = await load("src/shared/lib/subagentTranscriptBuffer.ts");
const { buildWebSubagentSnapshots: snapshot } = await load("src/shared/lib/webSubagentSnapshot.ts");
const jsonl = (...rows) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const at = "2026-11-11T12:01:00Z";
const header = { type: "session_meta", payload: { id: "child", parent_thread_id: "parent",
  agent_path: "/root/reviewer", timestamp: "2026-11-11T12:00:00Z", base_instructions: "DO_NOT_COPY", cwd: "PRIVATE_PATH" } };
const inherited = { type: "session_meta", payload: { id: "parent", source: "cli", timestamp: "2026-11-09T00:00:00Z" } };
const turn = id => ({ type: "event_msg", payload: { type: "task_started", turn_id: id,
  turn_attribution: { turn_id: id, parent_turn_id: "parent-turn" } } });
const reply = text => ({ type: "response_item", timestamp: at, payload: {
  type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: "child-turn" },
} });
const communication = (text, extra = {}) => ({ type: "response_item", timestamp: at, payload: {
  type: "agent_message", author: "/root", recipient: "/root/reviewer", content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: "child-turn" }, ...extra,
} });
const envelope = (body, kind = "NEW_TASK", author = "/root", task = "/root/reviewer") =>
  `Message Type: ${kind}\nTask name: ${task}\nSender: ${author}\nPayload:\n${body}`;

test("v2 task and final answer survive inherited parent session_meta", () => {
  const result = parse(jsonl(header, inherited, turn("child-turn"), communication(envelope("Review synthetic changes")), reply("Done")), 1);
  assert.deepEqual(result.messages.map(m => [m.role, m.actor, m.text]), [
    ["user", "parent", "Review synthetic changes"], ["assistant", "child", "Done"],
  ]);
  assert.equal(result.state.child, true);
  assert.equal(result.state.createdAt, header.payload.timestamp);
  assert.equal(result.messages[1].phase, "final");
});

test("encrypted and mixed communication is visible without leaking ciphertext or its wrapper", () => {
  const encrypted = communication("", { content: [
    { type: "input_text", text: envelope("") },
    { type: "encrypted_content", encrypted_content: "SYNTHETIC_CIPHERTEXT_DO_NOT_RENDER" },
  ] });
  const result = parse(jsonl(header, turn("child-turn"), encrypted, reply("Done")), 1);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].notice, "encrypted");
  assert.equal(result.messages[0].actor, "parent");
  assert.equal(result.messages[0].text, "");
  assert.doesNotMatch(JSON.stringify(result.messages), /CIPHERTEXT|Payload|NEW_TASK/);
  const mixed = structuredClone(encrypted);
  mixed.payload.content[0].text = envelope("Readable portion");
  const m = parse(jsonl(header, mixed), 1).messages[0];
  assert.equal(m.text, "Readable portion");
  assert.equal(m.notice, "encrypted");
});

test("nested paths, siblings, inherited traffic and fragments do not impersonate the parent", () => {
  const sibling = communication("Sibling note", { author: "/root/other" });
  const unrelated = communication("Other task", { author: "/root/other", recipient: "/root/third" });
  const old = { ...communication("Old task"), timestamp: "2026-11-09T00:00:00Z" };
  const messages = parse(jsonl(header, sibling, unrelated, old), 1).messages;
  assert.equal(messages[0].actor, "unknown");
  assert.equal(messages[1].kind, "context");
  assert.equal(messages[2].kind, "context");
  assert.equal(parse(jsonl(communication("No identity")), 1).messages[0].actor, "unknown");
  const nested = structuredClone(header); nested.payload.agent_path = "/root/reviewer/worker";
  const m = parse(jsonl(nested, communication("Nested task", { author: "/root/reviewer", recipient: "/root/reviewer/worker" })), 1).messages[0];
  assert.equal(m.actor, "parent");
  const response = parse(jsonl(header, communication(envelope("Finished", "FINAL_ANSWER", "/root/reviewer"), {
    author: "/root/reviewer", recipient: "/root",
  })), 1).messages[0];
  assert.deepEqual([response.actor, response.role, response.phase, response.text], ["child", "assistant", "final", "Finished"]);
});

test("incremental follow-ups preserve identity and reset discards previous thread state", () => {
  const first = parse(jsonl(header, inherited, turn("child-turn"), communication("First")), 1);
  const next = parse(jsonl(turn("follow"), communication("Follow-up", {
    internal_chat_message_metadata_passthrough: { turn_id: "follow" },
  })), first.nextId, undefined, first.state);
  assert.equal(next.messages[0].actor, "parent");
  assert.ok(next.messages[0].id > first.messages[0].id);
  assert.equal(parse(jsonl(reply("New fragment")), 1).messages[0].actor, "unknown");
});

test("bounded Store/desktop/Web windows retain compact identity without inherited secrets", () => {
  const tail = jsonl(turn("child-turn"), communication("Latest task"), reply("Latest reply"));
  const source = jsonl(header, inherited, { type: "world_state", payload: { value: "x".repeat(10000) } }) + tail;
  for (const limit of [1800, 2400, 4096]) {
    const limited = bound("", source, limit);
    assert.ok(limited.content.length <= limit);
    assert.ok(limited.droppedChars > 0);
    assert.doesNotMatch(limited.content, /PRIVATE_PATH|DO_NOT_COPY/);
    const parsed = parse(limited.content, 1);
    assert.deepEqual(parsed.messages.map(m => m.actor), ["parent", "child"]);
    const appended = bound(limited.content, jsonl(communication("Another")), limit);
    assert.ok(appended.content.length <= limit);
    assert.equal(parse(appended.content, 1).messages.at(-1).actor, "parent");
  }
  assert.equal(bound(source, tail, 4096, true).content, tail);
  assert.ok(bound("", source, 16).content.length <= 16);
});

test("classic Web snapshot transports encrypted notice, not ciphertext, while honoring budgets", () => {
  const input = jsonl(header, inherited, turn("child-turn"), communication("", {
    content: [{ type: "encrypted_content", encrypted_content: "SYNTHETIC_CIPHERTEXT_DO_NOT_RENDER" }],
  }), reply("Result"));
  const sessions = [{ id: "v2-child", title: "Review", kind: "subagent-transcript", subagent: { parentSessionId: "p" } }];
  const output = snapshot(sessions, { "v2-child": { content: input, ended: true, source: { kind: "child-jsonl" } } }, new Set(["p"]));
  assert.ok(Buffer.byteLength(output[0].content) <= 32 * 1024);
  assert.doesNotMatch(output[0].content, /CIPHERTEXT|PRIVATE_PATH/);
  const messages = parse(output[0].content, 1).messages;
  assert.deepEqual(messages.map(m => m.actor), ["parent", "child"]);
  assert.equal(messages[0].notice, "encrypted");
  for (const file of ["src/features/terminal/store/terminalRuntime.ts", "src/features/terminal/components/SubagentTranscriptView.tsx", "src/shared/lib/webSubagentSnapshot.ts"]) {
    assert.match(readFileSync(file, "utf8"), /boundSubagentTranscript\(/, `${file} uses the real bounded path`);
  }
});
