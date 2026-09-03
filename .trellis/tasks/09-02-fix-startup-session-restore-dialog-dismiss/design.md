# Technical Design

## Root cause

`ConfirmDialog` 将 Radix Dialog 的 `onOpenChange(false)` 一律转发为 `onClose`，因此恢复提示也会响应遮罩点击和 Escape。根因位于通用弹窗的 dismiss 事件策略层；修复应在该层提供可选的“仅显式按钮关闭”模式，再由启动恢复提示启用，避免在恢复业务回调处打补丁。

## Scope and touchpoints

- `src/components/ConfirmDialog.tsx`: 增加仅显式操作关闭的可选属性，并拦截 outside/escape dismiss。
- `src/App.tsx`: 恢复提示实例启用该属性；恢复/拒绝回调保持不变。
- `src/components/ui/dialog.tsx`: confirmed unrelated; existing close button primitive remains unchanged.
- Other `ConfirmDialog` call sites: confirmed unrelated; default behavior remains unchanged.

## State scenarios

- 窗口焦点在当前窗口、其他窗口或应用未聚焦：遮罩点击均不关闭，按钮仍可操作。
- 正常、最小化/托盘唤醒后的启动：恢复提示使用同一关闭策略。
- 单会话、多会话及分屏恢复快照：只改变提示 dismiss 行为，不改变恢复数据流。
