import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storeSource = readFileSync(
  new URL("../src/features/history/store/historyStore.ts", import.meta.url),
  "utf8"
);
const workspaceSource = readFileSync(
  new URL("../src/features/history/api/HistoryWorkspace.tsx", import.meta.url),
  "utf8"
);
const historySource = readFileSync(
  new URL("../src-tauri/src/features/history/conversion.rs", import.meta.url),
  "utf8"
);
const backupSource = readFileSync(
  new URL("../src-tauri/src/features/history/backup.rs", import.meta.url),
  "utf8"
);

// 断言起止标记存在并提取两者之间的源码片段。
function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

// 验证自动与手动历史刷新均保持已有列表挂载。
test("automatic and manual history refreshes keep the rendered list mounted", () => {
  const listener = sourceBlock(storeSource, "function ensureHistoryIndexListener", "const automaticTitleQueueKeys");
  const refresh = sourceBlock(storeSource, "refreshIndex: async", "addConvertedSession: ");

  assert.match(listener, /loadSessions\(\{ background: true \}\)/);
  assert.equal(refresh.match(/loadSessions\(\{ background: true \}\)/g)?.length, 2);
});

// 验证后台刷新保留已加载范围且不进入阻塞加载状态。
test("background refresh preserves the loaded range without entering the blocking state", () => {
  const loadSessions = sourceBlock(storeSource, "loadSessions: async", "loadMoreSessions: async");

  assert.match(loadSessions, /options\?\.background === true && get\(\)\.sessions\.length > 0/);
  assert.match(loadSessions, /Math\.max\(SESSION_PAGE_SIZE, get\(\)\.sessionListOffset\)/);
  assert.match(loadSessions, /const fetchLimit = sessionLimit \+ 1/);
  assert.match(loadSessions, /if \(background\) \{\s*set\(\{ loadingSessions: false, loadingMoreSessions: false \}\);\s*\} else \{\s*set\(\{ loadingSessions: true/);
  assert.match(loadSessions, /hasMoreSessions: allSummaries\.length > sessionLimit/);
});

// 验证刷新加载状态不再重置可见会话数量。
test("refresh loading no longer resets the visible session count", () => {
  const resetEffect = sourceBlock(
    workspaceSource,
    "setVisibleSessionCount(SESSION_PAGE_SIZE);",
    "const visibleFilteredSessions"
  );

  assert.doesNotMatch(resetEffect, /loadingSessions/);
});

// 验证显式历史删除允许执行，而备份恢复保留进程运行保护。
test("delete allows explicit history removal while backup restore remains guarded", () => {
  const deleteSessionTree = sourceBlock(
    historySource,
    "fn delete_session_tree_with_backup_root",
    "fn delete_session_tree("
  );
  const restorePlan = sourceBlock(
    backupSource,
    "pub fn build_file_restore_plan",
    "pub fn restore_file_backup"
  );

  assert.doesNotMatch(deleteSessionTree, /is_target_tool_running|history_target_tool_running/);
  assert.match(restorePlan, /source\.map\(is_target_tool_running\)/);
  assert.match(restorePlan, /history_target_tool_running/);
});
