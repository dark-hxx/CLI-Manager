# 修复路由重试与历史统计审查问题 — 技术设计

## 1. 修复边界

本任务在现有路由故障切换和历史统计优化补丁上修正一致性缺口，不改变命令名、数据库表结构、供应商顺序、统计口径和 SSH 刷新语义。

## 2. 发现清单

- `src-tauri/src/daemon/route_http.rs::forward_request`：全局预算在供应商外层递增；同一供应商的 key 与整流循环可多次 send。直接调用方 `handle_request`，GitNexus 风险 LOW。
- `src-tauri/src/lib.rs::migrations`：v31 创建路径索引并重建视图，但没有填充旧 `project_path`；需要独立 v32，才能覆盖已经执行 v31 的数据库。启动 `run` 和迁移测试受影响，风险 LOW。
- `src-tauri/src/usage_schema.rs::ensure_usage_schema`：运行时会重放 v31 usage schema SQL；v32 回填依赖 `projects` 表，因此只注册为应用数据库迁移，不加入 usage-only schema 重放。
- `src-tauri/src/commands/history/request_logs.rs`：parser v3 从 session cwd 写入新路径；项目过滤必须保持纯 SQLite 读取，不得恢复读时目录扫描。
- `src/stores/historyStore.ts::syncHistoryRequestLogs`：共享 single-flight 被启动/定时、统计、请求日志和会话/终端统计调用；GitNexus 风险 HIGH。
- `src/components/stats/RequestLogsView.tsx::RequestLogsView`：显式刷新调用 `force=false`，现有错误区域可复用。
- `src/components/stats/StatsPanel.tsx::StatsPanel`：本地刷新吞掉同步错误并在 `finally` 中 refetch；需要独立同步错误状态。
- `src/lib/i18n.ts`：新增统计同步失败文案必须同步中文与英文。
- `src-tauri/src/usage.rs`：现有定向 route attribution 已复制 `project_path`；本任务只验证迁移回填后的 route 传播，不改其匹配语义。
- `src/App.tsx`：启动与 60 秒定时同步已统一调用 store；确认无需修改。
- `src/components/history/SessionStatsPanel.tsx`、`src/components/terminal/TerminalStatsPanel.tsx`：属于 HIGH 影响范围，但只通过兼容签名间接受影响，确认无需修改。

## 3. 路由 attempt 状态机

将 attempt 分配移动到每次 `.send()` 之前：

1. 发送前检查全局预算；预算耗尽时不再选择下一 key/供应商。
2. 分配唯一 `attempt_index`，再执行 HTTP send。
3. transport/timeout、整流后重试、可重试 key 状态和 provider 状态失败，都用该 index 写独立失败事实。
4. 最终响应携带其真实 attempt index，用于成功 usage record 的 `request_id`、`attempt_count` 和 `degraded`。
5. circuit/cooldown/endpoint invalid 等 send 前 skip 保持当前 candidate cursor 语义，attempt 数不变。

为避免同一失败被重复记录，outcome 携带最后一次 send 的 index；key 已在切换时记录后，provider 退出分支只更新 terminal/circuit 状态，不再生成第二条虚假 attempt。

## 4. 旧项目路径回填

独立 v32 SQL 在 v31 索引/视图之后执行幂等回填：

- 已有非空 `project_path` 永不覆盖。
- `project_key` 本身为 Windows、WSL、UNC 或 POSIX 绝对路径时，规范化斜杠、末尾分隔符和大小写后直接物化。
- 非绝对 key 只在 `projects` 中能找到唯一的本地/WSL项目（项目名或路径 basename 与 key 相符）时采用该配置路径；歧义时不任意选择。
- session-log 行回填后，同 `(source, session_id)` 的 route 行复制该 materialized path。
- 查询端对剩余 `NULL` 行保留受限 legacy key 兼容；不得调用历史索引或源目录扫描。

v32 不由 `ensure_usage_schema` 重放，避免 usage-only 测试库缺少 `projects` 表；所有 UPDATE 仍限定空路径并保持可重复执行。测试覆盖二次执行和源路径不可访问的纯数据库场景。

## 5. 缓存失效与刷新调度

- 请求日志列表和请求日志统计仍只在 `changed_files/removed_files/written_rows` 非零时失效。
- 每次成功的后台 history sync 都失效 `historyStats`；即使只变更非 `REQUEST_LOG_SOURCES`，下一次统计读取也会基于新 generation。后端 aggregation cache 继续用 generation key 保证无变化时读取轻量。
- `RequestLogsView` 和本地 `StatsPanel` 使用 `syncHistoryRequestLogs(true)`。若后台扫描已持有后端 mutex，新调用在其后排队并执行点击后的 force scan。
- SSH 统计继续使用现有远端 manual nonce/force 分支，不进入本地同步。

## 6. 错误状态

`StatsPanel` 增加仅表示本地同步失败的状态：

- 点击前清除旧错误并开始 spinner。
- 同步失败：记录诊断、保留 query data 与 `dataUpdatedAt`、显示本地化 warning，不调用 refetch。
- 同步成功：再并行 refetch overview/request stats；查询自己的失败继续由 TanStack Query 错误状态负责。
- 下次成功刷新清除同步错误。

## 7. 兼容与回滚

- 前端 `syncHistoryRequestLogs` 签名不变，HIGH 风险调用方无需迁移。
- 数据库变更只更新可恢复的空字段，不删行、不改 token 值。
- 回滚前端刷新/错误处理不会破坏数据库；v32 已填充路径可安全保留。

## 8. 验证策略

- Rust：route attempt/budget helper 或本地测试服务回归；v32 内存 SQLite 迁移回填与幂等；现有 request-log filter/attribution tests。
- 前端：类型检查与生产构建；通过可测试 helper/静态断言覆盖 invalidation 和两处 `force=true` 调用。
- 综合：`cargo fmt --all -- --check`、相关 `cargo test`、`cargo check`、`npx tsc --noEmit`、`npm run build`、`git diff --check`、GitNexus detect changes。
- 人工：桌面端中英文统计面板同步失败提示、后台扫描中点击刷新、旧数据库项目过滤。
