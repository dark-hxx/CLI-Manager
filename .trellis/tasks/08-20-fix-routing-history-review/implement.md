# 修复路由重试与历史统计审查问题 — 实施计划

## 前置约束

- `master` 与 `origin/master` 同步；工作区已有其他任务的未提交修改，不覆盖或回退无关内容。
- `syncHistoryRequestLogs` upstream impact 为 HIGH，已向用户告警；保持现有函数签名。
- 每个新增待编辑 symbol 在修改前补做 GitNexus impact；若出现新的 HIGH/CRITICAL，先告警。
- Changelog 版本：`TEMP`。

## Phase A — 路由真实 attempt 计数

- [ ] 重构 `forward_request`，在每次 HTTP send 前分配 attempt index 并检查全局预算。
- [ ] 为 key 重试、整流重试、transport/provider 失败写独立失败记录，避免 provider 退出时重复记录。
- [ ] 让最终 response 携带真实 attempt index，保持成功 usage、degraded、circuit 和 hot-switch 语义。
- [ ] 增加多 key、预算耗尽、预发送 skip 与最终成功/失败回归测试。

## Phase B — v32 旧项目路径回填

- [ ] 新增 v32 后续迁移，先回填绝对 project key 和唯一配置项目映射，再传播到 route 行，确保已执行 v31 的数据库也会升级。
- [ ] 保持 SQL 幂等，不覆盖已有路径，不删除旧记录；不把依赖 `projects` 表的回填加入 `ensure_usage_schema` 重放。
- [ ] 为仍不可恢复的空路径行加入受限 legacy key 兼容过滤，不恢复读时历史扫描。
- [ ] 增加内存 SQLite 迁移、重复执行、歧义项目和 route 传播测试。

## Phase C — invalidation、显式刷新和错误状态

- [ ] 调整 store：成功 sync 始终失效 `historyStats`，只有请求日志行变化时失效请求日志 Query。
- [ ] 将 `RequestLogsView` 与本地 `StatsPanel` 显式刷新改为 `force=true`，验证后台扫描重叠时排队。
- [ ] `StatsPanel` 同步失败时不 refetch、不更新时间，保留旧数据并显示错误。
- [ ] 在 `src/lib/i18n.ts` 同步增加 `zh-CN`/`en-US` 文案。

## Phase D — 契约、交付记录与验证

- [ ] 更新 `.trellis/spec/backend/history-stats-contracts.md` 的 attempt、迁移、invalidation、显式刷新和错误展示契约。
- [ ] 更新 `CHANGELOG.md` `[TEMP]` 与 `docs/功能清单.md` 对应功能板块。
- [ ] 运行针对性 Rust tests、`cargo fmt --all -- --check`、`cargo check`。
- [ ] 运行 `npx tsc --noEmit`、`npm run build`、`git diff --check`。
- [ ] 运行 `gitnexus_detect_changes(scope="all")` 并核对仅命中预期流程。

## Review Gates

- 真实 send 数永不超过 `max_provider_attempts`，失败记录数与失败 send 数一致。
- 预发送 skip 不消耗 attempt 或触发 circuit failure。
- 旧记录在纯 SQLite 路径过滤下可见，且已有 materialized path 不被迁移覆盖。
- 非请求日志来源变化能刷新历史统计；无日志行变化不会无条件刷新请求日志页面。
- 点击刷新不会加入旧扫描；同步失败不会显示为成功刷新。

## Rollback Points

- A 可独立回滚到旧 route loop，不影响数据库。
- B 的已填充路径可安全保留；查询 fallback 可单独回滚。
- C 可分别回滚 invalidation、force 刷新和 UI 错误状态，函数签名不变。
