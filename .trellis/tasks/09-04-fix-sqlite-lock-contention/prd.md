# 修复 SQLite 写锁竞争与请求日志同步阻塞

## Goal

修复 usage schema 每次打开重复全量回填及 request log 按文件重建缺少索引导致的长写锁，避免项目、Hook、Replay 等写操作间歇性 SQLITE_BUSY。

## Requirements

- 健康数据库被请求日志、统计或路由用量代码重复打开时，不得再次执行历史请求日志全量回填、视图重建或 migration marker 写入。
- 保留旧库自愈能力：缺少 `request_logs` / `usage_records`、`usage_records.error_detail` 或对应迁移登记时，仍可补齐兼容结构。
- 活跃会话文件发生变化时，按 `file_path` 替换请求日志不得扫描全部 `usage_records`；必须复用现有唯一索引完成定向清理。
- 不改变 `request_logs`、`usage_records` 的数据口径、去重语义、IPC 参数或每 60 秒同步行为。
- 不通过在项目保存、Hook、Replay 等受害入口增加无限重试来掩盖长写锁。
- 代码变更记录写入 `CHANGELOG.md` 的 `[TEMP]` 版本和 `docs/功能清单.md` 的历史用量/请求日志板块。

## Acceptance Criteria

- [ ] 完整迁移后的数据库可以通过只读连接再次执行 `ensure_usage_schema`，证明健康路径只读且不会申请写锁。
- [ ] 缺失 `error_detail` 的旧结构仍能完成补列、视图更新和 v33 migration marker 登记，重复执行保持幂等。
- [ ] 按文件替换和清理先通过 `request_logs(file_path, event_key)` 找到对应 `request_id`，再用 `usage_records.record_id` 主键删除，最后删除 `request_logs`。
- [ ] 针对请求日志同步的 Rust 回归测试通过，数据替换和缺失文件清理结果与修复前一致。
- [ ] `cargo fmt --all -- --check`、相关 Rust 测试、`cargo check`、前端类型检查和生产构建通过。
- [ ] 使用现有缓存只构建 NSIS 安装包，跳过 MSI 和更新签名，并给出产物路径。

## Notes

- 根因：共享 SQLite 的用量 Schema bootstrap 在每次连接时重放全表回填，同时按文件清理缺少可用过滤索引，导致数十至数百秒写事务占用唯一 writer slot。
- 实测基线：本机 `cli-manager.db` 约 4.11 GB，`request_logs` 与 `usage_records` 各 1,886,924 行；慢 SQL 最长超过 260 秒。
