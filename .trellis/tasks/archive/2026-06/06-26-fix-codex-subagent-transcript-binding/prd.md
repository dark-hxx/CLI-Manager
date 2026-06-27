# Fix Codex Subagent Transcript Binding

## Goal

修复 CLI-Manager 对 Codex 子代理的自动分屏绑定逻辑。当前实现会为 Codex 打开子代理视图，但无法把真实子代理 transcript 绑定到对应 tab，导致只能显示降级状态。第一版保持现有交互策略：同一父会话下的多个 Codex 子代理共享同一个右侧 pane，并以多个 tab 展示。

## Requirements

* 识别 Codex 子代理独立 session 文件，而不是继续只依赖 Claude 风格的 `agentTranscriptPath` 或 `.claude/.../subagents/agent-*.jsonl`。
* 基于 Codex session 元数据中的父子关系建立绑定，至少支持 `parent_thread_id -> parent session id`。
* 当父会话中启动多个 Codex 子代理时，CLI-Manager 继续采用“同 pane 多 tab”策略，不为第二个及后续子代理再新开 pane。
* 每个 Codex 子代理 tab 必须订阅并显示自己的 rollout transcript，不能继续显示 `PARENT JSONL` 降级占位。
* 不破坏现有 Claude 子代理镜像能力，也不破坏已有 `subagent-transcript` pane/tree 语义。
* 不把本次修复扩展成新的原生 Agent Runner；只修复 Codex 现有自动分屏与 transcript 绑定。

## Acceptance Criteria

* [ ] 父 Codex 会话启动第一个子代理时，会自动打开一个 `subagent-transcript` pane。
* [ ] 父 Codex 会话启动第二个及后续子代理时，会追加为同一 pane 下的新 tab，而不是新 split pane。
* [ ] 每个 Codex 子代理 tab 都能读取并显示自己的 `rollout-*.jsonl` transcript。
* [ ] Codex 子代理 tab 不再停留在 `Parent JSONL` / “未暴露独立子 Agent transcript” 这种错误降级提示。
* [ ] Claude 现有 `SubagentStart` / `AgentToolStart` 路径行为不回归。
* [ ] 前端类型检查通过。
* [ ] Rust 编译检查通过，或明确说明未运行原因。

## Technical Approach

保留现有 `claude-hook-notification -> openSubagentTranscript -> subagent-transcript` UI 主链路，但为 Codex 增加一条独立的数据源解析路径：

* 父会话继续通过 hook 事件触发子代理 tab 创建。
* Codex 子代理不再走 Claude 风格 `agentTranscriptPath` 推导。
* 新增对 `.codex/sessions/**/rollout-*.jsonl` 的发现与绑定逻辑，依据子 session 的 `session_meta.payload.parent_thread_id` 反查父 session。
* 发现到多个子 session 时，沿用当前“同父已有 transcript pane 则追加 tab”的布局策略。
* `SubagentTranscriptView` 的 Codex 场景应显示真实 child transcript，而不是 Claude 专属的降级提示文案。

## Decision (ADR-lite)

**Context**: Codex 子代理真实数据源是独立 rollout session，结构和 Claude 的 `subagents/agent-*.jsonl` 不同；现有实现模型不匹配。

**Decision**: 第一版不改 UI 交互模型，继续使用“同 pane 多 tab”，只补齐 Codex 子代理 session 发现、父子绑定和 transcript 订阅链路。

**Consequences**:

* 优点：改动范围可控，能直接修复当前用户看到的问题。
* 风险：需要在不影响 Claude 的前提下，为 Codex 增加独立分支逻辑。
* 后续：如果要做更强的 Codex/Claude 原生 Agent Runner，再单独开任务。

## Out of Scope

* 不实现新的原生 Codex Agent Runner。
* 不改“同 pane 多 tab”为“每个子代理独立 pane”。
* 不重做整个 transcript UI。
* 不修改无关的终端 pane tree 基础行为。

## Technical Notes

* 相关现状实现集中在 `src/App.tsx`、`src/stores/terminalStore.ts`、`src-tauri/src/commands/subagent_transcript.rs`、`src/components/terminal/SubagentTranscriptView.tsx`。
* 旧任务 `.trellis/tasks/06-22-cli-manager-agent/` 主要覆盖 Claude 子代理镜像；本任务只复用其 pane/store 经验，不复用 Claude 路径假设。
