import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pluginPath = new URL("../src-tauri/resources/opencode/cli-manager-hook.js", import.meta.url);
const source = readFileSync(pluginPath, "utf8");

process.env.CLI_MANAGER_TAB_ID = "terminal-tab-1";
process.env.CLI_MANAGER_NOTIFY_PORT = "9876";
process.env.CLI_MANAGER_NOTIFY_TOKEN = "test-token";

const calls = [];
// 用内存替身收集通知正文，所有测试均不发送真实 HTTP 请求。
globalThis.fetch = async (_url, options) => {
  calls.push(JSON.parse(options.body));
  return { ok: true };
};

const plugin = await import(`${pluginPath.href}?test=${Date.now()}`);
// 为每个场景创建独立身份跟踪器；插件模块级状态仍由源码管理。
const newBridge = () => plugin.CliManagerSessionBridge();

const rootId = "ses_rootA";
const childId = "ses_childA";
const grandchildId = "ses_grandchildA";
const secondRootId = "ses_rootB";

// 构造携带规范 ID 与可选父信息的会话创建事件。
function created(id, extra = {}) {
  return {
    type: "session.created",
    properties: { sessionID: id, info: { id, ...extra } },
  };
}

// 构造会话更新事件，默认采用忙碌状态并允许覆盖详情字段。
function updated(id, status = { type: "busy" }, extra = {}) {
  return {
    type: "session.updated",
    properties: { sessionID: id, info: { id, ...extra }, status },
  };
}

// 构造只携带规范会话 ID 和状态的事件。
function status(id, status = { type: "busy" }) {
  return { type: "session.status", properties: { sessionID: id, status } };
}

// 构造用于验证删除标记及后代清理的事件。
function deleted(id) {
  return { type: "session.deleted", properties: { sessionID: id, info: { id } } };
}

// 验证仅发布根会话创建和运行状态，忽略子会话生命周期。
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
    // 将收集到的通知投影为事件与会话 ID，忽略时间等动态字段。
    calls.map(({ event, sessionId }) => ({ event, sessionId })),
    [
      { event: "SessionStart", sessionId: rootId },
      { event: "UserPromptSubmit", sessionId: rootId },
    ],
  );
});

// 验证先到达的子会话在父根出现后解析身份，但不补发子事件。
test("child sessions that arrive before their parent are resolved without replaying child events", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  const lateChildId = "ses_lateChildA";
  const lateRootId = "ses_lateRootA";
  await bridge.event(created(lateChildId, { parentID: lateRootId }));
  await bridge.event(status(lateChildId));
  await bridge.event(created(lateRootId));
  await bridge.event(status(lateChildId, { type: "idle" }));

  // 将通知投影为事件和会话标识，验证只含后到达的根创建事件。
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), [
    { event: "SessionStart", sessionId: lateRootId },
  ]);
});

// 验证切换根后，旧根延迟状态不重新绑定终端。
test("root switching does not let late old-root status rebind the tab", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(rootId));
  await bridge.event(created(secondRootId));
  // Late status for the previous root must not publish because rootB is active.
  await bridge.event(status(rootId));

  // 投影通知字段，期望只保留两个根的创建事件。
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), [
    { event: "SessionStart", sessionId: rootId },
    { event: "SessionStart", sessionId: secondRootId },
  ]);
});

// 验证删除根后，缺失父信息的延迟子更新仍被临时标记拦截。
test("root deletion tombstones descendants so late parent-less child updates cannot become root", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(rootId));
  await bridge.event(created(childId, { parentID: rootId }));
  await bridge.event(deleted(rootId));
  calls.length = 0;

  // A late child update without parent info must NOT be promoted to a root.
  await bridge.event(updated(childId));
  // 投影通知身份字段，确保未发布被删除根的子会话。
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), []);
});

// 验证已删除根不会被延迟更新事件复活。
test("deleted root cannot be revived by a late session.updated", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(rootId));
  await bridge.event(deleted(rootId));
  calls.length = 0;
  await bridge.event(updated(rootId));
  // 投影通知身份字段，确认删除后的更新未产生通知。
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), []);
});

// 验证规范字段存在但非法时，不使用兼容字段中的合法 ID。
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

// 验证旧事件缺失规范字段时可使用详情 ID 绑定根会话。
test("canonical sessionID missing falls back to info.id for old event shapes", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event({ type: "session.created", properties: { info: { id: rootId } } });
  await bridge.event(status(rootId));
  // 投影通知字段，核对兼容绑定后的创建和运行事件。
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), [
    { event: "SessionStart", sessionId: rootId },
    { event: "UserPromptSubmit", sessionId: rootId },
  ]);
});

// 验证路径定位串、空格 ID 和消息 ID 不进入通知端点。
test("invalid and locator-like IDs never reach the hook endpoint", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event({ type: "session.created", properties: { sessionID: "/tmp/opencode.db#session=ses_bad" } });
  await bridge.event(status("ses bad"));
  await bridge.event(created("msg_messageId"));
  assert.equal(calls.length, 0);
});

// 验证循环父链不会崩溃或发布子 ID，已有根保持有效。
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
  // 投影通知字段，确认循环链未引入额外发布事件。
  assert.deepEqual(calls.map(({ event, sessionId }) => ({ event, sessionId })), [
    { event: "SessionStart", sessionId: root },
  ]);
});

// 发送大量无关状态事件，验证活动根仍可发布创建与运行状态。
test("capacity eviction does not break the active root", async () => {
  calls.length = 0;
  const bridge = await newBridge();
  await bridge.event(created(rootId));
  for (let i = 0; i < 1030; i += 1) {
    await bridge.event({ type: "session.status", properties: { sessionID: `ses_filler${i}`, status: { type: "idle" } } });
  }
  await bridge.event(status(rootId));
  // 查找活动根创建通知，不要求无关状态事件确实触发缓存淘汰。
  assert.ok(calls.some(({ event, sessionId }) => event === "SessionStart" && sessionId === rootId));
  // 查找活动根运行通知，确认大量无关事件后绑定仍可用。
  assert.ok(calls.some(({ event, sessionId }) => event === "UserPromptSubmit" && sessionId === rootId));
});
