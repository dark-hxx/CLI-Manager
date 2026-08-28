# 修复路由重试与历史统计审查问题

## Goal

修复审查指出的 5 个路由与历史统计一致性问题：严格限制真实上游请求次数、升级后保留项目范围请求记录、让后台同步正确失效统计缓存、让显式刷新排队执行新扫描，并向用户显示本地统计同步失败。

## What I Already Know

- 当前 `master` 与 `origin/master` 同步（ahead 0 / behind 0），但工作区已有 25 项未提交变更；本任务必须在现有改动上做最小上下文补丁。
- `forward_request` 在供应商外层只增加一次 attempt，而同一供应商的 key/整流重试可以多次调用 `.send()`。
- v31 迁移公开了 `usage_records.project_path`，parser v3 会在后台重写变更文档，但旧行在重写前仍可能为 `NULL`。
- 后台同步可能只改变 Copilot、Pi、Cursor、Kiro、Cline 等非请求日志来源；此时历史索引 generation 会变化，而请求日志行计数保持为 0。
- `RequestLogsView` 与 `StatsPanel` 的显式刷新当前以 `force=false` 加入共享 Promise，可能只等待点击前已开始的扫描。
- `StatsPanel` 捕获同步失败后仍在 `finally` 中读取旧 SQLite 数据，界面没有区分同步失败和成功刷新。
- 新增用户可见错误文案必须同时覆盖 `zh-CN` 与 `en-US`；交付记录版本使用 `TEMP`。

## Root-Cause Statements

- 路由问题位于“供应商候选”与“真实 HTTP send”之间的计数边界：attempt 在供应商外层分配，无法覆盖同一候选内的每次 key/整流发送，因此计数和失败事实必须移动到每次 send 的边界。
- 升级问题位于数据库迁移与纯 SQL 项目过滤之间：过滤开始依赖物化 `project_path`，但 v31 没有同步填充可恢复的旧行，因此修复必须落在后续 v32 兼容回填及缺失路径兼容边界。
- 缓存问题位于历史索引 generation 与请求日志写入计数之间：两者不是等价变化信号，因此历史统计失效不能只依赖请求日志行计数。
- 刷新问题位于后台 single-flight 与用户显式刷新之间：`force=false` 把点击动作合并到较早扫描，显式刷新必须排队执行点击后的新扫描。
- 错误展示问题位于同步维护任务与统计查询 UI 之间：同步异常被日志吞掉并由旧数据 refetch 掩盖，因此成功读取旧数据不能清除或伪装同步失败。

## Requirements

- 每一次真实上游 `.send()` 都消耗 `max_provider_attempts` 预算并获得唯一 attempt index；任何失败发送都写入独立状态记录，预发送 skip 继续不计数。
- 同一供应商的多 key 重试、整流重试、跨供应商 failover 和最终成功响应共享同一全局 attempt 序列，且不得超过配置上限。
- v32 后续迁移为能够从旧字段或唯一配置项目映射恢复的旧 `usage_records` 行写入规范化 `project_path`，并把结果传播给同 session 的 route 行；不可恢复行保留有界兼容匹配，不做错误的任意归因。独立版本确保已执行 v31 的数据库也会获得回填。
- 后台同步成功后，历史统计 Query 必须失效，即使本次变化来源不属于 `REQUEST_LOG_SOURCES`；请求日志 Query 仍只在请求日志行真正变化时失效。
- 请求日志和统计面板的本地显式刷新必须请求一次 `force=true` 的后续同步；若较早扫描在运行，后端锁负责顺序执行，不得把点击合并进旧扫描。
- 统计面板同步失败时保留现有数据和原更新时间，显示本地化错误；只有同步成功后才 refetch 并更新展示时间。
- 保持现有 Tauri command 名称和必需参数兼容，不新增依赖，不改统计口径、供应商顺序或 circuit skip 语义。
- 更新 `CHANGELOG.md` 的 `[TEMP]` 版本及 `docs/功能清单.md` 对应路由/分析看板条目。

## Scenario Matrix

- 路由：单 key、多 key、401/429、整流 400 后重试、运输超时、跨供应商 failover、预算在候选内部耗尽、预发送 circuit/cooldown skip。
- 历史升级：全新数据库、v30/v31 旧库升级到 v32、绝对路径 key、唯一配置项目映射、同名项目歧义、route/session 配对、源目录不可用。
- 同步：请求日志来源变化、仅非请求日志来源变化、无变化、同步失败、启动/定时扫描与手动刷新重叠。
- UI：有旧统计数据/无旧数据、同步失败/查询失败、连续点击刷新、切换项目/来源/时间范围、中文/英文界面。

## Acceptance Criteria

- [ ] 测试证明 2 个 key 的 2 次 send 产生 attempt 1/2，预算为 1 时不会发送第 2 个 key，失败记录与实际 send 一一对应。
- [ ] circuit-open、cooldown 和无可用 key 等预发送 skip 不消耗 attempt；真实发送失败继续参与 circuit/failover。
- [ ] 迁移测试证明旧 session/route 行在可恢复时得到规范化 `project_path`，并且迁移可重复执行、不删除数据、不覆盖已有非空路径。
- [ ] 项目路径过滤在 parser v3 后台重写前仍能读取可恢复的 Codex、Gemini、OpenCode、Grok 旧记录，源目录不可用时不触发历史扫描。
- [ ] 仅非请求日志来源改变时 `historyStats` 被失效；无请求日志行变化时请求日志列表/汇总不被无条件失效。
- [ ] 两处显式刷新都不会加入点击前已运行的扫描，并在同步失败时保留原数据。
- [ ] `StatsPanel` 以中英文显示同步失败，失败路径不 refetch 旧数据、不更新最后刷新时间。
- [ ] 相关 Rust tests、`cargo check`、`npx tsc --noEmit`、`npm run build`、`git diff --check` 和 GitNexus change detection 通过。

## Definition of Done

- 5 个审查意见均有代码修复和针对性回归验证。
- 根因陈述、发现清单、契约更新、变更记录和人工桌面验证项齐全。
- 不覆盖或回退工作区内其他任务的未提交改动。

## Out of Scope

- 不改变 provider 排序、circuit 阈值、key cooldown 策略或模型整流规则本身。
- 不重新设计历史数据库、统计指标、价格计算和 SSH 远端刷新语义。
- 不对无法从数据库或唯一项目配置可靠恢复的旧行做猜测性永久归因。

## Technical Notes

- GitNexus 预改动影响：`syncHistoryRequestLogs` 为 HIGH（4 个直接调用方，影响统计、请求日志、会话与终端统计流程）；`forward_request`、`migrations`、`sync_request_logs_with_connection`、`RequestLogsView`、`StatsPanel` 为 LOW。
- 主要触点：`src-tauri/src/daemon/route_http.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/usage_schema.rs`、`src-tauri/src/commands/history/request_logs.rs`、`src/stores/historyStore.ts`、`src/components/stats/RequestLogsView.tsx`、`src/components/stats/StatsPanel.tsx`、`src/lib/i18n.ts`。
- 相关契约：`.trellis/spec/backend/history-stats-contracts.md` §4 lines 150–155。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
