# fix stats context limit

## Goal

修复会话/终端统计面板中“模型与上下文”卡片无法正确读取或展示模型上下文上限的问题。目标是用最小改动让上下文上限优先使用历史日志里的精确窗口值，缺失时按已知模型映射稳定回退。

## What I already know

* 统计卡片实现位于 `src/components/stats/termStatsCards.tsx`，`ModelContextCard` 读取 `session.usage.context_window`，再回退到 `getContextLimit(stats.dominantModel)`。
* 模型上下文上限映射位于 `src/lib/modelPricing.ts` 的 `MODEL_CONTEXT_LIMITS` 和 `getContextLimit`。
* 后端 `src-tauri/src/commands/history.rs` 已从 Codex `token_count` 事件读取 `payload.info.model_context_window` 到 `context_window`，并读取最近上下文占用到 `last_context_tokens`。
* 前端 `src/stores/historyStore.ts` 已兼容 `context_window/contextWindow` 和 `last_context_tokens/lastContextTokens`。
* 当前 `MODEL_CONTEXT_LIMITS` 把 Claude Fable 5 / Opus 4.8 / Opus 4.7 / Opus 4.6 / Sonnet 4.6 都写成了 `200_000`，与当前 Claude API 文档/模型目录不一致；这些模型当前为 1M 上下文，Haiku 4.5 为 200K。
* `getContextLimit` 当前只处理 `[1m]`、`us.anthropic.com/`、`anthropic.` 和日期后缀前缀匹配；对运行时模型名附加展示后缀的情况不够稳健。

## Assumptions (temporary)

* 不新增在线查询模型 API；CLI-Manager 是本地桌面应用，统计面板应离线可用。
* 不为无法确认的非 Claude 模型硬编码上下文上限，避免猜测。
* 若日志提供精确 `context_window`，它优先于静态映射。

## Requirements

* 统计面板能正确显示当前已知 Claude 模型的上下文上限。
* 保留 Codex `model_context_window` 事件提供精确窗口的优先级。
* 未知模型仍显示 `—`，不猜测。
* 不引入依赖，不改 Tauri capability，不改后端 IPC 结构。

## Acceptance Criteria

* [ ] `claude-fable-5`、`claude-opus-4-8`、`claude-opus-4-7`、`claude-opus-4-6`、`claude-sonnet-4-6` 的上下文上限显示为 `1.0M`。
* [ ] `claude-haiku-4-5` 的上下文上限仍显示为 `200.0K`。
* [ ] 带 `anthropic.` / `us.anthropic.com/` / `[1m]` / 日期后缀的模型名仍能识别。
* [ ] 无法确认的模型不显示伪造上限。
* [ ] TypeScript 构建或类型检查通过。

## Definition of Done

* 最小代码改动完成。
* 运行项目既有 TypeScript 检查或构建命令。
* 如只改前端静态映射，不启动桌面 UI；运行态 UI 由用户人工验收。

## Out of Scope

* 不接入 Anthropic Models API 实时拉取模型能力。
* 不维护完整第三方模型上下文窗口数据库。
* 不调整统计面板视觉布局。
* 不修改历史日志解析结构，除非后续确认真实日志字段不是 `model_context_window`。

## Technical Notes

* 相关文件：
  * `src/lib/modelPricing.ts`
  * `src/components/stats/termStatsCards.tsx`
  * `src/stores/historyStore.ts`
  * `src-tauri/src/commands/history.rs`
* 当前可靠模型上下文信息（来自本地 Claude API skill 缓存文档）：
  * Claude Fable 5：1M
  * Claude Opus 4.8 / 4.7 / 4.6：1M
  * Claude Sonnet 4.6：1M
  * Claude Haiku 4.5：200K
* 风险：静态映射会随供应商模型变化而过期；本任务只修正当前已知模型，不做在线能力发现。
