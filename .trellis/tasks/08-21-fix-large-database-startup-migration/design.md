# 大数据库升级迁移优化设计

## 1. 设计概览

采用“兼容登记 + 后台渐进回填”两阶段方案：

1. `db_repair_known_migration_drift` 在 `Database.load` 之前检查旧数据库。若 migration 32 未应用且 `usage_records.project_path` 已存在，则以原 SQL 的 SHA-384 checksum 原子登记 version 32，不执行原全量回填。
2. `Database.load` 完成标准 Schema 迁移后，触发后端单飞回填命令。命令读取配置项目，构造无歧义的 project-key 映射，并以固定批次更新空路径行；route 继承也按批处理完成。
3. 回填期间请求日志继续使用既有 legacy `project_key` 过滤兜底；完成后自然走 `project_path` 索引路径。

## 2. 兼容性约束

- `MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL` 保持字节级不变。
- 兼容登记写入 `_sqlx_migrations(version=32, description='backfill_request_log_project_path', success=1, checksum=Sha384(original SQL))`。
- 只对已有迁移表、已有 `usage_records`、已有 `project_path` 列的数据库生效；空库交给 SQLx 正常创建。
- 已存在 version 32 时不重写记录，不掩盖未知 checksum drift。

## 3. 后台回填算法

### 3.1 项目映射

- 查询非 SSH 项目的 `name/path`，规范化为小写正斜杠且移除尾斜杠。
- 查询仍缺路径的 distinct `project_key`。
- 一个 key 只有在候选路径去重后恰好为 1 时才映射：key 本身是绝对路径；配置项目名称/路径与 key 相等；配置项目路径以 `/<key>` 结尾。
- 多个不同路径匹配同名项目时保持为空，由现有 legacy 查询兼容，不做猜测。

### 3.2 批量更新

- 按 project key 使用 `idx_usage_records_project(project_key, started_at_ms)` 与 rowid 游标抓取固定数量行。
- 每条 UPDATE 是独立短事务；更新后在批次间短暂 yield/sleep。
- 条件始终包含 `NULLIF(TRIM(project_path), '') IS NULL`，不会覆盖新写入或已回填路径。
- 任务级 Tokio mutex 保证一个进程内单飞；SQLite busy/locked 写入日志，下次启动重试。

### 3.3 Route 继承

- 只处理 `data_source='route'`、非空 session id、空 project path 的行。
- 从相同 `source + session_id` 的最新 `session_log` 非空路径继承。
- 同样使用有界 rowid 批次，不执行一次性全表相关 UPDATE。

## 4. 失败与恢复

- 兼容登记使用 `BEGIN IMMEDIATE/COMMIT`；失败回滚，SQLx 仍按原行为显式失败，不产生半登记。
- 后台批次天然幂等。退出只丢失当前未提交语句，已提交批次保留。
- 后台错误不反向阻塞已经完成的 `Database.load`，记录 warning；下一启动再次调用并继续处理空路径。

## 5. 发现清单

- `src-tauri/src/lib.rs::MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL`：原始语义/checksum 来源，只读复用，禁止修改。
- `src-tauri/src/commands/db_repair.rs::db_repair_known_migration_drift`：启动前兼容登记与后台命令实现，主要修改点。
- `src/lib/db.ts::loadDb`：数据库成功加载后的真实后台触发入口。
- `src-tauri/src/lib.rs::invoke_handler`：注册新后台命令。
- `src-tauri/src/commands/history/request_logs.rs::push_project_path_filters`：确认渐进回填期间已有 legacy fallback，无需修改。
- `src-tauri/src/usage.rs`：route attribution 已有相邻语义，仅作为复核，不修改。
- `src/App.tsx`：启动 loading 已能显示长迁移状态；本次无需修改。
- `.trellis/spec/backend/app-startup-contracts.md`、`history-stats-contracts.md`：启动迁移 checksum 与请求日志路径契约。

GitNexus 不可用（本地 CLI/索引工具未暴露，`npx` 又因缓存权限失败）；已按契约 + `rg` + 源码 + SQLite 现场数据降级。调用链影响为 `db_repair_known_migration_drift -> getDb -> 全部 SQLite 消费者`，风险 HIGH，因此保持 IPC 兼容、migration SQL 不变并使用聚焦测试约束。

## 6. 验证策略

- Rust 单元测试：兼容登记 checksum、已应用 no-op、缺 Schema no-op、唯一/歧义映射、分批收敛、route 继承、重复运行。
- 性能回归：构造至少数万行旧数据，确认启动兼容登记不随历史行数执行 UPDATE，后台批次大小有硬上限并最终完成。
- 静态检查：`cargo fmt --check`、相关 `cargo test`、`cargo check`、`tsc --noEmit`。
- 构建：复用 Cargo/npm 缓存，仅生成 NSIS。
