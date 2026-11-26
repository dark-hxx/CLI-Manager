import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the component output with synthetic stats, without mounting app stores or reading history.
function load(relative, dependencies = {}, extra = "") {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source + extra, {
    fileName: relative,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  runInNewContext(outputText, { exports, require: (key) => dependencies[key] ?? {} });
  return exports;
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree?.props ? [tree, ...nodes(tree.props.children)] : [tree];
}
const jsx = (type, props) => ({ type, props });
for (const [language, prop] of [["zh-CN", "zh"], ["en-US", "en"]]) {
  test(`analytics missing, known zero and partial coverage (${language})`, () => {
    const messages = load(`../src/shared/i18n/messages/analytics.${language}.ts`)[prop];
    const t = (key, data = {}) => (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, field) => data[field] ?? "");
    const cards = load("../src/features/stats/api/StatsPanel.tsx", {
      "../../../shared/i18n/index": { useI18n: () => ({language, t}) },
      "./statsPalette": { STATS_COLORS: {} },
      "lucide-react": { Layers:"layers", Coins:"coins", MessagesSquare:"messages", Database:"db" },
      "react": { useMemo: fn => fn() },
      "react/jsx-runtime": { jsx, jsxs: jsx },
    }, "\nexport { ProjectRankingCard, ContextNote, KpiStrip };\n");
    for (const [sessions, unknown, input] of [[1, 1, 0], [1, 0, 0], [2, 1, 17]]) {
      const stats = { total_sessions:sessions, total_messages:4, total_input_tokens:input, total_output_tokens:0,
        total_cache_read_tokens:0, total_cache_creation_tokens:0, total_unpriced_tokens:0, total_cost_usd:0, unmeasured_sessions:unknown };
      const kpi = nodes(cards.KpiStrip({stats,trend:[]}));
      assert.equal(kpi.filter(value => value === "—").length, sessions === unknown ? 3 : 0);
      assert.ok(kpi.includes(String(sessions)));
      if (sessions === unknown) assert.ok(kpi.includes(t("stats.activityMessages", {count:4})));
      const note = nodes(cards.ContextNote({stats}));
      assert.equal(note.includes(t("stats.context.unpriced", {value:"0"})), sessions !== unknown);
      const item = {project_key:"activity", sessions:1, input_tokens:0, output_tokens:0, cache_read_tokens:0, cache_creation_tokens:0};
      const items = sessions === 2 ? [item, {...item, project_key:"measured", input_tokens:17}] : [item];
      const ranking = nodes(cards.ProjectRankingCard({items, showActivity:Boolean(unknown)}));
      assert.equal(ranking.find(node => node?.props?.label === "activity").props.value, unknown ? t("stats.unit.sessions", {count:"1"}) : "0");
    }
  });
}
