# 修复 Codex 实时统计上下文显示

## Goal

修复终端右侧实时统计面板在 Codex 会话中的两个问题：Token 趋势缺少可用数据，模型上下文的当前上下文可能读取到同项目另一个 Codex 窗口。

## What I already know

* 实时统计面板入口是 `src/components/terminal/TerminalStatsPanel.tsx`。
* 面板当前通过 `projectPath + source` 调用 `fetchLatestProjectSessionDetail`，取该项目最近一条历史会话。
* 同项目打开多个 Codex 终端时，“最近一条历史会话”可能属于另一个窗口。
* Codex hook payload 包含 `sessionId`，并且 Codex 日志文件名 `rollout-...<uuid>.jsonl` 包含同一个会话 ID。
* Codex 的 token 用量来自后端扫描 `token_count` 事件；当前只汇总到会话级 usage，没有暴露每次增量趋势点。

## Requirements

* 实时统计面板应优先绑定当前终端对应的 Codex/Claude CLI 会话 ID，而不是只按项目取最新会话。
* 未获得 CLI 会话 ID 时保持现有项目级回退逻辑，避免禁用无 hook 环境的统计。
* Codex 会话应能在 Token 趋势卡片中显示由后端扫描得到的 token 增量趋势。
* 无趋势点时卡片必须显示明确空态，不出现空白或误导性图表。

## Acceptance Criteria

* [ ] 同一项目多个 Codex 终端并行时，收到 hook sessionId 后实时统计显示当前终端对应日志。
* [ ] Codex `token_count` 事件产生的多次增量能出现在 Token 趋势卡片。
* [ ] 只有 0 或 1 个趋势点时显示明确空态/单点说明。
* [ ] 前端类型检查通过。
* [ ] Rust 编译检查或相关测试通过。

## Definition of Done

* Tests added/updated where practical.
* `npx tsc --noEmit` passes.
* Rust check/tests run for touched backend code.
* No unrelated refactor.

## Out of Scope

* 不重做历史分析看板。
* 不新增依赖。
* 不改 Codex/Claude hook 安装配置格式。

## Technical Notes

* `src/components/terminal/TerminalStatsPanel.tsx` 当前取 `activeSessionId` 对应终端会话，再按项目路径轮询最新历史会话。
* `src/stores/terminalStore.ts` 的 `handleCliHookEvent` 接收 `payload.sessionId`，但没有写入 `TerminalSession`。
* `src/stores/historyStore.ts` 的 `fetchLatestProjectSessionDetail` 可通过 `history_list_sessions` 的 `query` 参数搜索 `session_id`。
* `src-tauri/src/commands/history.rs` 的 `scan_session_combined` 已在 `codex_usage_delta` 后拿到每次 token 增量。
