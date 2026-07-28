# 完善 Git Diff 行操作与无障碍

## Goal

让行级回滚的选择规则明确、可见且可用键盘完成，并修复现有弹窗缺少标准焦点管理的问题。

## Changelog Target

`[TEMP]`

## Requirements

- 单击 gutter 切换一条 insert/delete；normal 行不可选。
- Shift+单击在同一 side 的可见变更顺序中选择连续范围；跨 normal 行时只选择变更行。
- 不实现拖拽范围选择，避免破坏代码文本选择。
- 可聚焦 gutter 使用 Enter/Space 切换，Shift+方向键扩展选择。
- 选择状态显示数量、清除和回滚命令，并通过 `aria-live` 播报。
- Dialog 打开后聚焦工具栏第一个可用控件，Tab 不逃出弹窗，关闭后恢复触发元素焦点。
- Esc 只关闭当前顶层 Diff Dialog，IME composing 时不处理。
- 不得仅用颜色表达 insert/delete/selected/revert-disabled 状态。

## Acceptance Criteria

- [ ] 鼠标和键盘可完成单选、范围选择、清除与回滚。
- [ ] Split 两侧的 anchor 和范围互不串联；Unified 使用统一可见顺序。
- [ ] Diff 内容、文件或 options 变化时旧选择被清空。
- [ ] 非 UTF-8、非 exact、未跟踪和后端禁用场景无法执行部分回滚。
- [ ] 弹窗具备 `role=dialog`、`aria-modal`、可访问名称、焦点锁定与焦点恢复。
- [ ] 亮暗主题下 focus/selected 对比度可辨识，中英文文本不溢出。

## Out of Scope

- 不增加评论、代码审查批注、任意文本编辑或拖拽选择。
