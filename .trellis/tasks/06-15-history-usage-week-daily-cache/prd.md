# history-usage-week-daily-cache

## Goal

调整历史用量分析的时间口径：周视图应表示“最近 7 天”而不是自然周；同时优化用量分析数据的查询路径，把逐日数据预处理/缓存起来，减少重复过滤和聚合。

## What I already know

* 用户明确提出：历史用量分析的“周”应该是最近 7 天的数据。
* 用户明确提出：用量分析数据希望按日存储到内存数据库/内存缓存，以提高查询速度。
* `src/components/stats/StatsPanel.tsx` 当前“周”使用 `<input type="week">` 和 ISO 自然周，`dateRangeFromStatsTimeWindow()` 会把周解析为周一到周日。
* `StatsPanel` 当前加载统计时传 `startAt/endAt`，后端 `history_get_stats` 会按显式范围聚合，前端改范围即可改变周统计口径。
* `src-tauri/src/commands/history.rs` 已有后端统计聚合缓存：`stats_aggregation_cache_get/set`，cache key 包含 roots/source/project/start/end/index generation。
* `src/stores/ccusageStore.ts` 当前把 ccusage 报告整体 JSON 存 SQLite 表 `ccusage_cache`，同时用 `memoryCache: Map<string, CcusageReport>` 缓存整份 report。
* `src/components/stats/CcusageStatsPanel.tsx` 当前会在渲染时从整份 payload 归一化 daily/blocks，并按时间窗口过滤/聚合。
* GitNexus 对 `StatsPanel`、`history_get_stats` 的上游影响分析均为 LOW；未能精确索引 `CcusageStatsPanel/useCcusageStore`，已用文件级/直接引用检查补充。

## Assumptions (temporary)

* “历史用量分析”指 `StatsPanel`，不是 `CcusageStatsPanel`。
* 用户已确认第二点指 `历史用量分析后端统计`，不是 `ccusage 用量分析`。
* “内存数据库”按最小实现理解为 Rust 运行期内存日聚合缓存/索引，不新增依赖、不引入新的数据库引擎。

## Open Questions

* 需要确认第二点具体指哪块用量分析以及“内存数据库”的期望实现。

## Requirements (evolving)

* 历史用量分析的周视图默认展示今天往前含今天的最近 7 天。
* 选择“周”时不再按 ISO 自然周周一至周日统计。
* 用量分析数据查询应避免每次切换窗口都从完整 JSON 重复扫描。

## Acceptance Criteria (evolving)

* [ ] 历史用量分析打开后，默认周范围为最近 7 天。
* [ ] 历史用量分析“周”标签显示最近 7 天的开始/结束日期。
* [ ] 切换到日/月/年/自定义仍保持现有行为。
* [ ] 用量分析按日索引/缓存后，切换时间窗口不重复从原始 payload 全量归一化。
* [ ] `npx tsc --noEmit` 通过。
* [ ] 若改 Rust 统计逻辑，`cd src-tauri && cargo test` 或至少相关测试通过。

## Definition of Done

* 类型检查通过。
* 必要的 Rust 测试通过或说明未运行原因。
* 不新增依赖。
* 不改无关 UI 风格。

## Out of Scope

* 不重做统计看板 UI。
* 不新增新的持久化数据库表，除非用户明确要求。
* 不改变日/月/年/自定义筛选语义。

## Technical Notes

* `src/components/stats/StatsPanel.tsx`: `getCurrentWeekDateRange()` 当前返回本周一到今天；`dateRangeFromStatsTimeWindow()` 当前对 week 解析为自然周。
* `src/components/stats/StatsPanel.tsx`: `loadStats({ startAt, endAt })` 已支持任意显式日期范围，改前端范围最小。
* `src-tauri/src/commands/history.rs`: `resolve_stats_time_bounds()` 显式范围会按 `start_at/end_at` 返回 `range_days`，并生成 daily/hourly 数据。
* `src/stores/ccusageStore.ts`: 目前 SQLite 只缓存整份 JSON；`memoryCache` 也只缓存整份 report。
* `src/components/stats/CcusageStatsPanel.tsx`: `summarizeCcusagePayload()`、`filterDailyByTimeWindow()`、`summarizeFilteredDaily()`、`normalizeBlockItems()` 是主要重复计算点。
