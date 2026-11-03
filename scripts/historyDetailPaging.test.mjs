import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
function load(path, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast)).join("\n");
  const exports = {};
  runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, ...globals });
  return exports;
}
const normalization = load("../src/features/history/lib/historyNormalization.ts");
const paging = load("../src/features/history/lib/historyDetailPaging.ts", { normalizeDetail: normalization.normalizeDetail });
const sorting = load("../src/shared/lib/historySort.ts");
const page = (offset, revision = "rev-1") => ({ offset, revision, complete: false, detail: {
  session_id: "synthetic", source: "claude", project_key: "proj", file_path: "/synthetic", message_count: 4,
  messages: [0, 1].map(n => ({ role: "user", content: `message-${n + offset}`, line_index: n + offset + 50, editable: true })),
} });
test("real normalization and append retain original message and JSONL anchors", () => {
  const first = paging.normalizeHistoryPage(page(0));
  const combined = paging.appendHistoryPage(first, paging.normalizeHistoryPage(page(2)), 2);
  const entries = sorting.buildVisibleHistoryMessageEntries(combined.messages, 4, "descending");
  assert.deepEqual(Array.from(entries, e => [e.messageIndex, e.message.line_index]), [[3, 53], [2, 52], [1, 51], [0, 50]]);
  assert.equal(combined.message_count, 4);
  assert.equal(combined.messages[2].editable, true);
});
test("changed revision, skipped offsets and cross-session pages are rejected", () => {
  const first = paging.normalizeHistoryPage(page(0));
  assert.throws(() => paging.appendHistoryPage(first, paging.normalizeHistoryPage(page(2, "changed")), 2), /page_changed/);
  assert.throws(() => paging.appendHistoryPage(first, paging.normalizeHistoryPage(page(2)), 3), /page_changed/);
  const other = page(2); other.detail.file_path = "/other";
  assert.throws(() => paging.appendHistoryPage(first, paging.normalizeHistoryPage(other), 2), /page_changed/);
});
test("live, remote and favorite full-detail adapters remain explicit complete details", () => {
  const full = page(0); full.complete = true;
  assert.equal(paging.normalizeHistoryPage(full).message_page, undefined);
  assert.throws(() => paging.normalizeHistoryPage({ ...full, offset: -1 }), /page_invalid/);
});
test("prompt jumps beyond the loaded page complete the session before focusing", () => {
  const store = readFileSync(new URL("../src/features/history/store/historyStore.ts", import.meta.url), "utf8");
  assert.match(store, /openSessionAtMessage: async \(sessionKey, messageIndex\) => \{[\s\S]*?message_page[\s\S]*?normalizedIndex >= loaded\.messages\.length[\s\S]*?await get\(\)\.ensureCompleteSession\(\);[\s\S]*?focusedMessageIndex: normalizedIndex/);
});
