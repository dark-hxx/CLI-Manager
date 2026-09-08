import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 按测试文件相对路径读取源码供静态契约断言使用。
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const listSource = read("../src/features/history/components/HistoryListPane.tsx");
const detailSource = read("../src/features/history/components/SessionDetailPane.tsx");
const historySource = read("../src-tauri/src/features/history/mod.rs");
const catalogSource = read("../src-tauri/src/features/history/catalog.rs");
const catalogDetailSource = read("../src-tauri/src/features/history/catalog/session_detail.rs");

// 验证历史会话与消息均提供多选入口和批量删除控件。
test("history exposes both session and message multi-select controls", () => {
  assert.match(listSource, /onClick=\{onEnterSelectionMode\}/);
  assert.match(listSource, /history\.bulk\.selectVisible/);
  assert.match(listSource, /history\.bulk\.deleteSelected/);
  assert.match(detailSource, /onClick=\{toggleMessageSelectionMode\}/);
  assert.match(detailSource, /history\.edit\.batchDeleteSelected/);
});

// 验证目录读取刷新脏数据并拒绝文件指纹过期的第二代快照。
test("catalog reads refresh dirty data and rejects stale V2 snapshots", () => {
  assert.match(historySource, /catalog::is_dirty\(\)/);
  assert.match(historySource, /catalog::ensure_refresh\(app\.clone\(\), roots\.clone\(\), false, true\)/);
  assert.match(catalogSource, /pub\(super\) fn is_dirty\(\)/);
  assert.match(catalogDetailSource, /hs\.fingerprint_value/);
  assert.match(catalogDetailSource, /source_path\.exists\(\)/);
  assert.match(catalogDetailSource, /v2_fingerprint_value\(session_file_fingerprint\(source_path\)\)/);
});
