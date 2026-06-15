# 修复统计面板 Codex 工具扩展调用明细

## Goal

统计面板的“工具与扩展”卡片在 Codex 会话中不应只显示工具调用总次数，还应展示具体工具/扩展的调用明细，便于判断实际使用了哪些 Codex 工具、MCP 或 Skill/命令。

## What I Already Know

* 用户反馈：Codex 无法正确展示“工具与扩展”的调用明细，只能看到次数。
* 用户补充：主要问题是 MCP 读取不出；Skill 可以正常读取。
* 前端卡片在 `src/components/stats/termStatsCards.tsx` 的 `ToolsCard`，同时被终端统计面板和历史会话统计面板复用。
* 后端统计在 `src-tauri/src/commands/history.rs`：
  * `collect_tool_calls` 会统计 Claude `tool_use` 与 Codex `function_call/custom_tool_call`。
  * 当前只保留 `tool_call_count` 总数、`mcp_calls`、`skill_calls`。
  * Codex 普通工具名被计入总数后未进入返回结构，因此 UI 无法展示明细。
* 前端类型与归一化在 `src/lib/types.ts`、`src/stores/historyStore.ts`。
* 真实 Codex JSONL 样本显示：
  * MCP 调用开始行：`payload.type = "function_call"`，`payload.name = "impact/query/context"`，`payload.namespace = "mcp__gitnexus"`。
  * MCP 调用结束行：`payload.type = "mcp_tool_call_end"`，`payload.invocation.server = "gitnexus"`，`payload.invocation.tool = "impact/query/context"`。
* 当前 `collect_tool_calls` 只根据 `payload.name` 的 `mcp__<server>__<tool>` 前缀识别 MCP，因此 Codex 的 MCP 调用被计入总工具次数但没有进入 `mcp_calls`。

## Requirements

* 修复 Codex MCP 调用识别，使 `mcp_calls` 能显示 MCP 服务名及次数。
* 支持 Codex `function_call.namespace = "mcp__<server>"` 形态。
* 支持 Codex `mcp_tool_call_end.invocation.server` 形态时避免与开始行重复计数。
* 保持现有 `tool_call_count`、`mcp_calls`、`skill_calls` 语义不变。
* `ToolsCard` 继续展示 MCP 与 Skill/命令分组；Skill 逻辑保持不变。
* 不扩大到全局分析看板的新图表，只修复当前“工具与扩展”明细展示。

## Acceptance Criteria

* [ ] Codex 会话存在 MCP 调用时，“工具与扩展”卡片显示 MCP 服务名与次数，而不是仅显示“X 次内置工具调用”。
* [ ] MCP 与 Skill/命令明细仍正常展示。
* [ ] 后端单测覆盖 Claude `mcp__server__tool`、Codex `function_call.namespace`、Codex `mcp_tool_call_end`、Skill 的聚合结果。
* [ ] 前端 TypeScript 类型检查通过。
* [ ] Rust 测试或至少相关 history 单测通过。

## Definition of Done

* 最小必要代码修改完成。
* 不引入新依赖。
* 不改变历史统计扫描的总数口径。
* 完成相关验证并记录结果。

## Technical Approach

修复后端 Codex MCP 识别逻辑：`collect_tool_calls` 除了检查工具名 `mcp__<server>__<tool>`，还检查 `payload.namespace = "mcp__<server>"`；同时识别 `mcp_tool_call_end.invocation.server`，并用同一个 `call_id` 去重，避免开始/结束事件重复计数。前端无需改动。

## Decision (ADR-lite)

**Context**: Skill 已能读取，MCP 不能读取，说明问题更可能在 Codex MCP tool-call 识别规则，而不是前端卡片渲染。  
**Decision**: 先定位真实 Codex MCP 记录结构，只修复 MCP 识别；不新增普通工具明细，除非定位证明它也是必要条件。  
**Consequences**: 修改范围可以收窄到后端解析与单测；仍会触碰历史扫描共享路径，需要用后端单测约束总数和分类不回退。

## Out of Scope

* 不新增全局分析看板维度。
* 不改变历史文件索引、搜索、消息解析逻辑。
* 不做 UI 大改或新图表。

## Technical Notes

* GitNexus impact:
  * `history_get_stats` upstream risk: LOW，0 direct callers in graph。
  * `build_session_detail` upstream risk: LOW，直接影响 `history_get_session`。
  * `scan_session_combined` upstream risk: CRITICAL，影响历史列表、搜索、提示词列表、统计、会话详情等共享扫描流程；实现必须保持计数口径不变并跑单测。
* `ToolsCard` 所在文件未被 GitNexus 精确索引到符号，已用源码直接确认调用点。
