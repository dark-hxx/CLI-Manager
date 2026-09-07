import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pluginPath = new URL("../src-tauri/resources/opencode/cli-manager-hook.js", import.meta.url);
const source = readFileSync(pluginPath, "utf8");

process.env.CLI_MANAGER_TAB_ID = "terminal-tab-1";
process.env.CLI_MANAGER_NOTIFY_PORT = "9876";
process.env.CLI_MANAGER_NOTIFY_TOKEN = "test-token";

const calls = [];
globalThis.fetch = async (_url, options) => {
  calls.push(JSON.parse(options.body));
  return { ok: true };
};

const plugin = await import(`${pluginPath.href}?test=${Date.now()}`);
const newBridge = () => plugin.CliManagerSessionBridge();

const rootId = "ses_rootA";
const childId = "ses_childA";
const grandchildId = "ses_grandchildA";
const secondRootId = "ses_rootB";

function created(id, extra = {}) {
  return {
    type: "session.created",
    properties: { sessionID: id, info: { id, ...extra } },
  };
}

function updated(id, status = { type: "busy" }, extra = {}) {
  return {
    type: "session.updated",
    properties: { sessionID: id, info: { id, ...extra }, status },
  };
}

function status(id, status = { type: "busy" }) {
  return { type: "session.status", properties: { sessionID: id, status } };
}

function deleted(id) {
  return { type: "session.deleted", properties: { sessionID: id, info: { id } } };
}

test("OpenCode hook binds the canonical root session and ignores child lifecycle events", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(childId, { parentID: rootId }));
  await bridge.event(status(childId));
  await bridge.event(created(grandchildId, { parentID: childId }));
  await bridge.event(created(rootId));
  await bridge.event(updated(rootId, { type: "busy" }, { title: "root" }));
  await bridge.event({ type: "session.idle", properties: { sessionID: childId } });
  await bridge.event({ type: "session.error", properties: { sessionID: grandchildId } });

  assert.deepEqual(
    calls.map(({ event, sessionId }) => ({ event, sessionId })),
    [
      { event: "SessionStart", sessionId: rootId },
      { event: "UserPromptSubmit", sessionId: rootId },
    ],
  );
});

test("child sessions that arrive before their parent are resolved without replaying child events", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  const lateChildId = "ses_lateChildA";
  const lateRootId = "ses_lateRootA";
  await bridge.event(created(lateChildId, { parentID: lateRootId }));
  await bridge.event(status(lateChildId));
  await bridge.event(created(lateRootId));
  await bridge.event(status(lateChildId, { type: "idle" }));

  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), [
    { event: "SessionStart", sessionId: lateRootId },
  ]);
});

test("root switching does not let late old-root status rebind the tab", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(rootId));
  await bridge.event(created(secondRootId));
  // Late status for the previous root must not publish because rootB is active.
  await bridge.event(status(rootId));

  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), [
    { event: "SessionStart", sessionId: rootId },
    { event: "SessionStart", sessionId: secondRootId },
  ]);
});

test("root deletion tombstones descendants so late parent-less child updates cannot become root", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(rootId));
  await bridge.event(created(childId, { parentID: rootId }));
  await bridge.event(deleted(rootId));
  calls.length = 0;

  // A late child update without parent info must NOT be promoted to a root.
  await bridge.event(updated(childId));
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), []);
});

test("deleted root cannot be revived by a late session.updated", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(rootId));
  await bridge.event(deleted(rootId));
  calls.length = 0;
  await bridge.event(updated(rootId));
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), []);
});

test("canonical sessionID present but invalid does not fall back to info.id", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event({
    type: "session.created",
    properties: { sessionID: "not-valid", info: { id: rootId } },
  });
  await bridge.event(status("not-valid"));
  assert.equal(calls.length, 0);
});

test("canonical sessionID missing falls back to info.id for old event shapes", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event({ type: "session.created", properties: { info: { id: rootId } } });
  await bridge.event(status(rootId));
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), [
    { event: "SessionStart", sessionId: rootId },
    { event: "UserPromptSubmit", sessionId: rootId },
  ]);
});

test("invalid and locator-like IDs never reach the hook endpoint", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event({ type: "session.created", properties: { sessionID: "/tmp/opencode.db#session=ses_bad" } });
  await bridge.event(status("ses bad"));
  await bridge.event(created("msg_messageId"));
  assert.equal(calls.length, 0);
});

test("parent cycles are bounded without crashing and without publishing child IDs", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  const root = "ses_cycleRoot";
  const a = "ses_cycleA";
  const b = "ses_cycleB";
  const c = "ses_cycleC";
  await bridge.event(created(root));
  await bridge.event(created(a, { parentID: b }));
  await bridge.event(created(b, { parentID: c }));
  await bridge.event(created(c, { parentID: a }));
  await bridge.event(status(a));
  await bridge.event(status(b));
  await bridge.event(status(c));
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), [
    { event: "SessionStart", sessionId: root },
  ]);
});

test("capacity eviction does not break the active root", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(rootId));
  for (let i = 0; i < 1030; i += 1) {
    await bridge.event({ type: "session.status", properties: { sessionID: `ses_filler${i}`, status: { type: "idle" } } });
  }
  await bridge.event(status(rootId));
  assert.ok(calls.some(({ event, sessionId }) => event === "SessionStart" && sessionId === rootId));
  assert.ok(calls.some(({ event, sessionId }) => event === "UserPromptSubmit" && sessionId === rootId));
});
