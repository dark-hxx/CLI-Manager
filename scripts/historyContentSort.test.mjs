import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 按测试文件相对路径读取源码供静态契约断言使用。
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sortSource = read("../src/shared/lib/historySort.ts");
const settingsSource = read("../src/shared/preferences/settingsStore.ts");
const workspaceSource = read("../src/features/history/api/HistoryWorkspace.tsx");
const detailSource = read("../src/features/history/components/SessionDetailPane.tsx");
const timelineSource = read("../src/features/history/components/SessionTimelineView.tsx");
const changesSource = read("../src/features/history/components/SessionFileChangesView.tsx");
const toolsSource = read("../src/features/history/components/SessionToolDiagnosticsView.tsx");
const subtasksSource = read("../src/features/history/components/SessionSubtaskTreeView.tsx");
const historySource = [
  read("../src-tauri/src/features/history/scan_state.rs"),
  read("../src-tauri/src/features/history/roots.rs"),
].join("\n");
const catalogSource = read("../src-tauri/src/features/history/catalog.rs");
const sshHistorySource = read("../src-tauri/ssh-agent/src/history.rs");
const titleSource = read("../src/features/history/lib/historyTitle.ts");

// 验证排序仅覆盖六类历史详情视图，不影响画布和上下文。
test("history detail sorting keeps six views and excludes canvas/context", () => {
  assert.match(sortSource, /"conversation",\s*"transcript",\s*"timeline",\s*"changes",\s*"tools",\s*"subtasks"/s);
  assert.match(detailSource, /isHistorySortableDetailView\(detailView\)/);
  assert.match(detailSource, /direction=\{sortDirection\}/);
  assert.equal((detailSource.match(/direction=\{sortDirection\}/g) ?? []).length, 4);
  const canvasStart = detailSource.indexOf("<SessionCanvasView");
  const canvasEnd = detailSource.indexOf("/>", canvasStart);
  assert.notEqual(canvasStart, -1);
  assert.notEqual(canvasEnd, -1);
  assert.doesNotMatch(detailSource.slice(canvasStart, canvasEnd), /direction=\{sortDirection\}/);
});

// 验证倒序转录从尾部展示并保留原始消息索引。
test("descending transcript starts at the tail and preserves raw message indexes", () => {
  assert.match(sortSource, /const firstIndex = direction === "descending" \? total - count : 0/);
  assert.match(sortSource, /for \(let messageIndex = lastIndex - 1; messageIndex >= firstIndex; messageIndex -= 1\)/);
  assert.match(sortSource, /entries\.push\(\{ message: messages\[messageIndex\], messageIndex \}\)/);
  assert.match(workspaceSource, /buildVisibleHistoryMessageEntries\(/);
  assert.match(workspaceSource, /index >= total - visibleMessageCount/);
  assert.match(detailSource, /index=\{messageIndex\}/);
  assert.match(detailSource, /selectedMessageIndices\.has\(messageIndex\)/);
});

// 验证排序偏好迁移及持久化写入使用串行队列。
test("sort preferences are migrated and persisted through a serialized write queue", () => {
  assert.match(settingsSource, /historyDetailSortDirections: HistoryDetailSortDirections/);
  assert.match(settingsSource, /migrateHistoryDetailSortDirections/);
  assert.match(settingsSource, /historyDetailSortWriteQueue = historyDetailSortWriteQueue/);
  assert.match(settingsSource, /await s\.set\("historyDetailSortDirections", next\)/);
  assert.match(workspaceSource, /updateHistoryDetailSortDirections\(\{/);
});

// 验证结构化视图筛选后再排序且不改变聚合统计。
test("structured views reverse after filtering and preserve aggregate statistics", () => {
  assert.match(timelineSource, /sortHistoryItems\(model\.events\.filter/);
  assert.match(changesSource, /sortHistoryItems\(/);
  assert.match(toolsSource, /const orderedToolEvents = sortHistoryItems\(toolEvents, direction\)/);
  assert.match(toolsSource, /const orderedSuspectedEvents = sortHistoryItems\(model\.toolEvents, direction\)\.slice/);
  assert.match(subtasksSource, /sortHistoryItems\(model\.subtaskEvents, direction\)/);
});

// 验证本地与 SSH Codex 标题索引具备大小边界和指纹更新契约。
test("Codex thread names are bounded, fingerprinted, and applied locally and over SSH", () => {
  assert.match(historySource, /CODEX_THREAD_NAME_INDEX_MAX_BYTES/);
  assert.match(historySource, /parse_codex_thread_name_index/);
  assert.match(historySource, /apply_codex_thread_name/);
  assert.match(catalogSource, /codex_thread_name_fingerprint/);
  assert.match(catalogSource, /codex_thread_name_changed/);
  assert.match(sshHistorySource, /codex_thread_name_fingerprint/);
  assert.match(sshHistorySource, /parse_codex_thread_name_index/);
  assert.match(sshHistorySource, /apply_codex_thread_name/);
});

// 验证共享标题解析器保持 AI 标题优先于 Codex 线程名称。
test("AI titles remain ahead of Codex thread names in the shared display resolver", () => {
  assert.match(
    titleSource,
    /return alias\?\.trim\(\) \|\| generatedTitle\?\.trim\(\) \|\| sourceTitle\?\.trim\(\) \|\| sessionId\.trim\(\)/,
  );
});
