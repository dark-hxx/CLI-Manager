# 重构历史用量与请求日志加载链路

## Goal

显著降低“历史用量分析”和“请求日志”的首次加载、筛选、翻页与刷新等待时间，使读取已有数据不再被历史文件全量扫描、路由归因和跨来源去重阻塞，同时保持现有统计口径、日志去重语义和会话跳转能力。

## What I Already Know

- 请求日志前端查询会先同步历史文件，再读取当前页；读取路径因此承担目录递归扫描、fingerprint 检查和路由归因成本。
- 请求日志分页读取 `unified_usage_records`，总数、模型汇总和分页会重复执行跨来源相关子查询；当前本地数据库约 462 MB，数据增长会持续放大该成本。
- `history_get_stats` 会刷新文件索引并合并 Claude、Codex、OpenCode、catalog 与路由事实；默认包含 OpenCode 时无法复用现有聚合缓存。
- cc-switch 在请求写入时持久化明细，读取时只查询 SQLite，并用查询缓存、事件失效和日汇总控制读放大。
- 现有 `08-13-optimize-request-log-pagination` 任务仅处理视图时间范围与索引利用，本任务覆盖更上游的读取/同步解耦和统计缓存。

## Root-Cause Statement

性能问题位于“历史文件采集和归因维护”与“用户分页/统计读取”之间的后端数据流边界：维护型全量工作被同步耦合进交互式读取，因此修复应落在同步调度、持久化查询模型和缓存失效层，而不是只给页面增加 loading 或缩小分页数量。

## Requirements

- 请求日志读取必须优先返回 SQLite 中已有数据，不得因常规打开页面、筛选或翻页而等待历史文件全量同步。
- 历史文件同步改为可观测的后台增量任务；显式刷新可以触发同步，但重复请求不得并发启动等价扫描。
- 路由归因修复从请求日志分页读取路径移出，改为写入后或后台批处理，并保持现有匹配语义。
- 请求日志的总数、汇总和分页结果必须保持跨来源去重、成本计算和会话跳转语义。
- 历史统计需要支持所有来源组合的可复用缓存；缓存失效必须由源数据 fingerprint/version 驱动，而不是每次读取都重新聚合。
- 保持现有 Tauri IPC 参数和前端返回结构兼容；确需增加状态字段时必须向后兼容。
- 不覆盖当前工作区其他任务对 `src-tauri/src/usage.rs`、`CHANGELOG.md`、`docs/功能清单.md` 等文件的未提交改动。
- 新增或修改用户可见文案时同步提供 `zh-CN` 与 `en-US`。
- 本次采用非破坏性方案，不删除旧请求明细，不引入 retention/rollup；容量治理留到取得改造后基准数据再单独决策。
- 变更记录写入 `CHANGELOG.md` 的 `[TEMP]` 版本。

## Scenario Matrix

- 数据来源：仅 Claude、仅 Codex、仅 OpenCode、全部来源、没有任何历史数据。
- 文件位置：Windows 本地路径、WSL/UNC 路径、源目录暂时不可访问、文件在扫描期间新增或删除。
- 缓存状态：冷启动、热缓存、TTL/fingerprint 失效、数据库已有数据但源文件暂不可用。
- 页面操作：首次打开、项目/来源/模型/时间筛选、连续翻页、深分页、手动刷新、离开页面后返回。
- 同步状态：无变更、少量增量、大量首次导入、同步失败、重复刷新、应用关闭后重启。
- 路由状态：无路由记录、待归因记录、成功/部分成功记录、本地会话与路由记录重复。

## Acceptance Criteria

- [ ] 请求日志首次读取、筛选和翻页不会同步等待历史目录扫描或路由归因。
- [ ] 同一时刻最多运行一个等价历史日志同步任务，后续触发可复用结果或等待既有任务。
- [ ] 后台同步完成后，当前相关查询自动失效并刷新；失败不会清空或阻断已有数据读取。
- [ ] 优化前后的请求日志总数、模型汇总、分页内容和去重结果在固定测试数据集上完全一致。
- [ ] `history_get_stats` 在数据未变化的重复请求中复用缓存，包括默认“全部来源”场景。
- [ ] 冷启动优先复用持久化历史索引，不因统计读取同步递归扫描源目录；后台刷新发现新 generation 后自动更新相关查询。
- [ ] 覆盖空数据、源目录不可用、并发刷新、增量文件变化、OpenCode 和 WSL/UNC 场景的回归测试。
- [ ] 完成 Rust 相关测试、`cargo check`、前端类型检查和 GitNexus 变更范围检查。

## Definition of Done

- 完成设计、实现、回归测试和性能对比记录。
- 更新 `CHANGELOG.md` 指定版本与 `docs/功能清单.md` 对应功能板块。
- 不混入当前工作区其他任务的代码改动。

## Out of Scope

- 不改变统计指标定义、费用计算公式和模型价格来源。
- 不改造无关的终端、路由故障转移或供应商管理功能。
- 不删除历史请求明细，不实施 retention/rollup 或数据压缩迁移。
- 不在本任务中重新定义 `unified_usage_records` 的跨来源去重语义；沿用现有 v29 索引优化与视图契约。

## Technical Notes

- 主要触点：`src/components/stats/RequestLogsView.tsx`、`src/stores/historyStore.ts`、`src-tauri/src/commands/history/request_logs.rs`、`src-tauri/src/commands/history.rs`、`src-tauri/src/usage.rs`、`src-tauri/src/lib.rs`。
- 参考实现：`D:/work/pythonProject/cc-switch/src-tauri/src/services/usage_stats.rs`、`database/dao/usage_rollup.rs`、`src/lib/query/usage.ts`。
- 变更前必须对每个待编辑 symbol 执行 GitNexus upstream impact；HIGH/CRITICAL 必须先告警。
- 当前 `master` 与 `origin/master` 同步，工作区有其他任务的未提交改动。
- 决策：采用推荐的分阶段方案，本任务不删除旧明细；Changelog 版本为 `[TEMP]`。
