import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-history-deletion-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

// 编译真实策略模块，仅重写临时测试目录中的 ESM 导入位置。
async function loadModule(relativePath, name, imports = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [original, replacement] of Object.entries(imports)) {
    output = output.replaceAll(`"${original}"`, `"${replacement}"`);
  }
  const path = join(tempDir, `${name}.mjs`);
  writeFileSync(path, output, "utf8");
  return import(pathToFileURL(path).href);
}

const { HISTORY_SOURCE_DESCRIPTORS } = await loadModule("../src/shared/lib/historySources.ts", "historySources");
await loadModule("../src/features/history/lib/historySubagents.ts", "historySubagents");
const {
  assertHistorySessionDeletable,
  executeHistoryDeletion,
  getHistoryDeletionBlockReason,
  historyDeletedSessionKeys,
  historyDeletionErrorKey,
  planHistoryDeletion,
} = await loadModule("../src/features/history/lib/historyDeletion.ts", "historyDeletion", {
  "../../../shared/lib/historySources": "./historySources.mjs",
  "./historySubagents": "./historySubagents.mjs",
});
const { zh } = await loadModule("../src/shared/i18n/messages/history.zh-CN.ts", "historyZh");
const { en } = await loadModule("../src/shared/i18n/messages/history.en-US.ts", "historyEn");

const fileSources = ["pi", "gemini", "copilot", "antigravity", "kiro", "cursor", "cline"];
const allSources = ["claude", "codex", "grok", "kimi", "opencode", ...fileSources];

// 使用完整的列表身份，子会话可独立覆盖来源、项目、原路径和传输方式。
function session(source = "pi", id = "parent", overrides = {}) {
  return {
    source, session_id: id, sessionKey: `${source}:${id}`, project_key: "project",
    file_path: `C:/history/${source}/${id}/${id}.jsonl`, parent_session_id: null,
    title: id, displayTitle: id, alias: "", starred: false, tags: [],
    created_at: 1, updated_at: 2, message_count: 1,
    ...overrides,
  };
}

test("all twelve readers explicitly support deletion without enabling other writers", () => {
  assert.deepEqual(HISTORY_SOURCE_DESCRIPTORS.map((item) => item.id).sort(), [...allSources].sort());
  for (const descriptor of HISTORY_SOURCE_DESCRIPTORS) {
    assert.equal(descriptor.capabilities.delete, "supported", descriptor.id);
    assert.equal(descriptor.capabilities.edit, "planned", descriptor.id);
    assert.equal(descriptor.capabilities.convertTo, ["claude", "codex"].includes(descriptor.id) ? "supported" : "planned");
    assert.equal(getHistoryDeletionBlockReason(session(descriptor.id)), null);
  }
  assert.equal(getHistoryDeletionBlockReason(session("future-reader")), "unsupported_history_mutation_source");
});

test("read-only and SSH guards precede snapshot and source rules", () => {
  for (const overrides of [
    { read_only: true },
    { session_ref: { transportKind: "ssh" } },
    { favoriteSnapshot: true, read_only: true },
    { favoriteSnapshot: true, session_ref: { transportKind: "ssh" } },
  ]) {
    assert.equal(getHistoryDeletionBlockReason(session("pi", "parent", overrides)), "history_remote_read_only");
  }
  assert.equal(getHistoryDeletionBlockReason(session("future-reader", "snapshot", { favoriteSnapshot: true })), null);
  assert.equal(getHistoryDeletionBlockReason(session("pi", "child", { parent_session_id: "parent" })), "history_subagent_mutation_not_allowed");
  assert.equal(getHistoryDeletionBlockReason(session("claude", "child", { file_path: "C:/history/parent/subagents/agent-child.jsonl" })), "history_subagent_mutation_not_allowed");
  assert.equal(getHistoryDeletionBlockReason(session("claude", "parent", { file_path: "C:/history/parent/subagents/agent-parent.jsonl" })), "history_subagent_mutation_not_allowed");
  assert.equal(getHistoryDeletionBlockReason(session("pi", "child", { parent_session_id: "parent", favoriteSnapshot: true })), null);
});

test("file-only, directory-based, database, and snapshot deletion do not remove independent child rows", () => {
  for (const source of [...fileSources, "grok", "kimi", "opencode"]) {
    const parent = session(source);
    const child = session(source, "child", { parent_session_id: "parent" });
    assert.deepEqual([...historyDeletedSessionKeys(parent, [parent, child])], [parent.sessionKey], source);
  }
  const snapshot = session("claude", "parent", { favoriteSnapshot: true });
  const child = session("claude", "child", { file_path: "C:/history/claude/parent/subagents/agent-child.jsonl" });
  assert.deepEqual([...historyDeletedSessionKeys(snapshot, [snapshot, child])], [snapshot.sessionKey]);
});

test("Claude/Codex remove only actual adjacent subagents, preserving other roots and metadata-only children", () => {
  for (const source of ["claude", "codex"]) {
    const parent = session(source);
    const path = `C:/history/${source}/parent/subagents/agent-child.jsonl`;
    const child = session(source, "child", { file_path: path, parent_session_id: "parent" });
    const preserve = [
      session(source, "fork", { parent_session_id: "parent" }),
      session(source, "other-root", { file_path: `D:${path.slice(2)}`, parent_session_id: "parent" }),
      session(source, "other-project", { file_path: path, project_key: "other" }),
      session(source, "remote", { file_path: path, session_ref: { transportKind: "ssh" } }),
      session(source, "snapshot", { file_path: path, favoriteSnapshot: true }),
      session("pi", "other-source", { file_path: path }),
    ];
    assert.deepEqual([...historyDeletedSessionKeys(parent, [parent, child, ...preserve])], [parent.sessionKey, child.sessionKey]);
  }
});

test("WSL deletion matches host aliases and distro case without merging distinct Linux paths", () => {
  const parent = session("claude", "parent", { file_path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\Parent\\main.jsonl" });
  const child = session("claude", "child", { file_path: "//wsl$/ubuntu/home/dev/Parent/subagents/agent-child.jsonl" });
  const differentCase = session("claude", "other", { file_path: "//wsl$/ubuntu/home/dev/parent/subagents/agent-child.jsonl" });
  assert.deepEqual([...historyDeletedSessionKeys(parent, [parent, child, differentCase])], [parent.sessionKey, child.sessionKey]);
});

test("batch planning merges covered subagents but never silently skips an ineligible selection", () => {
  const parent = session("claude");
  const child = session("claude", "child", { file_path: "C:/history/claude/parent/subagents/agent-child.jsonl" });
  const other = session("gemini", "other");
  assert.deepEqual(planHistoryDeletion([parent, child, other, parent]), {
    sessionKeys: [parent.sessionKey, other.sessionKey], blockedReason: null,
  });
  for (const blocked of [session("future-reader"), session("pi", "remote", { read_only: true }), child]) {
    const planned = planHistoryDeletion([other, blocked]);
    assert.ok(planned.blockedReason);
    assert.deepEqual(planned.sessionKeys, []);
  }
  const fileParent = session("pi");
  const fileChild = session("pi", "child", { parent_session_id: "parent" });
  assert.equal(planHistoryDeletion([fileParent, fileChild]).blockedReason, "history_subagent_mutation_not_allowed");
});

test("mixed-source execution preflights every selection before any deletion", async () => {
  const selected = allSources.map((source) => session(source));
  const calls = [];
  const result = await executeHistoryDeletion(selected.map((item) => item.sessionKey), () => selected, async (key) => calls.push(key));
  assert.equal(result.error, null);
  assert.equal(result.deletedCount, 12);
  assert.deepEqual(calls, selected.map((item) => item.sessionKey));

  for (const invalid of [session("future-reader"), session("pi", "readonly", { read_only: true }), undefined]) {
    const current = [selected[0], ...(invalid ? [invalid] : [])];
    const attempted = [];
    const result = await executeHistoryDeletion([current[0].sessionKey, invalid?.sessionKey ?? "missing"], () => current, async (key) => attempted.push(key));
    assert.equal(result.deletedCount, 0);
    assert.ok(result.error);
    assert.deepEqual(attempted, []);
  }
});

test("I/O failure stops a batch and reports only completed deletions", async () => {
  const selected = [session("pi"), session("cline"), session("copilot")];
  const calls = [];
  const failure = new Error("failedRolledBack: file in use");
  const result = await executeHistoryDeletion(selected.map((item) => item.sessionKey), () => selected, async (key) => {
    calls.push(key);
    if (key === selected[1].sessionKey) throw failure;
  });
  assert.equal(result.deletedCount, 1);
  assert.equal(result.error, failure);
  assert.deepEqual(calls, selected.slice(0, 2).map((item) => item.sessionKey));
});

// 提取真实 Store action 并注入 IPC/数据库边界，避免加载与本次行为无关的 UI 和全局状态。
function storeActionFactory() {
  const source = readFileSync(new URL("../src/features/history/store/historyStore.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("historyStore.ts", source, ts.ScriptTarget.Latest, true);
  const actions = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "deleteSession") actions.push(node.initializer.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(actions.length, 1);
  const output = ts.transpileModule(`const action = ${actions[0]};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("get", "set", "invoke", "getHistoryPathArgs", "getDb", "deleteFavoriteSnapshot", "hitSessionKey", "assertHistorySessionDeletable", "historyDeletedSessionKeys", `${output}\nreturn action;`);
}

const createStoreAction = storeActionFactory();

// 记录真实 action 的边界调用顺序，并允许模拟 IPC 失败。
function storeHarness(sessions, invokeError = null) {
  const events = [];
  const first = sessions[0];
  const state = {
    sessions,
    metaMap: Object.fromEntries(sessions.map((item) => [item.sessionKey, { starred: item.starred }])),
    generatedTitleMap: Object.fromEntries(sessions.map((item) => [item.sessionKey, { title: "generated" }])),
    activeSessionKey: first?.sessionKey ?? null,
    activeSession: first ?? null,
    searchHits: sessions.map((item) => ({ sessionKey: item.sessionKey })),
    focusedMessageIndex: 3,
    openSession: async (key) => {
      events.push(["open", key]);
      state.activeSession = state.sessions.find((item) => item.sessionKey === key);
    },
  };
  const action = createStoreAction(
    () => state,
    (patch) => Object.assign(state, patch),
    async (command, args) => {
      events.push(["invoke", command, args]);
      if (invokeError) throw invokeError;
    },
    async () => ({ claudeConfigDir: "C:/fixture/.claude" }),
    async () => ({ execute: async (query, args) => events.push(["sql", query, args]) }),
    async (key) => events.push(["snapshot", key]),
    (hit) => hit.sessionKey,
    assertHistorySessionDeletable,
    historyDeletedSessionKeys,
  );
  return { state, events, action };
}

test("Store removes only the deleted source row and metadata after successful IPC", async () => {
  for (const source of fileSources) {
    const target = session(source, "parent", { starred: true });
    const child = session(source, "child", { parent_session_id: "parent" });
    const other = session(source, "other");
    const { state, events, action } = storeHarness([target, child, other]);
    await action(target.sessionKey);
    assert.deepEqual(events[0], ["invoke", "history_delete_session", {
      filePath: target.file_path, claudeConfigDir: "C:/fixture/.claude", source, projectKey: "project",
    }]);
    assert.deepEqual(state.sessions, [child, other]);
    assert.equal(state.metaMap[target.sessionKey], undefined);
    assert.equal(state.generatedTitleMap[target.sessionKey], undefined);
    assert.ok(state.metaMap[child.sessionKey]);
    assert.ok(state.generatedTitleMap[child.sessionKey]);
    assert.equal(state.activeSessionKey, child.sessionKey);
    assert.equal(state.activeSession, child);
    assert.deepEqual(state.searchHits, [child, other].map((item) => ({ sessionKey: item.sessionKey })));
    assert.deepEqual(events.filter(([kind]) => kind === "sql").map((event) => event[2]), [[target.sessionKey], [target.sessionKey]]);
    assert.deepEqual(events.filter(([kind]) => kind === "snapshot"), [["snapshot", target.sessionKey]]);
  }
});

test("Store keeps all local state when backend deletion fails", async () => {
  const target = session("pi");
  const other = session("cline");
  const error = new Error("failedRolledBack: denied");
  const { state, events, action } = storeHarness([target, other], error);
  await assert.rejects(action(target.sessionKey), (received) => received === error);
  assert.deepEqual(state.sessions, [target, other]);
  assert.equal(state.activeSession, target);
  assert.equal(state.searchHits.length, 2);
  assert.ok(state.metaMap[target.sessionKey]);
  assert.ok(state.generatedTitleMap[target.sessionKey]);
  assert.deepEqual(events.map(([kind]) => kind), ["invoke"]);
});

test("Store enforces guards on direct calls and does not miscount missing sessions", async () => {
  for (const target of [session("future-reader"), session("pi", "child", { parent_session_id: "parent" }), session("pi", "remote", { read_only: true })]) {
    const { events, action } = storeHarness([target]);
    await assert.rejects(action(target.sessionKey));
    assert.deepEqual(events, []);
  }
  const { events, action } = storeHarness([]);
  await assert.rejects(action("missing"), /history_session_not_found/);
  assert.deepEqual(events, []);
});

test("snapshot deletion bypasses IPC and never cascades to original-source children", async () => {
  const snapshot = session("future-reader", "snapshot", { favoriteSnapshot: true });
  const other = session("pi");
  const { state, events, action } = storeHarness([snapshot, other]);
  await action(snapshot.sessionKey);
  assert.deepEqual(state.sessions, [other]);
  assert.ok(events.some(([kind]) => kind === "snapshot"));
  assert.ok(events.every(([kind]) => kind !== "invoke"));
});

test("deletion errors expose matching Chinese and English messages", () => {
  for (const code of [
    "history_remote_read_only", "unsupported_history_mutation_source", "history_subagent_mutation_not_allowed",
    "history_session_not_found", "history_source_manual_recovery_required",
  ]) {
    const key = historyDeletionErrorKey(new Error(code));
    assert.ok(key);
    assert.ok(zh[key]);
    assert.ok(en[key]);
    assert.notEqual(zh[key], en[key]);
  }
  assert.equal(historyDeletionErrorKey("failedRolledBack: denied"), null);
});
