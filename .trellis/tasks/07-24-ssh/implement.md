# Implementation Plan

## 1. Pre-development

- [x] 加载 `trellis-before-dev`，读取 backend/frontend index 与 history/SSH contracts。
- [x] 执行 repo update check，保留用户已有变更。
- [x] 对计划修改的符号执行 GitNexus impact；若 MCP 不可用，记录降级并用 contracts + `rg` 完成 discovery list。

## 2. SSH Agent index fast path

- [ ] 扩展 `HistoryScopeRequest` 的 `forceRefresh` 输入并保持 serde 默认兼容。
- [ ] 在 writer lock 前加载兼容索引，满足覆盖条件时直接分页返回。
- [ ] force/no-cache/scope-expansion 才进入扫描路径；扫描后仅 changed 时刷新摘要并写索引。
- [ ] 发现文件按最近修改时间优先，同时保留完整发现/tombstone 语义。
- [ ] 补充 cache-page、force refresh、scope expansion、unchanged no-write 和 recent-first 测试。

## 3. Desktop request coordination

- [ ] 在 remote payload 中传递 `forceRefresh`。
- [ ] 修正 single-flight key，排除 consumerId，保留所有影响结果的输入。
- [ ] cached reopen 先展示本地列表并后台强制刷新；首次打开等待首批结果。
- [ ] load-more 使用非强制 cache page；manual refresh 使用 force。
- [ ] 保持 stale request guard 与 remote close 生命周期。

## 4. SQLite write governance

- [ ] 新增 Rust SSH history metadata persistence request/validator/command。
- [ ] 使用 busy timeout + `BEGIN IMMEDIATE` 幂等更新或插入 integration。
- [ ] 前端 `recordHistorySource` 改为 invoke，不再通过 plugin-sql 直接写表。
- [ ] catalog mutation 前置校验/序列化并映射 `history_catalog_busy`。
- [x] catalog 身份合并允许同一稳定来源轮换 Agent `installationId`，并保留 machine/user/source/config-root 的拒绝覆盖校验。
- [x] Desktop 普通 `historyGet` 将缺失的 `remoteTranscriptRef` 编码为 `""` 而不是 JSON `null`，并补充 Agent 0.1.3 兼容回归测试。
- [ ] 补充 metadata update/insert/rollback/busy 与 catalog error mapping 测试。

## 5. Validation

- [x] 运行 SSH Agent/history 定向测试。
- [x] 运行 Desktop history/SSH integration 定向测试。
- [x] 运行 `cd src-tauri && cargo check`。
- [x] 运行 `npx tsc --noEmit`。
- [x] 不运行 build/dev 命令，除非用户另行要求。

## 6. Delivery

- [x] 更新 `CHANGELOG.md` 的 `V1.3.1`。
- [x] 更新 `docs/功能清单.md` 的远程历史能力说明。
- [x] 运行 `detect_changes`；GitNexus 不可用时用 `git diff --check`、`git diff --stat`、定向 diff 审查替代并说明。
- [x] 加载 `trellis-check` 完成规范、类型、测试与跨层数据流检查。
