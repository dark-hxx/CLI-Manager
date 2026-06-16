# 在「工具与扩展」卡片显示内置工具调用明细

## Goal

统计面板「工具与扩展」卡片当前在只有内置工具调用时仅显示一句聚合文案「X 次内置工具调用，未使用 MCP / Skill」。需要把这 X 次调用按工具名（Read / Edit / Bash / shell 等）拆出明细与次数，和 MCP、Skill 分组并列展示，便于判断实际用了哪些内置工具。

## What I Already Know

- 前端卡片在 `src/components/stats/termStatsCards.tsx` 的 `ToolsCard`，同时被终端实时统计面板与历史会话统计面板复用。
- 复用组件 `ToolCountList`（同文件）已支持「名称 + 次数 + 前 4 项 + 余量」展示，MCP / Skill 都用它，内置工具可直接复用。
- 后端统计在 `src-tauri/src/commands/history.rs`：
  - `collect_tool_calls` 的 `record` 闭包（约 2682-2706）：每次调用 `tool_call_count += 1`；命中 MCP → `mcp_calls`；`name == "Skill"` → `skill_calls`；**其余内置工具名直接丢弃，只剩总数**。Claude `tool_use` 与 Codex `function_call/custom_tool_call/mcp_tool_call_end` 都汇入同一闭包。
  - 工具调用已按 `call_id` / block `id` 经 `seen_call_ids` 去重，新增字段天然复用该去重。
  - 当前返回结构 `HistoryUsage`（约 250-252）只含 `tool_call_count` / `mcp_calls` / `skill_calls`。
- 前端类型 `src/lib/types.ts`（约 158-160），store 归一化 `src/stores/historyStore.ts` 的 `normalizeDetail`。
- 契约 `.trellis/spec/backend/history-stats-contracts.md`：新增数字/数组字段前端必须可选、store 归一化兜底，老缓存 payload 缺字段时不得渲染 NaN；改 history stats 契约发布前需 `cargo test`。
- 与 trellis 任务 `06-15-fix-codex-tool-extension-call-details`（修 MCP 识别）正交，可叠加。

## Requirements

- 后端新增「内置工具」按名计数：`record` 闭包中既非 MCP、又非 `Skill` 的工具名计入新字段 `builtin_calls`。
- `Skill` 工具本身不计入 `builtin_calls`（它是 skill 调用入口，归 `skill_calls`），避免口径污染。
- 保持 `tool_call_count` / `mcp_calls` / `skill_calls` 现有语义与总数口径完全不变。
- 透传链路对称：ScanStats → `HistoryUsage` → `sorted_tool_counts` 转换 → 前端类型 → store 归一化 → `ToolsCard`。
- `ToolsCard` 新增「内置工具」分组（复用 `ToolCountList`），与 MCP、Skill 并列；三者均空时维持「暂无工具调用」空态。
- 新增字段前端可选，老缓存/缺字段归一化为 `[]`，不得 NaN。

## Acceptance Criteria

- [ ] 会话存在内置工具调用时，卡片显示具体工具名与次数（如 `Read 3`、`Bash 1`），而非仅「X 次内置工具调用」。
- [ ] MCP 与 Skill / 命令明细仍正常展示；三组可并列。
- [ ] 三类都为空时显示「暂无工具调用」；未绑定会话空态不变。
- [ ] `tool_call_count` 总数口径不变（含 MCP + Skill + builtin 去重后总和）。
- [ ] 后端单测覆盖 `builtin_calls` 聚合（含 Claude 内置工具、Codex function_call 普通工具、且 Skill/MCP 不串入 builtin）。
- [ ] `npx tsc --noEmit` 通过；history 相关 `cargo test` 通过。

## Definition of Done

- 最小必要改动完成，不引入新依赖。
- 不改变历史扫描总数口径与去重规则。
- 完成验证并记录结果。

## Technical Approach

后端在 `record` 闭包的 MCP / Skill 分支后补 `else { *builtin_calls.entry(name.to_string()).or_insert(0) += 1; }`；`builtin_calls: HashMap<String, u64>` 在 ScanStats、聚合临时变量与传参、`HistoryUsage` 返回结构、`sorted_tool_counts` 转换处对称添加。前端 `types.ts` 加可选 `builtin_calls?: HistoryToolCount[]`，`normalizeDetail` 透传并兜底 `[]`，`ToolsCard` 渲染新增分组并替换原兜底单行文案。

## Decision (ADR-lite)

**Context**: 用户要看到内置工具名；后端目前只保留总数，名字在 `record` 闭包被丢弃。
**Decision**: 新增独立 `builtin_calls` 字段（非 MCP 非 Skill 的工具名计数），不动总数与 MCP/Skill 口径；前端复用 `ToolCountList` 最小渲染。
**Consequences**: 触碰 CRITICAL 共享扫描路径 `scan_session_combined`，须以单测约束总数与各分类不回退；新增字段前端可选以兼容老缓存。

## Out of Scope

- 不新增全局分析看板维度 / 新图表。
- 不改历史索引、搜索、消息解析与 token 口径。
- 不做工具名本地化（按原始英文展示）。

## Technical Notes

- GitNexus impact：`scan_session_combined` upstream 风险 CRITICAL（历史列表/搜索/提示词/统计/会话详情共享），实现必须保持计数口径不变并跑单测；`build_session_detail` LOW，直接影响 `history_get_session`。
- 契约引用：`.trellis/spec/backend/history-stats-contracts.md`（去重、缺字段兜底、cargo test 要求）。
- `ToolsCard` 未被 GitNexus 精确索引到符号，已用源码直接确认调用点。
