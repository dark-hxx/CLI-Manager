# SQLite Lock Contention Fix Design

## Root-Cause Statement

故障位于 Rust 用量数据库初始化与请求日志同步的共享 SQLite 写入边界：健康数据库每次连接仍重放全量迁移 SQL，活跃会话替换又用缺少 `file_path` 索引的条件扫描整张 `usage_records`，二者在长事务中持续占用 SQLite 唯一写槽，因此修复必须落在 Schema bootstrap 和同步清理源头，而不是项目弹窗、Hook 或 Replay 等受害入口。

## Discovery List

- `src-tauri/src/usage_schema.rs`
  - `open_usage_database`：所有用量读写连接的入口，保留 15 秒 SQLx busy timeout。
  - `ensure_usage_schema`：增加健康 Schema 只读快速路径；缺失结构时才执行兼容 bootstrap。
  - `ensure_usage_error_detail_schema`：事务前和获得写锁后均复查状态，避免重复视图/marker 写入。
- `src-tauri/src/commands/history/request_logs.rs`
  - `replace_document`：复用 `request_logs` 的 `(file_path, event_key)` 唯一索引及 `usage_records.record_id` 主键定向删除。
  - `remove_missing_files`：使用与替换相同的删除顺序和语义，避免另一个全表扫描入口。
  - `sync_request_logs_with_connection` / `history_sync_request_logs`：确认调用与每 60 秒单飞调度不变。
- `src-tauri/src/lib.rs`
  - 现有 migration SQL 和 checksum 不修改，避免已安装数据库 migration 校验失败。
  - 不新增大表索引迁移；通过既有主键/唯一索引解决定向删除，避免用户升级时再次长时间锁库及扩大 4 GB 数据库。
- `src/lib/db.ts`
  - 已确认是受害连接；不在 JS 侧添加连接级 PRAGMA 兜底，因为 tauri-plugin-sql 使用连接池，单次 PRAGMA 不能可靠覆盖池内所有连接。
- 项目、Hook、Replay、SSH、Provider 写入入口
  - 确认无需逐一修改；长写锁清除后继续使用原有写入逻辑。
- 后台 project-path backfill
  - 已确认当日完成且 `updated_rows=0`，与本次持续锁库无关。

## Data Flow

```text
App 60s timer / stats / route usage
  -> open_usage_database
  -> inspect schema + migration marker (read-only fast path)
  -> normal query/write

Changed transcript
  -> replace_document transaction
  -> indexed request_id lookup by request_logs.file_path
  -> primary-key delete from usage_records
  -> delete request_logs rows
  -> insert current parsed events + update sync fingerprint
  -> commit
```

## Compatibility

- 保持 migration 27～37 的 SQL、版本与 checksum 原样。
- 健康数据库只做轻量只读结构检查；旧数据库缺表或缺列仍进入 bootstrap。
- 删除仅覆盖同一 `file_path` 在 `request_logs` 中可证明关联的 `session_log` 行，不影响 route 数据。
- Windows、WSL、SSH、窗口焦点、桌面宠物、Worktree 和 Hook 安装状态均不改变数据库同步语义；它们共享同一主数据库，因此统一受益。

## Risks And Controls

- HIGH/CRITICAL 调用面：历史统计、路由用量记录和请求日志同步共享 `open_usage_database`。通过保持函数签名与返回错误不变，并增加只读健康路径测试控制风险。
- 遗留孤儿 `usage_records`：定向删除依赖 `request_logs.request_id`。正常同步和 migration 27 均保证这两个 ID 相同；测试覆盖替换及清理。孤儿清理由独立维护任务处理，不在高频同步中做全表扫描。
- 大型现有数据库不执行新增索引或 VACUUM，避免修复版本首次启动再次长时间独占写锁。

## Rollback

回滚只需恢复 `usage_schema.rs` 与 `request_logs.rs` 的逻辑；无新 Schema、无数据格式变化、无数据库降级步骤。
