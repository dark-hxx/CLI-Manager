# 解除 AI 进展时间轴展开收起限制

## Goal

让 AI 进展侧栏的时间轴轮次完全由用户独立控制展开状态：已展开轮次可以收起，所有轮次也可以同时保持收起；用户可以同时展开任意多个轮次。

## Requirements

- 将 `src/components/terminal/SessionReplayPanel.tsx` 中时间轴轮次展开状态从单一 ID 改为可容纳多个轮次的状态集合。
- 修复时间轴轮次状态同步逻辑，不因存在轮次而强制重新展开第一轮。
- 保留模型切换或轮次被移除时对无效展开标识的清理，避免状态指向不存在的轮次。
- 不改变时间轴数据聚合、轮次排序、对话详情、步骤详情及详细日志的现有展示行为。
- 不新增用户可见文案，因此不需要新增国际化 key。

## Acceptance Criteria

- [x] AI 进展侧栏中，当前展开轮次可通过再次点击完全收起。
- [x] 所有轮次收起后，状态不会被自动重置为第一轮；点击任意轮次仍可重新展开。
- [x] 多个轮次可以同时展开，点击一个轮次不会收起其他已展开轮次。
- [x] 切换会话或时间轴数据后，不会保留指向已不存在轮次的展开状态。
- [x] `npx tsc --noEmit` 通过；本任务新增代码差异仅涉及时间轴组件，版本记录与任务文档同步更新，工作区其他既有未提交改动保持不动。

## Confirmed Facts

- `ProgressView` 当前使用单个 `expandedTurnId` 管理时间轴轮次展开状态，因此一次只能展开一个轮次。
- 当前 effect 在 `expandedTurnId === null` 且仍有轮次时立即设置第一轮 ID，因此最后一个展开轮次无法保持收起。
- GitNexus 对 `SessionReplayPanel.tsx` 的上游影响评估为 LOW：直接依赖为 `TerminalTabs.tsx`、`TerminalSidePanel.tsx`，间接依赖包含 `App.tsx`。

## Scope

- In scope: 时间轴轮次独立展开/收起状态的修正，以及 `CHANGELOG.md` 和 `docs/功能清单.md` 的 V1.3.9 记录。
- Out of scope: 修改嵌套对话/步骤展开规则、持久化展开状态、后端或 IPC 改动。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
