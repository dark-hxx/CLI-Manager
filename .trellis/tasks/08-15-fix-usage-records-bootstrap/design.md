# Technical Design

## Boundary

在后端增加统一、幂等的主库 usage schema bootstrap，供所有绕过 `tauri-plugin-sql` 的 SQLx 连接复用。bootstrap 只负责保证统一用量依赖的基础表/索引/视图存在；正式 `_sqlx_migrations` 仍由 Tauri SQL 插件维护，后续 migration 可继续升级 view/schema。

## Data flow

`history_get_stats` / `history_get_request_log_stats` / `history_list_request_logs` / request-log sync / route usage write
→ shared SQLx connection bootstrap
→ `request_logs` + `usage_records` + `unified_usage_records` + indexes
→ existing aggregation/query logic
→ Tauri IPC/frontend.

## Bootstrap behavior

1. 在共享 helper 中以同一进程锁序列化首次 schema ensure，SQLite 连接保持既有 busy timeout。
2. 先执行 request-log 基础 migration（`CREATE TABLE IF NOT EXISTS`），使统一用量 migration 的历史 backfill source 始终存在。
3. 执行现有 usage v27 SQL；它创建 `usage_records`、索引、`usage_daily_rollups` 并幂等回填 request logs。
4. 执行现有 v28/v29 view/index SQL，确保直接后端入口不会读取缺失或旧的 `unified_usage_records` view。
5. 任何既有数据通过 `INSERT OR IGNORE`/`IF NOT EXISTS` 保留；SQL 插件之后仍可看到 `_sqlx_migrations` 并按正式 migration 记录执行。
6. bootstrap 错误向调用者返回诊断错误；`record_route_usage_best_effort` 继续捕获并记录，不改变上游响应。

## Reuse and scope

- 复用 `lib.rs` 中已经注册并经过迁移测试的 SQL 常量，不在统计模块复制表定义。
- 共享 helper 放在 `usage.rs`（统一用量域），request-log 与 history 通过该 helper 或统一连接包装调用。
- 不修改前端 payload、统计聚合算法、dedupe 规则或用户可见错误文案。

## Compatibility / rollback

- 新库：后端首次访问即可自举基础 schema，前端 SQL plugin 后续 migration 幂等通过。
- 旧库：已存在表/视图/数据时只做幂等 ensure/backfill，不替换业务数据。
- 并发：helper lock + SQLite busy timeout 避免两个入口同时 DROP/CREATE view。
- 回滚：删除 bootstrap 调用即可恢复旧路径；新增只读/幂等 schema 操作不改变现有业务记录。

## Validation

- Rust migration/bootstrap tests：空库、已有 request logs、重复 ensure、view 可查询、并发调用。
- Existing usage/history/request-log tests。
- `cargo check`、`cargo test`、`npx tsc --noEmit`、Trellis check。
