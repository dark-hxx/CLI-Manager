# 合并侧边面板 Tab 跟随工具栏开关并适配窄宽度

## Goal

让“合并实时统计与 Git 变更面板”模式下的顶部 Tab 与终端工具栏开关保持一致，避免已从工具栏关闭的面板仍占用 Tab 空间；在合并面板宽度不足时仅显示图标，避免标签文字互相挤压。

## Changelog Target

[TEMP]

## Requirements

- 仅在 `terminalSidePanelMerged` 开启时调整合并面板 Tab 行为，不改变独立面板模式。
- `stats`、`git`、`replay`、`files`、`systemResources` Tab 分别跟随终端工具栏对应开关。
- 工具栏开关关闭后，对应 Tab 不再渲染。
- 系统资源 Tab 继续受系统资源监控可用条件约束。
- 当前激活 Tab 被关闭时，自动切换到第一个仍可用的 Tab；没有可用 Tab 时关闭合并面板。
- Tab 行宽度不足时隐藏文字，仅保留图标；宽度恢复后重新显示文字。
- 不新增依赖，不新增用户可见文案，不改动设置数据结构。

## Acceptance Criteria

- [ ] 工具栏关闭任一面板入口后，合并面板不显示对应 Tab。
- [ ] 重新开启入口后，对应 Tab 可再次显示并正常切换。
- [ ] 当前 Tab 被关闭时不会留下无标题内容或不可达状态。
- [ ] 合并面板较窄且 Tab 发生挤压时只显示图标；较宽时显示图标和文字。
- [ ] 非合并模式的各独立面板开关和布局行为保持不变。
- [ ] `npx tsc --noEmit` 通过。

## Out of Scope

- 不调整工具栏开关配置项、排序和默认值。
- 不改变各面板内容、宽度持久化规则或独立面板响应式策略。

## Decision

- 当前激活 Tab 的工具栏开关被关闭时，自动切换到第一个仍可见的 Tab。
- 如果所有合并面板对应的工具栏入口都已关闭，则关闭合并面板。

## Technical Notes

- 合并面板渲染位于 `src/components/terminal/TerminalSidePanel.tsx`。
- 工具栏可见性和合并面板状态位于 `src/components/TerminalTabs.tsx`。
- `terminalToolbarVisibility` 已包含 `stats`、`gitChanges`、`replay`、`files`、`systemResources`，无需新增状态字段。
- GitNexus 当前索引不可用：缺少 `.gitnexus/lbug`，实施前需重新分析并执行符号影响检查。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
