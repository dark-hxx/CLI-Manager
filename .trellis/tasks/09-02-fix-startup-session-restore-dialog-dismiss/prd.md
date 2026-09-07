# Fix startup session restore dialog dismissal

## Goal

启动时检测到可恢复终端标签后，恢复提示弹窗必须保持打开，直到用户明确选择“恢复”或“不恢复”。点击弹窗外的应用空白区域、遮罩层或按 Escape 不得关闭提示，避免用户误操作后无法再次恢复。

## Requirements

- 仅调整恢复提示弹窗的关闭策略，不改变“恢复”和“不恢复”的业务处理逻辑。
- 通用确认弹窗的其他调用方继续保留现有的点击外部区域/ESC 关闭行为。
- 恢复提示仍提供并聚焦“恢复”和“不恢复”两个按钮，点击任一按钮后按现有流程关闭并处理会话。

## Acceptance Criteria

- [ ] 启动出现恢复提示时，点击弹窗外空白区域不会关闭弹窗。
- [ ] 启动出现恢复提示时，按 Escape 不会关闭弹窗。
- [ ] 点击“不恢复”可关闭弹窗并执行拒绝恢复流程。
- [ ] 点击“恢复”可关闭弹窗并执行恢复流程。
- [ ] 其他 ConfirmDialog 使用场景行为不变，前端类型检查通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
