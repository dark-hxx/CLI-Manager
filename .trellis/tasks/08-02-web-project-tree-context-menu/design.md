# 设计：Web 项目树右键菜单与快捷启动

## 目标

通过 Web operation 将项目树操作安全地转发到配对桌面端，Web 负责交互，桌面端复用已有能力。

## 操作接口

- `project.start`
  - payload：`targetType`（project/worktree/group/selection）、`targetId` 或 `targetIds`、`launchMode`（internal/external/split）、可选 `direction`。
  - 快捷按钮默认 `internal`，不需要 prompt；创建终端后返回创建的 session ID。
- `project.action`
  - payload：动作名、目标类型、目标 ID，以及重命名/分组/Provider 等动作参数。
  - 覆盖目录、文件、历史、编辑、克隆、重命名、删除、Provider、分组和 Worktree 动作。
  - 删除、丢弃等动作必须带 `confirmed: true`。
- 所有操作按 ID 校验目标归属和当前状态，避免使用 Web 快照中的路径执行命令。

## 桌面端执行

- `webManagement` 负责 payload 验证、目标解析、能力检查和操作分发。
- `useWebDeviceBridge` 沿用现有 accepted/running/completed 生命周期。
- 直接启动复用 `createSession`、项目启动命令、Provider 覆盖、Worktree 覆盖和 SSH 能力判断。
- 需要原生弹窗的动作通过 action bus 交给 Sidebar，弹窗完成或取消后结束 operation。
- Workspace 变化沿用现有 `publishWorkspace` 与 `history.updated` 刷新机制。

## Web 交互

- 项目、分组、Worktree 行响应 `contextmenu`，阻止浏览器默认菜单。
- Play 按钮只在 hover/focus 时显示，点击时阻止拖拽并提交 `project.start`。
- 菜单使用 `role=menu/menuitem`，支持 Escape、方向键、Home/End，并自动限制在视口内。
- 右键菜单和快捷按钮根据设备在线状态、节点状态和能力禁用。
