# 修复历史用量分析 usage_records 缺表

## Goal

修复 V1.3.6 中打开“历史用量分析”时因 `usage_records` 尚未创建而报 `usage_records_query_failed` 的问题，保证新数据库、旧数据库升级以及前端 SQL 插件尚未首次加载时，历史统计和路由用量链路都能使用统一用量 schema。

## Requirements

- 统一用量相关的后端直连数据库入口必须在查询/写入前确保 `request_logs`、`usage_records` 及其依赖视图/索引可用。
- 不在 `history_get_stats` 或前端统计面板增加吞掉数据库错误的症状兜底；缺失 schema 应在共享数据库初始化边界修复。
- 初始化必须幂等，不破坏已有 `request_logs`、`usage_records` 数据，并兼容前端 `tauri-plugin-sql` 后续执行正式 migrations。
- 保持现有 IPC 命令名称和返回结构兼容；路由记录写入失败仍不得阻断上游响应。
- 覆盖统计读取、请求日志读取/同步、路由用量写入与读取等直接使用主库的路径。
- 目标版本为 `V1.3.6`；同步 `CHANGELOG.md` 与 `docs/功能清单.md`。

## Acceptance Criteria

- [ ] 全新空数据库在尚未调用前端 `getDb()` 时，`history_get_stats` 不再因 `usage_records` 缺失失败。
- [ ] 已有 `request_logs` 的旧数据库可幂等创建/回填统一用量表，原有数据可继续查询。
- [ ] 路由记录写入、历史统计、请求日志列表和请求日志统计共享同一 schema 初始化边界。
- [ ] 并发首次访问不会产生 schema race、重复数据或破坏 view。
- [ ] `cargo test`/聚焦 Rust 测试、`cargo check`、`npx tsc --noEmit` 通过。
- [ ] 文档使用 V1.3.6 条目记录修复；不提交 Git commit。

## Root-cause statement

主库迁移目前只在前端 `Database.load` 链路被触发，而历史统计与路由用量模块通过独立 SQLx 连接直接访问 `usage_records`；当这些后端入口先于前端迁移执行时，schema 边界缺失导致消费者直接收到 `no such table`，因此修复应落在统一用量数据库初始化层而不是统计 UI 或查询函数的 fallback。

## Discovery list

- [x] `src-tauri/src/lib.rs`：统一用量 v27-v29 migrations 定义与插件注册。
- [x] `src/lib/db.ts`：前端 `getDb()` 先调用修复命令、再由 SQL 插件执行 migrations；确认它不是后端直连入口的可靠前置条件。
- [x] `src-tauri/src/usage.rs`：路由用量写入、读取和 attribution 直连主库。
- [x] `src-tauri/src/commands/history.rs`：历史统计合并路由 usage，并直接读取质量数据。
- [x] `src-tauri/src/commands/history/request_logs.rs`：请求日志同步/列表/统计直连统一视图。
- [x] 前端 `historyStore.ts`：统计 IPC 调用和错误展示为消费者，非根因位置。
- [x] 场景：新库/旧库升级、前端迁移先后顺序、统计/请求日志/路由并发首次访问、WAL/忙锁、空 usage 与已有历史数据。
