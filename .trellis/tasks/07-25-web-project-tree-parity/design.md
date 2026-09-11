# Web 项目树桌面端一致性设计

## 数据边界

- 桌面端是分组、项目、Worktree 顺序与归组关系的唯一权威源。
- `HistorySnapshot` 保持协议兼容，但桌面固定发送空 `sessions` 和完整安全 workspace DTO。
- Web 不缓存独立权威顺序；拖拽只做临时视觉反馈，最终使用桌面重新发布的 workspace。

## 拖拽操作

- 新增 `project.tree.reorder` operation 与 `project.management` capability。
- Payload：`itemType`、`itemId`、`targetParentId`、`orderedIds`。
- 桌面校验目标父级、项目/分组类型、完整同级 ID 集合、重复 ID 和分组循环后，依次复用 `moveProjectToGroup` / `moveGroupToParent` 与 `reorderItems`。
- Worktree 只显示，不可拖拽，与桌面端一致。

## 兼容与失败

- 旧桌面未声明能力时 Web 禁用拖拽。
- 设备离线、operation 失败或 payload 过期时，Web 重新拉取 workspace 回滚。
- 不改变共享 Rust 协议结构，不新增数据库迁移。

