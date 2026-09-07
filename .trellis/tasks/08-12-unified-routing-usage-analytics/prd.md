# 统一路由真实用量与历史统计

## Changelog Target

`[TEMP]`

## Goal

当供应商路由开启时，从上游响应（包括流式响应）采集真实 Token、实际供应商和实际出站模型；路由日志缺失或没有 usage 时回退到本地会话日志。历史用量分析、请求日志和今日项目用量必须使用统一去重后的统计口径。费用按当前 `model_prices` 实时计算。

## Requirements

- 路由支持 Claude、Codex、Grok 当前已实现的非流式和流式 usage 采集。
- 路由记录保存 requested/outbound/response model、provider、状态、耗时、重试/降级、session id 和 usage 状态。
- 本地五类历史来源继续增量同步到现有 `request_logs`，并参与统一去重统计。
- 路由 usage 优先；有效路由 usage 与会话日志重复时只统计一次；路由 usage 缺失时允许会话日志补齐。
- 路由记录通过 session id 与历史会话索引异步补全项目/worktree 归属，无法确认时进入未归属桶。
- 现有历史统计和请求日志 IPC 保持兼容，内部改为统一用量查询；今日项目用量使用同一口径。
- 费用查询时使用当前 `model_prices`，未知模型计入 `unpriced_tokens`，不能静默视为免费。
- 路由数据库写入失败不能阻断上游响应，必须记录可诊断错误。
- 新增 UI 字段和文案兼容 `zh-CN`/`en-US`，英文时间仍使用 24 小时制。
- 不改外部 `ccusage` 分支；不扩展当前原生路由未覆盖的 Gemini/OpenCode 协议。

## Acceptance Criteria

- [ ] 路由非流式成功响应可持久化有效 usage、provider 和 outbound model。
- [ ] 路由 Claude/Codex/Grok 流式正常结束可持久化 usage，异常中断不伪造 Token。
- [ ] 多 provider failover 不重复统计有效 usage，实际产生 usage 的 attempt 均可追踪。
- [ ] 路由和本地会话日志重复时仅保留一份 Token 统计；路由 usage 缺失时会话日志可补齐。
- [ ] 路由记录能在会话同步后补全项目/Worktree；无法补全的数据进入未归属统计。
- [ ] 历史分析、请求日志、今日项目用量的 Token、模型、来源和费用结果一致。
- [ ] 修改当前模型价格后历史费用查询结果实时变化；未知模型显示未定价 Token。
- [ ] 历史请求日志展示 Route/Session fallback、provider、实际模型、usage 状态和归属状态。
- [ ] 通过 Rust 单元/集成测试、`cargo check`、`npx tsc --noEmit` 和 Trellis 质量检查。
- [ ] 更新 `CHANGELOG.md` `[TEMP]` 与 `docs/功能清单.md`；不提交 Git commit。

## Definition of Done

- 代码、数据库迁移、IPC 返回类型、前端归一化和界面展示完成。
- 覆盖窗口/分屏/托盘、多会话、PowerShell/CMD/WSL、Worktree、hook 缺失、流式/非流式、failover、价格缺失等场景。
- 旧 `request_logs` 数据可继续读取，迁移/回填幂等。

## Technical Approach

- 新增主库 `usage_records` 作为统一事实表；保留 `request_logs` 作为本地历史原始同步表，保留 provider DB 中 `routing_request_logs` 作为兼容/诊断表。
- 新增 Rust `usage` 模块负责路由记录、协议解析、会话导入、去重、归属和查询；避免 `history.rs`、`request_logs.rs`、路由 daemon 各自实现统计口径。
- 费用不固化，查询时调用现有 `model_pricing::find_cached_model_pricing`；计费模型优先 outbound、其次 response、最后 requested。
- 路由 daemon 通过 `app_paths::db_path()` 写主库，写入异步失败只影响日志，不影响响应。

## Scenario Matrix

- 窗口焦点：当前/其他/失焦；最小化/托盘恢复。
- 分屏与会话：单会话、多会话、Workspan 切换、并发请求。
- 运行时：PowerShell/CMD/Pwsh、WSL/Bash。
- 路径：主项目、Worktree、父子路径、目录缺失。
- Hook：Claude/Codex 均安装、仅一方、均未安装。
- 路由：开启/关闭、usage logging 开启/关闭、流式/非流式、模型映射、failover、响应缺失 usage。
- 来源：Claude/Codex/Grok 路由；Gemini/OpenCode 保持本地日志统计。

## Out of Scope

- 供应商官方账单 API 或账单校准。
- 为 Gemini/OpenCode 新增原生 HTTP 路由协议。
- SSH 远程进程直接接入本地路由日志；远程历史继续使用已有 remote history 链路。
- 外部 `ccusage` 分支。
