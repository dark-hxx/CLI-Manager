# 修复 Codex 会话历史 sub-agent 层级显示

## Goal

修复历史会话列表无法展示 Codex 主会话与 sub-agent 父子层级的问题，同时保持 Claude 现有路径推断兼容。

## Changelog Target

`[TEMP]`

## Requirements

- 后端识别 Codex `session_meta.payload.parent_thread_id`，必要时兼容 `forked_from_id` 与嵌套的 `source.subagent.thread_spawn.parent_thread_id`。
- 历史会话摘要向前端传递统一的父会话 ID字段。
- 前端层级构建优先使用统一父会话字段，Claude 旧的 `subagents/agent-*.jsonl` 路径规则继续兼容。
- 父会话缺失、跨项目或父 ID自引用时，不应错误建立层级。
- 补充 Rust 与前端测试，覆盖 Codex 主会话、两个 Codex 子会话以及 Claude 回归场景。

## Acceptance Criteria

- [x] 会话 `019feede-e644-7e63-8b89-f23d11472eca` 显示为父会话。
- [x] 会话 `019feedf-570e-75d3-99e2-cb42c7cb98d5` 和 `019feedf-580e-7483-910c-a4279427b241` 显示为该父会话的子会话。
- [x] Claude 的 `subagents/agent-*.jsonl` 层级显示不回归。
- [x] 父会话不存在、项目不同或元数据不完整时，列表保持平级且不崩溃。
- [x] 前端类型检查与 Rust 测试通过。

## Definition of Done

- [x] 根因修复落在历史解析/数据契约层，不在 UI 增加针对单个会话的兜底。
- [x] 更新 `CHANGELOG.md` 的 `[TEMP]` 条目。
- [x] 更新 `docs/功能清单.md`（如该项目约定要求产品功能变更记录）。
- [ ] 完成 GitNexus 变更影响检查（索引状态 stale，CLI 无 detect-changes 子命令；已用源码范围检查替代）。

## Technical Approach

当前根因是 Codex 子会话文件位于 `sessions/.../rollout-*.jsonl`，文件中已有 `parent_thread_id`，但后端只提取 `payload.id`，前端只根据 Claude 的 `subagents/agent-*.jsonl` 路径推断父级。增加统一的 `parent_session_id` 摘要字段并贯通后端扫描、缓存/目录索引与前端 `HistorySessionView`，树构建使用该字段并保留 Claude 路径兼容。

## Out of Scope

- 不改变 Codex 原始 JSONL 文件格式。
- 不重构现有历史目录扫描或删除逻辑。
- 不新增多级树 UI；本次仅修复已有父子层级能力的数据来源。

## Technical Notes

- 相关文件：`src-tauri/src/commands/history.rs`、`src-tauri/src/commands/history/catalog.rs`、`src/lib/types.ts`、`src/lib/historySubagents.ts`、`src/components/history/historyViewUtils.tsx`。
- 三个测试会话的 Codex 子文件含 `forked_from_id`、`parent_thread_id` 和 `source.subagent.thread_spawn.parent_thread_id`，父值均为 `019feede-e644-7e63-8b89-f23d11472eca`。
