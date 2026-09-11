import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationTimeline, establishedSessionId, launchContextKey, mergeConversationEvents, validSelectedSessionId, visibleConversationTimeline } from "./conversation.ts";

const event = (sequence, kind, text, extra = {}) => ({ operationId: "turn-1", sessionId: "session-1", projectId: "project-1", source: "codex", occurredAt: 1000 + sequence, sequence, kind, text, ...extra });

test("replay and stale snapshot merge do not duplicate assistant deltas", () => {
  const delta = event(2, "assistant_delta", "Hello ");
  const live = [event(1, "user_message", "Hi"), delta, event(3, "assistant_delta", "world")];
  const merged = mergeConversationEvents(live, [delta, live[0]]);
  assert.equal(merged.length, 3);
  assert.equal(conversationTimeline(merged)[1].text, "Hello world");
});

test("final message replaces streamed content and terminal event ends streaming", () => {
  const items = conversationTimeline([event(1, "assistant_delta", "partial"), event(2, "assistant_done", "complete"), event(3, "turn_completed")]);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "complete");
  assert.equal(items[0].streaming, false);
});

test("sequence restarts on the next operation preserve both turns and tools", () => {
  const events = mergeConversationEvents([event(1, "assistant_done", "first")], [event(1, "assistant_done", "second", { operationId: "turn-2", occurredAt: 2000 }), event(2, "tool_status", "Read file", { operationId: "turn-2", occurredAt: 2001 })]);
  assert.deepEqual(conversationTimeline(events).map((item) => item.text), ["first", "second", "Read file"]);
});

test("failed turn preserves output and closes its stream", () => {
  const items = conversationTimeline([event(1, "assistant_delta", "Saved output"), event(2, "turn_failed", "Process exited")]);
  assert.equal(items[0].text, "Saved output");
  assert.equal(items[0].streaming, false);
  assert.equal(items[1].type, "activity");
});

test("a failed start operation never becomes a resumable session", () => {
  assert.equal(establishedSessionId([event(1, "turn_failed", "Process exited")]), undefined);
  assert.equal(establishedSessionId([event(1, "session_started")]), "session-1");
});

test("history refresh drops a persisted session that is no longer resumable", () => {
  const available = new Set(["real-session"]);
  assert.equal(validSelectedSessionId(available, "failed-operation", "failed-operation"), undefined);
  assert.equal(validSelectedSessionId(available, undefined, "real-session"), "real-session");
});

test("snapshot user message replaces optimistic prompt after offline recovery", () => {
  const local = [{ id: "request-1", type: "prompt", text: "Hi", occurredAt: 1000 }, { id: "turn-1", type: "operation", operation: { id: "turn-1", idempotencyKey: "request-1" } }];
  const events = mergeConversationEvents([event(1, "user_message", "Hi")], [event(1, "user_message", "Hi")]);
  const visible = visibleConversationTimeline(events, local);
  assert.equal(visible.filter((item) => item.type === "prompt").length, 1);
});

test("pending second prompt survives a first turn snapshot", () => {
  const local = [{ id: "request-2", type: "prompt", text: "Next", occurredAt: 2000 }, { id: "turn-2", type: "operation", operation: { id: "turn-2", idempotencyKey: "request-2" } }];
  const visible = visibleConversationTimeline([event(1, "user_message", "Hi")], local);
  assert.deepEqual(visible.filter((item) => item.type === "prompt").map((item) => item.text), ["Hi", "Next"]);
});

test("historical import gives every user message a unique rendering key", () => {
  const items = conversationTimeline([event(1, "user_message", "First"), event(2, "user_message", "Second")]);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
});

test("project tree launch synchronizes the authoritative conversation context", () => {
  const contexts = [
    { key: "project:p1", projectId: "p1" },
    { key: "worktree:w1", projectId: "p1", worktreeId: "w1" },
    { key: "project:p2", projectId: "p2" },
  ];
  assert.equal(launchContextKey(contexts, "project", "p2"), "project:p2");
  assert.equal(launchContextKey(contexts, "worktree", "w1"), "worktree:w1");
  assert.equal(launchContextKey(contexts, "group", "g1"), undefined);
});
