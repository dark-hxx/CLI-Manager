import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import ts from "typescript";

// 真实模块在内存中编译；只替换模块地址，不写夹具文件或用户历史。
function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
}

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
}

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sourcesUrl = moduleUrl(read("src/shared/lib/historySources.ts"));
const subagentsUrl = moduleUrl(read("src/features/history/lib/historySubagents.ts"));
const policy = await import(moduleUrl(read("src/features/history/lib/historyDeletion.ts")
  .replaceAll('"../../../shared/lib/historySources"', JSON.stringify(sourcesUrl))
  .replaceAll('"./historySubagents"', JSON.stringify(subagentsUrl))));
const { executeHistoryDeletion, assertHistorySessionDeletable, historyDeletionErrorKey } = policy;
const { zh } = await import(moduleUrl(read("src/shared/i18n/messages/history.zh-CN.ts")));
const { en } = await import(moduleUrl(read("src/shared/i18n/messages/history.en-US.ts")));

// 提取生产 action/闭包，而不是重新实现待测逻辑；其余 UI/IPC 仅注入边界。
function extract(path, name, predicate) {
  const source = read(path);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  function visit(node) {
    if (predicate(node) && node.name?.getText(ast) === name) matches.push(node.initializer.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, name);
  return matches[0];
}

function bindExpression(expression, bindings) {
  return new Function(...Object.keys(bindings), compile(`return ${expression};`))(...Object.values(bindings));
}

const actionSource = extract("src/features/history/store/historyStore.ts", "deleteSessions", ts.isPropertyAssignment);
const singleActionSource = extract("src/features/history/store/historyStore.ts", "deleteSession", ts.isPropertyAssignment);

// Exercise the actual source-delete -> metadata -> next-detail chain, not a fake delete action.
function completedDeleteHarness(nextDetail) {
  const h = harness(["a", "b", "c"]);
  const sql = [], warnings = [];
  Object.assign(h.state, {
    metaMap: {}, generatedTitleMap: {}, searchHits: [],
    activeSessionKey: "a", activeSession: h.state.sessions[0],
    openSession: nextDetail,
  });
  h.state.deleteSession = bindExpression(singleActionSource, {
    get: () => h.state, set: patch => Object.assign(h.state, patch),
    invoke: async () => { h.calls.push("source-deleted"); return ["C:/fixture/a.jsonl"]; },
    getHistoryPathArgs: async () => ({}),
    getDb: async () => ({ execute: async statement => sql.push(statement) }),
    deleteFavoriteSnapshot: async () => {}, hitSessionKey: hit => hit.sessionKey,
    assertHistorySessionDeletable, historyDeletedSessionKeys: policy.historyDeletedSessionKeys,
    logWarn: (name, data) => warnings.push({ name, data }),
  });
  return { ...h, sql, warnings };
}

test("completed source deletion closes confirmation and releases lock without waiting for next detail", async () => {
  const detail = deferred();
  const h = completedDeleteHarness(() => detail.promise);
  const ui = confirmation(h, { type: "single", session: h.state.sessions[0] });
  ui.confirm();
  await ui.done;
  assert.deepEqual(h.calls, ["source-deleted"]);
  assert.equal(h.state.deletingSessions, false);
  assert.equal(ui.currentIntent(), null);
  assert.equal(ui.events[0].type, "success");
  assert.equal(h.state.activeSessionKey, "b");
  assert.ok(!h.state.sessions.some(row => row.sessionKey === "a"));
  detail.resolve();
});

test("a failed next detail cannot turn a committed delete into an error or zero completed count", async () => {
  const h = completedDeleteHarness(async () => { throw new Error("next_detail_failed"); });
  const outcome = await h.action(["a"]);
  await Promise.resolve();
  assert.deepEqual(outcome, { deletedCount: 1, error: null });
  assert.equal(h.state.deletingSessions, false);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0].name, "history.delete.nextSessionLoadFailed");
  assert.equal(h.sql.length, 2);
});

test("deleting an inactive or last session does not request unrelated detail", async () => {
  let opens = 0;
  const h = completedDeleteHarness(async () => { opens++; });
  h.state.activeSessionKey = "b";
  assert.deepEqual(await h.action(["a"]), { deletedCount: 1, error: null });
  assert.equal(opens, 0);
  const last = completedDeleteHarness(async () => { opens++; });
  last.state.sessions = last.state.sessions.slice(0, 1);
  assert.deepEqual(await last.action(["a"]), { deletedCount: 1, error: null });
  assert.equal(last.state.activeSessionKey, null);
  assert.equal(opens, 0);
});

test("dirty foreground details bypass the catalog and schedule only a non-waiting background refresh", () => {
  const source = read("src-tauri/src/features/history/mod.rs");
  const command = source.slice(source.indexOf("pub async fn history_get_session("), source.indexOf("pub async fn history_delete_session("));
  const detail = command.slice(0, command.indexOf("pub async fn ", 15));
  assert.match(detail, /let catalog_dirty = catalog::is_dirty\(\)/);
  assert.match(detail, /tauri::async_runtime::spawn\(async move/);
  assert.match(detail, /ensure_refresh\(refresh_app, refresh_roots, false, false\)/);
  assert.match(detail, /if !catalog_dirty \|\| source_normalized == "opencode"/);
  assert.doesNotMatch(detail, /ensure_refresh\([^\n]*false, true/);
});

// promise 屏障精确控制第二条删除暂停点，不依赖计时器或真实磁盘速度。
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(keys = ["a", "b", "c"], behavior = async key => [key], executor = executeHistoryDeletion) {
  const calls = [];
  const state = {
    deletingSessions: false,
    sessions: keys.map(sessionKey => ({
      sessionKey, source: "codex", project_key: "fixture", file_path: `C:/fixture/${sessionKey}.jsonl`,
    })),
    deleteSession: async key => {
      assertHistorySessionDeletable(state.sessions.find(row => row.sessionKey === key));
      calls.push(key);
      const covered = await behavior(key);
      state.sessions = state.sessions.filter(row => !covered.includes(row.sessionKey));
      return covered;
    },
  };
  const action = bindExpression(actionSource, {
    get: () => state,
    set: patch => Object.assign(state, patch),
    executeHistoryDeletion: executor,
  });
  return { state, calls, action };
}

function workspaceCallback(name, bindings) {
  return bindExpression(extract("src/features/history/api/HistoryWorkspace.tsx", name, ts.isVariableDeclaration), {
    useCallback: callback => callback,
    ...bindings,
  });
}

// 记录真实确认回调的唯一最终通知；不同回调实例共用同一个 Store。
function confirmation(h, intent = { type: "bulk", sessionKeys: ["a", "b", "c"] }) {
  const done = deferred();
  const events = [];
  const warnings = [];
  let currentIntent = intent;
  const setDeleteIntent = value => { currentIntent = value; };
  const bindings = {
    deleteIntent: intent,
    deleteSessions: h.action,
    useHistoryStore: { getState: () => h.state },
    historyDeletionErrorKey,
    logWarn: (name, data) => warnings.push({ name, data }),
    t: (key, data) => ({ key, data }),
    toast: {
      error: (title, options) => { events.push({ type: "error", title, options }); done.resolve(); },
      success: title => { events.push({ type: "success", title }); done.resolve(); },
    },
    setSelectionMode: () => {},
    setSelectedSessionKeys: () => {},
    setDeleteIntent,
  };
  return {
    confirm: workspaceCallback("confirmDeleteSession", bindings),
    close: workspaceCallback("closeDeleteDialog", bindings),
    done: done.promise, events, warnings, currentIntent: () => currentIntent,
  };
}

test("original duplicate-confirm repro now runs one queue and emits only one success", async () => {
  const paused = deferred();
  const started = deferred();
  const h = harness(["a", "b", "c"], async key => {
    if (key === "b") { started.resolve(); await paused.promise; }
    return [key];
  });
  const ui = confirmation(h);
  ui.confirm();
  await started.promise;
  assert.equal(h.state.deletingSessions, true);
  assert.deepEqual(h.state.sessions.map(row => row.sessionKey), ["b", "c"]);
  for (let index = 0; index < 20; index += 1) ui.confirm();
  ui.close();
  assert.ok(ui.currentIntent(), "pending dialog cannot pretend to cancel an ongoing mutation");
  assert.deepEqual(ui.events, []);
  assert.deepEqual(ui.warnings, []);
  paused.resolve();
  await ui.done;
  assert.deepEqual(h.calls, ["a", "b", "c"]);
  assert.equal(h.state.sessions.length, 0);
  assert.equal(h.state.deletingSessions, false);
  assert.equal(ui.currentIntent(), null);
  assert.deepEqual(ui.events, [{ type: "success", title: { key: "history.toast.bulkDeleteSuccess", data: { count: 3 } } }]);
});

test("Store lock covers same-turn calls, mixed single/bulk and a newly mounted callback", async () => {
  const paused = deferred();
  const h = harness(["a", "b", "c"], async key => { await paused.promise; return [key]; });
  const first = h.action(["a", "b"]);
  assert.equal(h.state.deletingSessions, true, "lock acquired before first await");
  assert.equal(await h.action(["a"]), null);
  assert.equal(await h.action(["c"]), null, "no overlapping queue, even with non-overlapping keys");
  const remounted = confirmation(h, { type: "single", session: { sessionKey: "a" } });
  remounted.confirm();
  assert.deepEqual(remounted.events, []);
  assert.deepEqual(h.calls, ["a"]);
  paused.resolve();
  assert.deepEqual(await first, { deletedCount: 2, error: null });
  assert.deepEqual(await h.action(["c"]), { deletedCount: 1, error: null });
});

test("single confirmation has the same duplicate protection as bulk", async () => {
  const paused = deferred();
  const h = harness(["a"], async key => { await paused.promise; return [key]; });
  const ui = confirmation(h, { type: "single", session: { sessionKey: "a" } });
  ui.confirm();
  ui.confirm();
  assert.deepEqual(h.calls, ["a"]);
  paused.resolve();
  await ui.done;
  assert.equal(ui.events.length, 1);
  assert.equal(ui.events[0].title.key, "history.toast.deleteSuccess");
});

test("real failure stops the queue, logs once, releases lock and permits retry", async () => {
  let fail = true;
  const failure = new Error("failedRolledBack: file in use");
  const h = harness(["a", "b", "c"], async key => {
    if (key === "b" && fail) throw failure;
    return [key];
  });
  const ui = confirmation(h);
  ui.confirm();
  await ui.done;
  assert.deepEqual(h.calls, ["a", "b"]);
  assert.deepEqual(h.state.sessions.map(row => row.sessionKey), ["b", "c"]);
  assert.equal(h.state.deletingSessions, false);
  assert.equal(ui.events.length, 1);
  assert.equal(ui.events[0].title.key, "history.toast.bulkDeletePartialFailed");
  assert.deepEqual(ui.events[0].title.data, { deleted: 1, total: 3 });
  assert.deepEqual(ui.warnings, [{ name: "history.delete.failed", data: {
    mode: "bulk", selectedCount: 3, deletedCount: 1, error: String(failure),
  } }]);
  fail = false;
  assert.deepEqual(await h.action(["b", "c"]), { deletedCount: 2, error: null });
});

test("genuine missing sessions are still errors; unexpected rejection also releases the lock", async () => {
  const h = harness(["a"]);
  const result = await h.action(["missing"]);
  assert.equal(result.deletedCount, 0);
  assert.match(String(result.error), /history_session_not_found/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.state.deletingSessions, false);
  const failure = new Error("unexpected executor failure");
  const unexpected = harness(["a"], undefined, async () => { throw failure; });
  await assert.rejects(unexpected.action(["a"]), error => error === failure);
  assert.equal(unexpected.state.deletingSessions, false);
});

test("batch keys are snapshotted and authoritative parent coverage is retained", async () => {
  const paused = deferred();
  const h = harness(["parent", "child", "fork"], async key => {
    await paused.promise;
    return key === "parent" ? ["parent", "child"] : [key];
  });
  const keys = ["parent", "child", "fork"];
  const pending = h.action(keys);
  keys.splice(0, keys.length, "missing");
  paused.resolve();
  assert.deepEqual(await pending, { deletedCount: 3, error: null });
  assert.deepEqual(h.calls, ["parent", "fork"]);
});

test("new delete requests cannot replace an in-flight intent; pre-start cancel still works", () => {
  const h = harness();
  const intents = [];
  const bindings = {
    useHistoryStore: { getState: () => h.state },
    getHistoryDeletionBlockReason: policy.getHistoryDeletionBlockReason,
    historyDeletionErrorKey,
    setDeleteIntent: intent => intents.push(intent),
    selectedDeletionPlan: { blockedReason: null, sessionKeys: ["a", "b"] },
    t: key => key,
    toast: { info: () => assert.fail("valid local input must not fail policy") },
  };
  const single = workspaceCallback("handleRequestDelete", bindings);
  const bulk = workspaceCallback("handleRequestBulkDelete", bindings);
  h.state.deletingSessions = true;
  single(h.state.sessions[0]);
  bulk();
  assert.deepEqual(intents, []);
  h.state.deletingSessions = false;
  single(h.state.sessions[0]);
  bulk();
  assert.equal(intents.length, 2);
  const ui = confirmation(h);
  ui.close();
  assert.equal(ui.currentIntent(), null);
});

// 执行真实 JSX 函数，只模拟 React hook 与 primitive；检查生产事件和原生 disabled。
const dialogSource = read("src/shared/ui/ConfirmDialog.tsx");
const dialogCode = dialogSource.slice(dialogSource.indexOf("export function ConfirmDialog"));
const ConfirmDialog = new Function("React", "useRef", "Dialog", "DialogContent", "DialogTitle",
  "DialogDescription", "DialogFooter", "Button", "cn",
  `${compile(dialogCode.replace(/^export /, ""))}\nreturn ConfirmDialog;`)(
  { createElement }, () => ({ current: null }), "Dialog", "DialogContent", "DialogTitle", "DialogDescription",
  "DialogFooter", "Button", (...parts) => parts.filter(Boolean).join(" "),
);

function findElements(element, type) {
  if (!element || typeof element !== "object") return [];
  const children = [element.props?.children].flat(Infinity);
  return [...(element.type === type ? [element] : []), ...children.flatMap(child => findElements(child, type))];
}

test("pending dialog disables both actions and prevents Escape/outside/open-change dismissal", () => {
  let closed = 0;
  const dialog = ConfirmDialog({ open: true, pending: true, onConfirm: () => {}, onClose: () => { closed += 1; } });
  const content = findElements(dialog, "DialogContent")[0];
  assert.equal(content.props["aria-busy"], true);
  assert.deepEqual(findElements(dialog, "Button").map(button => button.props.disabled), [true, true]);
  let prevented = 0;
  content.props.onEscapeKeyDown({ preventDefault: () => { prevented += 1; } });
  content.props.onInteractOutside({ preventDefault: () => { prevented += 1; } });
  dialog.props.onOpenChange(false);
  assert.equal(prevented, 2);
  assert.equal(closed, 0);
});

test("shared dialog default and explicit-close-only behavior remain compatible; pending copy is bilingual", () => {
  let closed = 0;
  let confirmed = 0;
  const props = { open: true, onConfirm: () => { confirmed += 1; }, onClose: () => { closed += 1; } };
  const dialog = ConfirmDialog(props);
  const content = findElements(dialog, "DialogContent")[0];
  assert.equal(content.props["aria-busy"], undefined);
  assert.equal(content.props.onEscapeKeyDown, undefined);
  assert.equal(content.props.onInteractOutside, undefined);
  const buttons = findElements(dialog, "Button");
  assert.deepEqual(buttons.map(button => button.props.disabled), [false, false]);
  buttons[1].props.onClick();
  dialog.props.onOpenChange(false);
  assert.equal(confirmed, 1);
  assert.equal(closed, 1);
  const explicit = findElements(ConfirmDialog({ ...props, explicitCloseOnly: true }), "DialogContent")[0];
  assert.equal(typeof explicit.props.onEscapeKeyDown, "function");
  assert.equal(typeof explicit.props.onInteractOutside, "function");
  assert.equal(zh["history.delete.inProgress"], "正在删除…");
  assert.equal(en["history.delete.inProgress"], "Deleting…");
});

test("production Workspace and all three list deletion controls consume the Store pending state", () => {
  const workspace = read("src/features/history/api/HistoryWorkspace.tsx");
  assert.match(workspace, /const deletingSessions = useHistoryStore\(\(s\) => s\.deletingSessions\)/);
  assert.match(workspace, /deletingSessions=\{deletingSessions\}/);
  assert.match(workspace, /pending=\{deletingSessions\}/);
  const list = read("src/features/history/components/HistoryListPane.tsx");
  const ast = ts.createSourceFile("HistoryListPane.tsx", list, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const disabled = [];
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === "disabled"
      && node.initializer?.getText(ast).includes("deletingSessions")) disabled.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(disabled.length, 3, "bulk button, row delete and context menu all disabled while deleting");
});
