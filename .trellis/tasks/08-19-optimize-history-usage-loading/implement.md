# 重构历史用量与请求日志加载链路 — 实施计划

## 前置约束

- 当前 `master` 与 `origin/master` 同步（ahead 0 / behind 0）。
- 工作区已有其他任务修改，尤其是 `src-tauri/src/usage.rs`、`CHANGELOG.md`、`docs/功能清单.md`；只做上下文最小补丁，不覆盖或格式化无关内容。
- 每个待编辑函数/方法前必须再次运行 GitNexus upstream impact；HIGH/CRITICAL 立即停下告警。
- Changelog 版本：`[TEMP]`。

## Phase A — 建立基准与回归夹具

- [x] 记录本地数据库大小及 request/usage/sync 行数。
- [ ] 给现有固定 SQLite fixture 记录请求日志 summary/page 和统计结果，作为语义等价基线。
- [ ] 为分页、项目路径、route/session 去重补足可复用测试 helper。
- [x] 记录现有 SQLite 30 天汇总与分页查询耗时，确认交互延迟主要位于读前同步而非分页 SQL。

## Phase B — 请求日志纯读取

- [x] 修改 `RequestLogsView`，分页 query 直接调用 `history_list_request_logs`。
- [x] 从 `fetchHistoryRequestLogStats`、`fetchTodayProjectStats` 移除隐式同步。
- [x] 让 `App` 通过统一 `syncHistoryRequestLogs` 执行启动与定时后台同步。
- [x] 同步结果有真实数据变化时，通过共享 QueryClient 失效 `historyRequestLogs`、`historyRequestLogStats`、`historyStats`。
- [x] 调整本地手动刷新为“增量同步一次 -> 非 force 读取”，SSH 手动 force 语义不变。
- [ ] 增加前端测试或可测试 helper，证明普通读取不触发同步、无变化同步不重复失效。

## Phase C — 项目路径筛选物化

- [x] 在修改迁移/视图 symbol 前执行 GitNexus impact 并检查当前最高 migration version。
- [x] 添加非破坏性迁移：项目路径索引、`unified_usage_records.project_path`；完整复制现有 v29 去重条件。
- [x] 扩展 `RequestLogDocument`，写入规范化 cwd/project path；bump parser version 触发后台回填。
- [x] 将 project path 过滤改为 SQL 候选路径 + Claude project-key fallback。
- [x] 删除列表与请求统计读取路径中的历史索引刷新和 `file_path IN (...)` 构造。
- [x] 测试 Windows、WSL `/mnt/*`、UNC、Worktree 子路径与 Claude 旧行 fallback 的过滤结果。

## Phase D — 路由归因移出关键路径

- [x] 在 `usage.rs` 当前用户改动基础上增加定向归因 helper，避免覆盖 `UsageStatus::NotApplicable` 等现有未提交内容。
- [x] route 写入后对当前 `(source, session_id)` 尝试定向归因。
- [x] session 文档写入后对当前 `(source, session_id)` 归因既有 pending route 行。
- [x] 删除同步命令尾部等待式全量归因；增加单次、单飞、失败可重试的后台 legacy repair。
- [ ] 测试 route-before-session、session-before-route、无 session、跨 source 同 session、SQL 失败与旧 pending backfill。

## Phase E — 历史统计快照和全来源缓存

- [x] 抽出“内存或持久化索引快照”读取函数；普通统计优先不进入 `collect_session_files_with_force`。
- [x] force/后台刷新继续走现有增量 scan，generation 变化后保存持久化索引。
- [x] 为 OpenCode 生成稳定、低成本的 DB/WAL fingerprint；加入 aggregation cache key。
- [x] 允许默认全部来源写入/读取 aggregation cache，并保持最大 32 项淘汰。
- [x] 保留 route generation、source instance、规范化项目路径集合等现有 key 维度。
- [ ] 测试冷启动持久化快照、热 cache、OpenCode 文件变化、route generation 变化、force bypass、空数据和源不可访问。

## Phase F — 一致性与性能验证

- [ ] 对固定 fixture 比较改造前后请求日志总数、summary、分页顺序、去重、成本与会话路径。
- [ ] 比较历史统计所有 totals、daily/hourly、项目/模型/来源分布与 data quality。
- [x] 运行请求日志与历史统计相关 Rust tests。
- [x] 运行 `npx tsc --noEmit`。
- [x] 运行 `cd src-tauri && cargo check`。
- [x] 在资源允许时运行 `cd src-tauri && cargo test`；全量 1082 passed / 1 ignored。
- [x] 通过调用链与回归测试确认日志 list/stats 读取路径无目录 scan / 全量 attribution；真实大库基线显示 30 天 SQL 汇总约 35–43 ms、分页约 0.1–0.4 ms，瓶颈来自已移出的读前维护工作。
- [x] 运行 `gitnexus_detect_changes(scope="all")`；本任务命中历史/用量/App/统计面板流程，报告中的其他高风险路由与 Agent 能力流程来自开始前已存在的并行工作区修改。

## Phase G — 交付记录

- [x] 在 `.trellis/spec/backend/history-stats-contracts.md` 记录纯读取、后台同步、项目路径物化和全来源 cache generation 契约。
- [x] 在 `[TEMP]` 下合并追加 `CHANGELOG.md`，不得覆盖其他任务条目。
- [x] 在 `docs/功能清单.md` 的历史会话/分析看板板块合并追加性能行为说明。
- [x] 列出人工中英文桌面验证步骤；AI 不启动 Tauri UI。

## 回滚点

- B 完成后可独立回滚前端纯读取调用。
- C 的追加字段/索引不需删除；代码回滚后旧逻辑仍可工作。
- D 可恢复全量后台 repair，但不得重新放回分页读取 queryFn。
- E 可恢复同步 stats refresh，保留新的 cache key 维度。

## 验证结果

- `npm run build`：通过（Vite 6830 modules）。
- `npx tsc --noEmit`：通过。
- `cargo check`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test --lib --quiet`：1082 passed / 1 ignored。
- 请求日志测试：7 passed；路由归因测试：2 passed；迁移与 OpenCode generation cache-key 测试通过。
- `git diff --check`：通过，仅有现有 Windows CRLF 转换提示。
