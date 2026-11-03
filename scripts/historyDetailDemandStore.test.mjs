import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
function load(path, globals = {}) {
  const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast)).join("\n");
  const exports = {};
  runInNewContext(compile(body), { exports, ...globals });
  return exports;
}
const normalization = load("../src/features/history/lib/historyNormalization.ts");
const paging = load("../src/features/history/lib/historyDetailPaging.ts", { normalizeDetail: normalization.normalizeDetail });
const identity = load("../src/features/history/lib/historySessionIdentity.ts");
const storeAst = ts.createSourceFile("store.ts", read("../src/features/history/store/historyStore.ts"), ts.ScriptTarget.Latest, true);
const methods = new Map();
function visit(node) {
  if (ts.isPropertyAssignment(node) && ["openSession", "loadMoreMessages", "ensureCompleteSession"].includes(node.name.getText(storeAst))) {
    methods.set(node.name.getText(storeAst), node.initializer.getText(storeAst));
  }
  ts.forEachChild(node, visit);
}
visit(storeAst);
const snapshotFunction = storeAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "loadDetailForSnapshot").getText(storeAst);
const detail = (id = "A", offset = 0, count = 2) => ({ session_id: id, source: "claude", project_key: "proj", file_path: `/synthetic/${id}`,
  message_count: 4, messages: Array.from({ length: count }, (_, n) => ({ role: "user", content: `m${offset + n}`, line_index: 50 + offset + n })) });
const page = (id = "A", offset = 0) => ({ detail: detail(id, offset), offset, revision: `${id}:rev`, complete: false });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function harness(invoke) {
  const state = { sessions: ["A", "B"].map(id => ({ ...detail(id), sessionKey: id })), activeSession: null,
    activeSessionKey: null, loadingSessionDetail: false, loadingMoreMessages: false };
  const exports = {};
  runInNewContext(compile(`let sessionDetailRequestSeq = 0; ${snapshotFunction}
    Object.assign(state, {${[...methods].map(([key, value]) => `${key}: ${value}`).join(",")}});`), {
    exports, state, Object, invoke, ...normalization, ...paging, ...identity,
    get: () => state, set: patch => Object.assign(state, patch), useHistoryStore: { getState: () => state },
    getHistoryPathArgs: async () => ({}), createPerfMarker: () => () => {}, queueAutomaticTitle: () => {},
    readFavoriteSnapshotDetail: async () => null, logWarn: () => {},
  });
  return { state, ...exports };
}
test("ordinary selection pages, next page appends, complete operations load full details", async () => {
  const calls = [];
  const h = harness(async (command, args) => {
    calls.push(command);
    return command === "history_get_session_page" ? page("A", args.offset ?? 0) : detail("A", 0, 4);
  });
  await h.state.openSession("A");
  assert.equal(h.state.activeSession.messages.length, 2);
  await h.state.loadMoreMessages();
  assert.equal(h.state.activeSession.messages[3].line_index, 53);
  const snapshot = await h.loadDetailForSnapshot("A", h.state.sessions[0]);
  assert.equal(snapshot.messages.length, 4, "favorites never persist a partial transcript");
  await h.state.ensureCompleteSession();
  assert.equal(h.state.activeSession.message_page, undefined);
  assert.equal(calls[0], "history_get_session_page");
  assert.equal(h.state.loadingSessionDetail, false);
});
test("single-flight page reads and late selection results cannot replace another session", async () => {
  const pending = deferred(); let pages = 0;
  const h = harness(async (_, args) => {
    if (args.offset) { pages++; return pending.promise; }
    return page(args.filePath.endsWith("B") ? "B" : "A");
  });
  await h.state.openSession("A");
  const first = h.state.loadMoreMessages();
  await h.state.loadMoreMessages();
  await h.state.openSession("B");
  pending.resolve(page("A", 2));
  await first;
  assert.equal(pages, 1);
  assert.equal(h.state.activeSession.session_id, "B");
  assert.equal(h.state.loadingMoreMessages, false);
});
test("failed page reads retain loaded messages and allow a successful retry", async () => {
  let fail = true;
  const h = harness(async (_, args) => {
    if (!args.offset) return page();
    if (fail) throw new Error("synthetic_read_failure");
    return page("A", 2);
  });
  await h.state.openSession("A");
  await assert.rejects(h.state.loadMoreMessages(), /synthetic_read_failure/);
  assert.equal(h.state.activeSession.messages.length, 2);
  assert.equal(h.state.loadingMoreMessages, false);
  fail = false;
  await h.state.loadMoreMessages();
  assert.equal(h.state.activeSession.messages.length, 4);
});
