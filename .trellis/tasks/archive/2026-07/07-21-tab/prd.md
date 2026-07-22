# 修复终端 Tab 切换自动聚焦

## Goal

修复终端 Tab、Workspan 或 Pane 切换后 xterm 未自动获得输入焦点的问题，使用户切换后可以直接键盘输入，无需再次点击终端内容区。

## Background

- `XTermTerminal` 已在 `isActive && isVisible` 时调用 `terminal.focus()`。
- Tab 从隐藏变为可见时会进入 `visibilityRestorePending` 渐进重绘阶段，终端容器暂时使用 `visibility: hidden`。
- 当前聚焦请求发生在隐藏阶段；重绘完成并重新显示后没有补充聚焦，导致焦点停留在 Tab 元素。
- GitNexus 对 `XTermTerminal` 的上游影响分析为 LOW，直接调用方仅 `PaneLeafView`。

## Requirements

- 仅当终端同时满足活动、可见且可见性恢复已完成时，才请求 xterm 焦点。
- 可见性恢复完成后，活动终端必须在下一动画帧重新获得焦点。
- 非活动分屏终端不得抢焦点。
- 终端搜索框、Tab 重命名输入框等显式输入焦点不得被非状态切换事件覆盖。
- 不增加固定毫秒延时，不修改 PTY、输出渲染或分屏状态模型。

## Acceptance Criteria

- [ ] 普通终端 Tab 切换后可直接输入，无需点击终端内容区。
- [ ] Workspan 切换后，其活动终端可直接输入。
- [ ] 分屏中切换 Pane/Pane 内 Tab 后，仅目标活动终端获得焦点。
- [ ] 全屏 Pane 和从历史页切回终端时，活动终端正常恢复焦点。
- [ ] 搜索框和 Tab 重命名输入框的既有聚焦行为不回归。
- [ ] `npx tsc --noEmit` 通过，相关终端可见性测试通过。

## Out Of Scope

- 不修改终端 Tab、Workspan 或分屏的布局与状态结构。
- 不增加新的焦点管理框架或公共抽象。
- 不启动开发服务器或 Tauri 窗口，除非用户明确要求。

## Technical Notes

- 预计仅修改 `src/components/XTermTerminal.tsx`，将焦点 effect 与 `visibilityRestorePending` 联动。
- 用户可见行为修复记录写入 `CHANGELOG.md` 的 `V1.3.0`。

## Changelog Target

V1.3.0
