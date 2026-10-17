import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("./historyRequests.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** 依序回應 `history_list_sessions`，並記錄每一次 invoke。 */
function load(listings, detail = { session_id: "cli-a", source: "claude", file_path: "/s/cli-a.jsonl" }) {
  const calls = [];
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id) => {
    if (id.endsWith("@tauri-apps/api/core")) return { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "history_list_sessions") return listings.shift() ?? [];
      if (command === "history_get_session") return detail;
      return undefined;
    } };
    if (id.endsWith("historyPathArgs")) return { getHistoryPathArgs: async () => ({ claudeConfigDir: "C:/claude" }) };
    if (id.endsWith("historyNormalization")) return { normalizeSummary: (value) => value, normalizeDetail: (value) => value };
    if (id.endsWith("logger")) return { logInfo: () => {}, logWarn: () => {} };
    return {};
  } });
  return { exports, calls };
}

const hit = [{ session_id: "cli-a", source: "claude", project_key: "k", file_path: "/s/cli-a.jsonl", updated_at: 1 }];
const scopes = (calls) => calls.filter((call) => call.command === "history_list_sessions").map((call) => call.args.projectPath);

test("a bound summary is looked up in the project first, then without a project", async () => {
  const scoped = load([hit]);
  assert.equal((await scoped.exports.fetchBoundSessionSummary("C:/repo", "claude", "cli-a")).file_path, "/s/cli-a.jsonl");
  assert.deepEqual(scopes(scoped.calls), ["C:/repo"]);
  assert.equal(scoped.calls[0].args.claudeConfigDir, "C:/claude");

  const unscoped = load([[], hit]);
  assert.equal((await unscoped.exports.fetchBoundSessionSummary("C:/repo", "claude", "cli-a")).session_id, "cli-a");
  assert.deepEqual(scopes(unscoped.calls), ["C:/repo", null]);
});

test("the catalog is refreshed only when forced, then both scopes are retried", async () => {
  const lazy = load([[], []]);
  assert.equal(await lazy.exports.fetchBoundSessionSummary("C:/repo", "claude", "cli-a"), null);
  assert.equal(lazy.calls.some((call) => call.command === "history_refresh_index"), false);

  const forced = load([[], [], [], hit]);
  const summary = await forced.exports.fetchBoundSessionSummary("C:/repo", "claude", "cli-a", {
    forceCatalogRefresh: true, waitForCatalogRefresh: true,
  });
  assert.equal(summary.session_id, "cli-a");
  const refresh = forced.calls.find((call) => call.command === "history_refresh_index");
  assert.equal(refresh.args.wait, true);
  assert.deepEqual(scopes(forced.calls), ["C:/repo", null, "C:/repo", null]);
});

test("a summary for another session is never returned for a bound ID", async () => {
  const other = [{ ...hit[0], session_id: "cli-other" }];
  const f = load([other, other]);
  assert.equal(await f.exports.fetchBoundSessionSummary("C:/repo", "claude", "cli-a"), null);
});

test("latest detail keeps using the bound summary and rejects a mismatched session", async () => {
  const f = load([hit]);
  const detail = await f.exports.fetchLatestProjectSessionDetail("C:/repo", undefined, "claude", "cli-a", { freshDetail: true });
  assert.equal(detail.session_id, "cli-a");
  const read = f.calls.find((call) => call.command === "history_get_session");
  assert.deepEqual([read.args.filePath, read.args.fresh, read.args.aggregateSubtasks], ["/s/cli-a.jsonl", true, false]);

  const mismatch = load([[{ ...hit[0], session_id: "cli-other" }], []]);
  assert.equal(await mismatch.exports.fetchLatestProjectSessionDetail("C:/repo", undefined, "claude", "cli-a"), null);
  assert.equal(mismatch.calls.some((call) => call.command === "history_get_session"), false);
});
