import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const listSource = read("../src/components/history/HistoryListPane.tsx");
const detailSource = read("../src/components/history/SessionDetailPane.tsx");
const historySource = read("../src-tauri/src/commands/history.rs");
const catalogSource = read("../src-tauri/src/commands/history/catalog.rs");

test("history exposes both session and message multi-select controls", () => {
  assert.match(listSource, /onClick=\{onEnterSelectionMode\}/);
  assert.match(listSource, /history\.bulk\.selectVisible/);
  assert.match(listSource, /history\.bulk\.deleteSelected/);
  assert.match(detailSource, /onClick=\{toggleMessageSelectionMode\}/);
  assert.match(detailSource, /history\.edit\.batchDeleteSelected/);
});

test("catalog reads refresh dirty data and rejects stale V2 snapshots", () => {
  assert.match(historySource, /catalog::is_dirty\(\)/);
  assert.match(historySource, /catalog::ensure_refresh\(app\.clone\(\), roots\.clone\(\), false, true\)/);
  assert.match(catalogSource, /pub\(super\) fn is_dirty\(\)/);
  assert.match(catalogSource, /hs\.fingerprint_value/);
  assert.match(catalogSource, /source_path\.exists\(\)/);
  assert.match(catalogSource, /v2_fingerprint_value\(session_file_fingerprint\(source_path\)\)/);
});
