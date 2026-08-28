# 重构历史用量与请求日志加载链路 — 技术设计

## 1. 设计目标

把交互式读取改成“读取已持久化数据”，把历史文件枚举、解析、请求日志入库和路由归因改成后台维护工作。保持现有 Tauri 命令参数、返回 payload、统计口径、跨来源去重与会话跳转行为。

非目标：本次不删除明细、不做日汇总 retention、不更换数据库或新增依赖。

## 2. 当前根因与触点

### 根因

维护型工作被同步耦合到读取边界：前端分页/统计查询先等待 `history_sync_request_logs`，后端项目路径过滤与 `history_get_stats` 又会刷新历史文件索引，因此缓存命中前仍可能递归枚举所有文件。

### 发现清单

- `src/components/stats/RequestLogsView.tsx`：日志分页 `queryFn` 先同步；手动刷新也复用同步命令。
- `src/components/stats/StatsPanel.tsx`：概览同时读取历史统计与请求统计，手动 nonce 会向后端发送 `force=true`。
- `src/stores/historyStore.ts`：请求日志统计、今日项目统计都会先同步；现有前端 Promise 只覆盖部分调用方。
- `src/App.tsx`：启动后立即同步并每 60 秒轮询，是现成的后台维护入口，但当前绕过共享前端同步函数，也没有按数据变化失效 Query。
- `src-tauri/src/commands/history/request_logs.rs`：全量文件枚举、入库、项目路径解析、分页/汇总与源文件存在性检查。
- `src-tauri/src/commands/history.rs`：`history_get_stats` 在缓存查找前刷新索引；默认包含 OpenCode 时禁用聚合缓存。
- `src-tauri/src/usage.rs`：全量路由归因当前由每次请求日志同步无条件调用；该文件存在另一任务的未提交修改，实施时只做最小上下文补丁。
- `src-tauri/src/lib.rs`：若持久化请求日志项目路径，需要追加迁移并扩展统一视图字段。
- `.trellis/spec/backend/history-stats-contracts.md`：统计、去重、缓存和归因行为契约。

GitNexus 预改动 impact：`history_sync_request_logs` LOW、`list_request_logs_with_connection` LOW、`reconcile_route_attribution` LOW、`fetchHistoryRequestLogStats` LOW、`RequestLogsView` LOW；`history_get_stats` 与 `refresh_history_index_snapshot` 未被索引识别，已用契约和源码追踪回退。没有 HIGH/CRITICAL 结果。

## 3. 目标数据流

```text
应用启动/60 秒定时/手动刷新
    -> 单飞历史同步
    -> 增量写入 request_logs + usage_records
    -> 针对变更 session 做路由归因
    -> generation/变更结果
    -> 失效 TanStack Query

页面打开/筛选/翻页
    -> 直接查询 SQLite / 聚合缓存
    -> 返回当前已持久化结果
    -> 不等待文件扫描或全量归因
```

## 4. 请求日志读取与同步解耦

### 4.1 前端调用边界

- 从 `RequestLogsView` 分页 `queryFn`、`fetchHistoryRequestLogStats`、`fetchTodayProjectStats` 移除隐式同步。
- `syncHistoryRequestLogs` 成为唯一前端同步入口；`App` 的启动和定时任务也调用它，复用现有 Promise 单飞。
- 同步结果只有在 `changed_files > 0`、`removed_files > 0`、`written_rows > 0` 或归因有变化时才失效 `historyRequestLogs`、`historyRequestLogStats`、`historyStats` 查询，避免无变化时每分钟重算。
- 请求日志手动刷新等待一次增量同步，成功后回到第一页并刷新；同步失败保留已有 query data，只显示现有错误状态。
- 统计面板本地手动刷新先执行一次强制同步，再用 `force=false` 读取新 generation，避免同步完成后 `history_get_stats(force=true)` 再扫描一次。SSH 分支保留现有远端 force 语义。

### 4.2 后端单飞与结果

- 保留后端 `AsyncMutex`，防止绕过前端的多个 WebView/命令调用并发写库。
- 锁内记录 roots key 与最近完成结果；非 force 的等价请求在很短的合并窗口内复用结果，避免等待前一个任务后又立即重复扫描。force 请求不被旧结果吞掉。
- `RequestLogSyncResult` 保持现有 IPC 结构；前端以 `changed_files`、`removed_files`、`written_rows` 判断本次历史同步是否产生数据变化。

## 5. 项目路径筛选去扫描化

仅移除前端同步仍不够：当前 `history_list_request_logs` 和请求统计会为 `project_path` 调用 `refresh_history_index_snapshot`。

设计：

1. 在请求日志同步时，从已解析 session 的 cwd/项目元数据生成规范化 `project_path`；OpenCode 使用 catalog cwd。
2. 将 session-log 的 `project_path` 写入 `usage_records`，统一视图暴露该字段；必要时给 `request_logs` 增加同字段以保持调试和迁移可观测性。
3. bump `REQUEST_LOG_PARSER_VERSION`，让后台增量同步对旧行执行一次非阻塞回填。
4. 查询时将目标 Windows、WSL 与 UNC 路径扩展成规范化候选，用 `project_path = target OR project_path LIKE target/%` 过滤；Claude 无 cwd 的兼容行继续使用派生 project key 匹配。
5. 删除读取路径中的 `resolve_request_log_project_paths -> refresh_history_index_snapshot`，不再构造大 `file_path IN (...)`。

迁移只新增字段/索引并重建视图，不删除数据。若应用在回填完成前查询，已有 project key 兼容匹配继续工作；后台同步完成后自动失效并得到完整结果。

## 6. 路由归因调度

- 从 `history_sync_request_logs` 尾部移除无条件全量 `reconcile_route_attribution()` 等待。
- session 文档写入后，仅对该文档的 `(source, session_id)` 更新 pending route 行。
- route usage 写入后，若相同 session 已存在请求日志，则在同一写入流程中做定向归因；不存在则保持 pending。
- 旧 pending 行由单飞后台 repair 批任务处理，失败记录 warning 并在下个维护周期重试，不阻断日志读取或清空已有数据。
- 定向和批量路径复用同一匹配规则：规范化 source + 非空 session id，复制 `project_key`、`project_path`、`file_path`，SQL 错误不得伪装成成功。

## 7. 历史统计快照与缓存

### 7.1 快速快照

- 新增只读快照获取：优先当前内存索引，其次 `history-index-cache.json`；非 force 统计读取不递归扫描文件系统。
- 后台同步/索引刷新仍使用现有 fingerprint 增量扫描并更新内存与持久化 generation。
- force 只用于明确的维护动作；页面普通读取一律使用当前快照。

### 7.2 全来源缓存

- 聚合 cache key 扩展为：roots、来源、项目/路径、时间范围、source instance、本地 index generation、OpenCode DB fingerprint/catalog generation、route usage generation。
- 取消 `include_opencode` 禁止缓存的分支；OpenCode fingerprint/generation 变化自然产生新 key。
- 继续使用有界 LRU/最旧淘汰，避免响应对象无限驻留。
- 首次没有聚合缓存时从持久化索引快照构建；相同 generation 的后续请求直接命中聚合缓存。
- 后台刷新发现 generation 变化后失效活跃 Query；失败保留最后一次成功数据。

## 8. IPC、兼容与失败策略

- 现有命令名和必需参数不变；新增返回字段必须可选/有默认值，前端 normalizer 接受旧 payload。
- 数据库迁移为追加式；不清表、不删除旧明细，视图重建保持现有去重 WHERE 逻辑。
- 历史源目录不可访问时，不清理该 source 的旧行；沿用 `available_cleanup_sources` 防误删。
- 后台同步失败不使页面查询失败；只有显式手动刷新显示同步错误。
- 文件在扫描中新增/删除由下一周期收敛；同步写入继续按单文件事务，失败文件不会破坏其他文件。
- WSL/UNC 只在后台解析/规范化，分页读取不得发起 `wsl.exe` 或访问 UNC 文件。

## 9. 性能与可观测性

- 保留/补充结构化耗时：同步扫描、变更写入、定向归因、分页 SQL、统计 cache hit/miss、快照来源。
- 在改造前后用同一 462 MB 本地数据库记录：请求日志第一页、同筛选重复请求、翻页、全部来源统计首次/重复请求。
- 验收重点是执行路径：分页和普通统计读取无目录扫描/全量归因；重复统计命中 generation cache。具体毫秒值作为对比记录，不设依赖机器的硬编码阈值。

## 10. 测试策略

- Rust：同步单飞/增量/删除保护、项目路径 SQL 过滤、定向归因、默认全部来源缓存、OpenCode fingerprint 失效、持久化快照冷启动、固定数据集结果等价。
- 前端：纯读取函数不调用同步；后台同步仅在数据变化时失效相关 query；手动刷新等待一次同步且不二次 force 扫描。
- 静态验证：`npx tsc --noEmit`、相关 Rust tests、`cargo check`。
- 人工桌面验证：中英文请求日志/统计页面；首次打开、筛选、翻页、刷新、源目录暂不可访问、WSL 项目路径。

## 11. 回滚

- 前端可恢复为读取前同步，不影响数据库兼容。
- 新增列/索引保留无害；回滚代码无需删除用户数据。
- 若快照策略发现一致性问题，可让 `history_get_stats` 临时恢复同步 refresh，同时保留全来源 cache key 和后台同步改造。
