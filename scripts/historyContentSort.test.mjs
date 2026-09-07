import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sortSource = read("../src/lib/historySort.ts");
const settingsSource = read("../src/stores/settingsStore.ts");
const workspaceSource = read("../src/components/HistoryWorkspace.tsx");
const detailSource = read("../src/components/history/SessionDetailPane.tsx");
const timelineSource = read("../src/components/history/SessionTimelineView.tsx");
const changesSource = read("../src/components/history/SessionFileChangesView.tsx");
const toolsSource = read("../src/components/history/SessionToolDiagnosticsView.tsx");
const subtasksSource = read("../src/components/history/SessionSubtaskTreeView.tsx");
const historySource = read("../src-tauri/src/commands/history.rs");
const catalogSource = read("../src-tauri/src/commands/history/catalog.rs");
const sshHistorySource = read("../src-tauri/ssh-agent/src/history.rs");
const titleSource = read("../src/lib/historyTitle.ts");

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

test("descending transcript starts at the tail and preserves raw message indexes", () => {
  assert.match(sortSource, /const firstIndex = direction === "descending" \? total - count : 0/);
  assert.match(sortSource, /for \(let messageIndex = lastIndex - 1; messageIndex >= firstIndex; messageIndex -= 1\)/);
  assert.match(sortSource, /entries\.push\(\{ message: messages\[messageIndex\], messageIndex \}\)/);
  assert.match(workspaceSource, /buildVisibleHistoryMessageEntries\(/);
  assert.match(workspaceSource, /index >= total - visibleMessageCount/);
  assert.match(detailSource, /index=\{messageIndex\}/);
  assert.match(detailSource, /selectedMessageIndices\.has\(messageIndex\)/);
});

test("sort preferences are migrated and persisted through a serialized write queue", () => {
  assert.match(settingsSource, /historyDetailSortDirections: HistoryDetailSortDirections/);
  assert.match(settingsSource, /migrateHistoryDetailSortDirections/);
  assert.match(settingsSource, /historyDetailSortWriteQueue = historyDetailSortWriteQueue/);
  assert.match(settingsSource, /await s\.set\("historyDetailSortDirections", next\)/);
  assert.match(workspaceSource, /updateHistoryDetailSortDirections\(\{/);
});

test("structured views reverse after filtering and preserve aggregate statistics", () => {
  assert.match(timelineSource, /sortHistoryItems\(model\.events\.filter/);
  assert.match(changesSource, /sortHistoryItems\(/);
  assert.match(toolsSource, /const orderedToolEvents = sortHistoryItems\(toolEvents, direction\)/);
  assert.match(toolsSource, /const orderedSuspectedEvents = sortHistoryItems\(model\.toolEvents, direction\)\.slice/);
  assert.match(subtasksSource, /sortHistoryItems\(model\.subtaskEvents, direction\)/);
});

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

test("AI titles remain ahead of Codex thread names in the shared display resolver", () => {
  assert.match(
    titleSource,
    /return alias\?\.trim\(\) \|\| generatedTitle\?\.trim\(\) \|\| sourceTitle\?\.trim\(\) \|\| sessionId\.trim\(\)/,
  );
});
