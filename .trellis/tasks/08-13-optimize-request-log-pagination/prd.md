# 优化请求日志分页查询性能

## Goal

降低历史用量分析“请求日志”首次加载和翻页时的等待时间，保持路由记录优先、本地会话记录去重后的结果一致。

## What I already know

* 请求日志分页接口会依次执行总数、按模型汇总、当前页三条 SQL。
* 三条 SQL 都读取 `unified_usage_records` 视图；视图对本地会话记录使用相关 `NOT EXISTS` 查询匹配路由记录。
* 当前数据库约有 6.8 万条本地会话记录和 417 条路由记录，实际七日范围的总数与汇总查询各约 0.7 秒，且执行计划只能使用 `source/data_source` 前缀索引，分页排序还使用临时 B-tree。
* 前端在调用分页接口前会先执行同步和路由归因，因此加载耗时还包含同步链路。

## Requirements

* 为路由去重匹配增加可利用的复合/表达式索引，并让时间条件保持可索引。
* 保持现有去重语义：路由成功/部分成功记录优先；本地记录只在没有同源、同会话、同模型、同输出 Token 且时间接近的路由记录时保留。
* 不改变 Tauri 命令参数和前端返回数据结构。
* 为关键查询计划或行为增加回归覆盖。

## Acceptance Criteria

* [ ] 请求日志总数、汇总和分页查询结果与优化前一致。
* [ ] SQLite 执行计划可使用新的去重匹配索引，不再为每条本地记录按宽泛 source 索引扫描候选。
* [ ] `cargo test`（相关测试）与 `cargo check` 通过。
* [ ] 中英文界面现有 loading 文案和请求日志展示不受影响。

## Definition of Done

* 后端迁移、视图查询和测试完成。
* `CHANGELOG.md` 使用 `[TEMP]` 版本记录。
* `docs/功能清单.md` 在产品功能行为变化时同步检查。
* 运行 GitNexus 变更检测；当前 GitNexus 数据库缺失时在交付说明中记录并使用契约/grep 回退。

## Technical Approach

在现有 v28 视图基础上增加后续迁移：为 `source/data_source/session_id/output_tokens/COALESCE(completed_at_ms, started_at_ms)` 建立复合表达式索引，并将 `ABS(...) <= 120000` 改写为等价的 `BETWEEN` 范围条件。这样保留精确去重逻辑，同时让 SQLite 在每个本地记录的候选路由查找中使用等值前缀和时间范围。

## Out of Scope

* 不改请求日志 UI 布局、分页大小或用户可见文案。
* 不将去重结果改造成永久物化表；本次先修复现有视图查询的索引利用问题。

## Technical Notes

* 触点：`src-tauri/src/lib.rs`、`src-tauri/src/commands/history/request_logs.rs`、`src/components/stats/RequestLogsView.tsx`（后两者用于确认调用与契约）。
* GitNexus impact 已执行，但索引文件 `.gitnexus/lbug` 缺失，返回 UNKNOWN；按项目要求使用本地契约、grep 和 SQLite EXPLAIN QUERY PLAN 继续分析。
* 变更记录版本：`[TEMP]`。
