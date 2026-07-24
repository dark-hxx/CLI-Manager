# Technical Design

## Architecture

保持现有三层边界，不引入新存储：

1. SSH Agent 继续维护每个 `(source, configRootHash)` 的原子发布 `index.json`。
2. Desktop `history-catalog.db` 继续缓存远端 summary/usage。
3. 主库 `cli-manager.db` 继续保存 SSH integration 与 `history_source_instance_id`。

优化点仅是拆分“读已发布索引”和“刷新索引”，并把主库写入收回 Rust 持久化边界。

## Data Flow

### Cached page

`historyStore` → `history_remote_sync(forceRefresh=false, cursor)` → Agent load/validate `index.json` → 直接切页 → Desktop catalog apply → Rust integration metadata persistence。

当索引已覆盖请求作用域时，该路径不获取 Agent writer lock、不发现文件、不写 `index.json`。

### Refresh

`historyStore` → `history_remote_sync(forceRefresh=true)` → Agent writer lock → recent-first discovery → fingerprint/append-aware parse → changed-only publish → Desktop catalog short transaction → Rust integration metadata short transaction。

### Cached reopen

Desktop 已知 `sourceInstanceId` 时先从本地 catalog 渲染；远端强制刷新在后台运行，成功后更新 context 和列表。无本地 identity 时仍同步等待首批结果。

## Contracts

- 在 Agent `HistoryScopeRequest` 增加 serde-default 的 `force_refresh: bool`。旧 Desktop 缺字段时保持 `false`；旧 Agent 会忽略新字段，Desktop 仍能工作但没有快路径收益。
- cache fast path 仅在索引兼容、非空且 `request.project_paths` 全部包含在 `index.project_paths` 时启用。
- cursor 仍为 `generation:offset`；generation 不匹配时 offset 归零。
- force refresh 无变化时返回相同 generation；只更新响应 `asOf` 不要求发布相同内容的新文件。
- single-flight key 不包含 `consumerId`，但包含稳定 SSH host identity、source、root、排序后的 project paths、cursor、limit、forceRefresh。首个请求的 bridge consumer 承担 RPC 生命周期。
- 主库历史 identity 持久化新增独立 Tauri command，校验 host/source/scope/identity/root，使用现有 app data DB 路径和错误映射风格。
- catalog busy 错误映射为 `history_catalog_busy`；主库 integration busy 映射为 `ssh_agent_history_metadata_busy`。
- Agent `installationId` 只校验当前 launch/bridge 响应，不进入稳定 `sourceInstanceId`。catalog 已存在同一 source instance 时仅将 machine/user/config-root 视为不可变来源身份，Host 绑定与 `installationId` 可在事务内轮换并写回最新值。
- Desktop `historyGet` payload 将可选的 `remoteTranscriptRef` 规范化为字符串；`None` 编码为 `""`，避免已发布 Agent `0.1.3` 的 `String` 字段在 serde 入口拒绝 JSON `null`。

## Transaction Boundaries

- Agent writer lock 只覆盖真实 refresh，不覆盖 cache page。
- catalog 在 transaction 前验证全部 summary identity、数字范围和 JSON 序列化；transaction 内只做 compare-and-apply 与 SQL mutation。
- main DB command 使用 `BEGIN IMMEDIATE`，一次 SELECT + UPDATE/INSERT，立即 commit。
- 不用全局 SSH mutex，不复用本地 `CATALOG_REFRESH_LOCK` 包裹远端 RPC。

## Compatibility

- 不改 schema、表名或已有 command 签名；新增字段有默认值，新增 command 只替换前端内部写入。
- 详情协议修复由 Desktop 发送 Agent `0.1.3` 已接受的空字符串，不要求用户先升级远端 Agent。
- 已发布索引格式尽量保持兼容；若为 recent-first 增加 entry 字段，必须带 serde default 并维持 schema version，或确认旧索引可安全重建后再升级共享 schema version。
- 远端断开或新 Agent 不可用时，本地 catalog 仍提供缓存 summary。

## Trade-offs

- 继续使用 JSON 索引意味着真实变化时仍需原子重写整份文件；本任务消除无变化与翻页写放大，不引入 Agent 侧 SQLite 的复杂度。
- 后台刷新可能使缓存列表短暂陈旧，但打开速度不再被远端扫描阻塞；手动刷新仍提供强一致的用户操作。

## Rollback

- Agent 快路径可独立回退到现有每次扫描逻辑，不影响索引格式。
- 前端后台刷新可恢复为 await；Rust metadata command 可保留且不影响旧路径。
- 无 migration，回滚不需要数据修复。
