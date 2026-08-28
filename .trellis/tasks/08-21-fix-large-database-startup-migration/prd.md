# 优化大数据库升级迁移

## Goal

避免升级到包含 `backfill_request_log_project_path`（migration 32）的版本时，百万级 `usage_records` 数据库长时间停留在“检查并升级本地数据”；应用应先完成必要 Schema 初始化并进入主界面，再以小批次、可中断的后台任务渐进回填历史项目路径。

## Root-Cause Statement

根因位于 SQLx 启动迁移与历史用量数据维护的边界：migration 32 将面向百万行的全表关联回填放进了必须一次提交的启动事务，导致启动被长事务、全表扫描和数据库写锁阻塞；修复应把兼容迁移登记与历史数据回填拆开，而不是缩短 loading 超时或忽略数据库错误。

## Evidence

- 现场数据库 `cli-manager.db` 约 3.3 GB，`usage_records` 与 `request_logs` 各约 164 万行。
- 日志显示 `settings`、`sessions` 均在 50 ms 内完成，`database` 阶段超过 26 分钟仍未完成。
- `_sqlx_migrations` 已完成 1..31，但没有 version 32；重复启动会从头执行同一大事务。
- migration 32 包含项目表关联、聚合与 route/session 相关子查询，且所有历史 `usage_records.project_path` 均为空。
- 既有查询已对空 `project_path` 保留有界 legacy `project_key` 兼容过滤，因此渐进回填期间功能可继续使用。

## Requirements

- 不修改已发布 migration 32 的 SQL、版本、描述或 checksum。
- 对已存在 `usage_records.project_path` 且 migration 32 尚未登记的升级数据库，在 SQL 插件加载前登记原 migration 32 checksum，阻止原全量事务阻塞启动。
- 新建空数据库继续走标准 SQLx migrations；不得为没有历史数据的安装引入额外后台工作。
- 数据库加载完成后启动单飞后台回填；按小批次提交并在批次间让出执行时间，避免长期持有写锁。
- 项目路径解析语义保持与 migration 32 一致：绝对路径键、唯一配置项目名称/路径/末级目录映射，以及 route 行从同 session 继承。
- 后台任务可安全重启、重复运行和中断；已回填行必须跳过。
- 后台失败不得阻止应用启动；错误需要进入现有日志，供后续启动重试。
- 不删除或压缩用户历史数据，不改请求日志统计和去重口径。
- 变更记录写入 `CHANGELOG.md` 的 `[TEMP]` 与 `docs/功能清单.md` 对应数据库/启动板块。

## Scenario Matrix

- 数据规模：空库、小型库、百万行大库。
- 迁移状态：无迁移表、version 31/更早已应用但 32 未应用、32 已应用、32 曾中断但事务已回滚。
- 数据形态：绝对路径 project key、唯一项目名、重名项目、无匹配项目、route 与 session_log 混合。
- 生命周期：正常启动、回填中退出、下次重启继续、重复触发后台命令。
- 并发：主界面读取、Hook 写入、历史同步与后台回填同时发生；SQLite busy/locked。
- 环境：Windows 本地、WSL/UNC 字符串、SSH 项目（不得映射为本地项目路径）。

## Acceptance Criteria

- [x] 百万行旧数据库不会在 SQLx migration 32 中阻塞主界面启动。
- [x] `_sqlx_migrations` 中写入的 version 32 checksum 与原始 migration SQL 完全一致。
- [x] migration 32 已应用或新建空库时兼容处理为幂等 no-op。
- [x] 后台回填每次只提交有界行数，重复运行最终收敛且不会覆盖已有非空项目路径。
- [x] 重名项目不产生错误路径映射；SSH 项目不参与本地路径映射。
- [x] route 行仅从相同 source + session_id 的有效 session_log 路径继承。
- [x] 覆盖迁移登记、映射歧义、批次收敛、重复执行和 route 继承测试。
- [x] `cargo fmt`、相关 Rust tests、`cargo check`、TypeScript 检查通过。
- [x] NSIS-only 安装包构建成功。

## Out of Scope

- 不在本任务中清理 3 GB 历史数据库或制定 retention/rollup 策略。
- 不改变请求日志 UI、统计口径、历史文件解析或 Provider 逻辑。
- 不修改 migration 31/32 的既有 Schema 与视图定义。
