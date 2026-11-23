import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const panelSource = readFileSync(
  new URL("../src/features/terminal/components/TerminalStatsPanel.tsx", import.meta.url),
  "utf8",
);

function loadHistoryModule(name, dependencies) {
  const source = readFileSync(new URL(`../src/features/history/lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  runInNewContext(outputText, { exports, require: (id) => dependencies[id] ?? {} });
  return exports;
}

test("bound session polling reloads an appended transcript with the same modification time", async () => {
  const summary = { sessionId: "current", filePath: "rollout.jsonl", updatedAt: 123, source: "codex" };
  let detailReads = 0;
  const requests = loadHistoryModule("historyRequests", {
    "./historyNormalization": loadHistoryModule("historyNormalization", {}),
    "../api/historyPathArgs": { getHistoryPathArgs: async () => ({}) },
    "../../../shared/platform/logger": { logInfo() {}, logWarn() {} },
    "@tauri-apps/api/core": {
      invoke(command, args) {
        if (command === "history_list_sessions") return [summary];
        assert.equal(command, "history_get_session");
        assert.equal(args.fresh, true);
        detailReads++;
        return { ...summary, usage: { outputTokens: detailReads } };
      },
    },
  });
  const poll = (previous, freshDetail = false) => requests.fetchLatestProjectSessionDetail(
    "project", previous && {
      filePath: previous.file_path, updatedAt: previous.updated_at, fileSize: previous.file_size,
    }, "codex", "current", { aggregateSubtasks: true, freshDetail },
  );
  const legacy = await poll();
  assert.equal(await poll(legacy), "unchanged");
  summary.fileSize = 100;
  const first = await poll(legacy);
  assert.equal(first.file_size, 100);
  summary.fileSize = 125;
  const appended = await poll(first);
  assert.equal(appended.file_size, 125);
  assert.equal(appended.usage.output_tokens, 3);
  assert.equal(await poll(appended), "unchanged");
  await poll(appended, true);
  assert.equal(detailReads, 4);
});

test("today project usage never renders stats from another project scope", () => {
  assert.match(panelSource, /const \[todayStatsState, setTodayStatsState\] = useState/);
  assert.match(panelSource, /const todayUsageScopeKey = useMemo/);
  assert.match(
    panelSource,
    /const todayStats = todayStatsState\?\.scopeKey === todayUsageScopeKey[\s\S]*todayProjectStatsCache\.get\(todayUsageScopeKey\)/,
  );
  assert.match(
    panelSource,
    /const todayProjectStatsCache = new Map<string, TodayProjectStats>\(\)/,
  );
  assert.match(
    panelSource,
    /if \(result\) todayProjectStatsCache\.set\(todayUsageScopeKey, result\)/,
  );
  assert.match(
    panelSource,
    /value: result \?\? todayProjectStatsCache\.get\(todayUsageScopeKey\) \?\? null/,
  );
});
