# Workspan 分屏 Tab 与还原设计

## UI

- 复用 `PaneTabBar`。仅当 Workspan 的可见 Pane 数为 1 且该 Pane 不超过一个可见会话时隐藏。
- Workspan 右键菜单常驻“还原为单 Pane”；单 Pane或范围过滤时禁用。
- Pane 边缘投放区缩到 24%/120px，中心合并区扩大到约 52%。

## State

- `restoreTerminalWorkspanToSinglePane(workspan)` 是纯转换：目标为 `activePaneId`，失效时回退首个叶子；目标 Pane 会话在前，其余 Pane 按树遍历顺序追加并去重。
- `restoreWorkspanToSinglePane(workspanId)` 原子更新 Workspan 并只持久化一次。活动 Workspan 同步 mirror，非活动 Workspan 不抢焦点。
- 不调用 PTY 生命周期方法，不读取 `unsplitBehavior`，不改变持久化结构。

## Edge Cases

- 空/单 Pane、缺失 Workspan：无操作。
- 还原活动 Workspan 时退出 Pane 全屏；还原非活动 Workspan 不影响当前 Pane 全屏状态。
- 范围过滤期间禁用，避免隐式移动隐藏会话。

