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

const identity = loadHistoryModule("../api/antigravityDiskIdentity", {});
const id = "8ea09528-bf36-4ac6-8d49-c683953ce14f";
const nil = "00000000-0000-0000-0000-000000000000";
const root = "/Users/Example/.gemini/antigravity-cli";
const cwd = "/Users/Example/Worktree";
const suffix = `/brain/${id}/.system_generated/logs/transcript.jsonl`;
const record = { source: "antigravity", session_id: id, cwd, file_path: root + suffix, updated_at: 200, file_size: 25 };

test("agy native POSIX and WSL disk identity preserves case and roots, and rejects nil and legacy", () => {
  const matches = (rec, project = cwd, distro = "", selected = root, query = id) => identity.antigravityDiskIdentityMatches(rec, query, project, distro, selected);
  assert.ok(matches(record));
  assert.ok(matches({ ...record, cwd: "/" }, "/"));
  assert.ok(matches({ ...record, cwd: "D:/" }, "d:/"));
  assert.ok(!matches(record, cwd.toLowerCase()));
  assert.ok(!matches(record, cwd, "", root.toLowerCase()));
  assert.ok(!matches({ ...record, file_path: record.file_path.replace("/brain/", "/Brain/") }));
  assert.ok(!matches({ ...record, file_path: record.file_path.replace("antigravity-cli", "antigravity") }));
  assert.ok(!matches({ ...record, session_id: nil, file_path: record.file_path.replace(id, nil) }, cwd, "", root, nil));
  const wslRoot = "//wsl.localhost/Ubuntu/home/A/.gemini/antigravity-cli";
  const wslRecord = { ...record, cwd: "/Work", file_path: wslRoot + suffix };
  assert.ok(matches(wslRecord, "//wsl$/ubuntu/Work", "UBUNTU", wslRoot));
  assert.ok(!matches(wslRecord, "/work", "ubuntu", wslRoot));
  assert.ok(!matches(wslRecord, "//wsl$/debian/Work", "ubuntu", wslRoot));
  assert.ok(!matches(wslRecord, "/Work", "debian", wslRoot));
  assert.ok(!matches(wslRecord, "/Work", "ubuntu", "/home/A/.gemini/antigravity-cli"));
});

test("malformed explicit agy references cannot normalize to a resumable native record", () => {
  const {normalizeSummary, normalizeDetail} = loadHistoryModule("historyNormalization", {});
  assert.equal(normalizeSummary(record).read_only, false);
  assert.equal(normalizeSummary({...record, session_ref: {sourceId:"antigravity"}}).read_only, true);
  assert.equal(normalizeDetail({...record, sessionRef: false}).read_only, true);
  assert.equal(normalizeSummary({...record, source:"codex", sessionRef:{}}).read_only, false);
});

test("agy unbound → waiting → unmeasured / measured activity; unchanged fingerprint avoids detail reads", async () => {
  let available = false, staleDetail = false, measured = false;
  const calls = [];
  const summary = { ...record };
  const requests = loadHistoryModule("historyRequests", {
    "./historyNormalization": loadHistoryModule("historyNormalization", {}),
    "../api/antigravityDiskIdentity": identity,
    "../api/historyPathArgs": { getHistoryPathArgs: async () => ({ antigravityConfigDir: root }) },
    "../../../shared/platform/logger": { logInfo() {}, logWarn() {} },
    "@tauri-apps/api/core": { invoke(command, args) {
      calls.push(command);
      if (command === "history_list_sessions") {
        assert.equal(args.boundAntigravityDistro, "");
        assert.equal(args.projectPath, cwd);
        assert.equal(args.query, id);
        return available ? [summary] : [];
      }
      assert.equal(command, "history_get_session");
      assert.equal(args.filePath, record.file_path);
      return {
        ...summary,
        cwd: staleDetail ? "/Other" : cwd,
        messages: [{ role: "user", content: "fixture" }],
        tool_events: [{ name: "list_dir", category: "builtin" }],
        ...(measured ? {
          usage: {
            input_tokens: 15635,
            output_tokens: 131,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            dominant_model: "claude-sonnet-5-5-medium",
            current_model: "claude-sonnet-5-5-medium",
            last_context_tokens: 15635,
            token_trend: [{
              input_tokens: 15635,
              output_tokens: 131,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              total_tokens: 15766,
              model: "claude-sonnet-5-5-medium",
            }],
          },
        } : {}),
      };
    } },
  });
  const poll = (bound = id, prev) => requests.fetchLatestProjectSessionDetail(cwd, prev && {filePath:prev.file_path,updatedAt:prev.updated_at,fileSize:prev.file_size}, "antigravity", bound, {boundAntigravityDistro:"",forceCatalogRefresh:true});
  assert.equal(await poll(""), null);
  assert.equal(await poll(nil), null);
  assert.deepEqual(calls, []);
  assert.equal(identity.agyPanelNotice("", false), "termStats.agyUnbound");
  assert.equal(await poll(), null);
  assert.deepEqual(calls, ["history_list_sessions"]);
  assert.equal(identity.agyPanelNotice(id, false), "termStats.agyWaiting");
  available = true;
  const loaded = await poll();
  assert.equal(loaded.usage, undefined);
  assert.equal(loaded.messages[0].content, "fixture");
  assert.equal(loaded.tool_events.length, 1);
  assert.equal(identity.agyPanelNotice(id, true), "termStats.agyUnmeasured");
  assert.equal(await poll(id, loaded), "unchanged");
  summary.file_size++;
  measured = true;
  const appended = await poll(id, loaded);
  assert.equal(appended.file_size, 26);
  assert.equal(appended.usage.input_tokens, 15635);
  assert.equal(appended.usage.output_tokens, 131);
  assert.equal(appended.usage.current_model, "claude-sonnet-5-5-medium");
  assert.equal(appended.usage.last_context_tokens, 15635);
  assert.equal(appended.usage.token_trend.length, 1);
  staleDetail = true;
  assert.equal(await poll(), null);
  assert.deepEqual(calls.slice(1), ["history_list_sessions","history_get_session","history_list_sessions","history_list_sessions","history_get_session","history_list_sessions","history_get_session"]);
  assert.match(panelSource, /const agyHasUnmeasuredAssistantReply =/);
  assert.match(panelSource, /const waitingForUsage =\s*Boolean\(boundCliSessionId\)/);
  assert.doesNotMatch(panelSource, /if \(isAgy && \["tokenUsage", "tokenTrend", "modelContext"\]\.includes\(cardKey\)\)/);
});
