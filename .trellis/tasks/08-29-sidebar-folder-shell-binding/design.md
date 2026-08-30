# 设计

## 数据

- `groups.bound_path TEXT NOT NULL DEFAULT ''`，新增 SQLite migration 35。
- `Group`、`CreateGroupInput`、`UpdateGroupInput` 与 projectStore 同步该字段。
- `projects.path_mode`（`custom` / `inherit`）记录路径来源；继承项目不复制父级变更，启动时实时解析当前分组及祖先绑定链。
- 绑定路径为空表示未绑定；解析路径时沿 `parent_id` 向上查找最近非空值。

## UI

- 新增 `GroupEditDialog`，复用 ShellSelect/路径输入样式；展示递归项目数量与 Shell 选择。
- 分组右键菜单增加“修改”，移除原先独立的“本组批量 Shell”入口并并入弹窗。
- ConfigModal 在本地项目路径字段增加来源下拉。父级绑定存在时默认 `inherit` 且 Input disabled；`custom` 显示可编辑 Input 与图标按钮。

## 场景

- 根组/嵌套组/无绑定父链；本地、WSL、SSH；创建项目和编辑项目；侧边栏展开/折叠；已有项目不因绑定改变路径。
- 继承模式项目在打开、分屏、外部终端和命令面板启动时均实时解析；父级或祖先绑定变更后，已有项目无需编辑即可使用新路径。无可用绑定时回退项目保存的旧路径。
## Follow-up design: inherited marker and cascade

Reuse `TreeNodeItem` and render a `Link2` marker inside the existing leading-icon wrapper with absolute positioning, so the flex layout and all following elements retain their current coordinates. Apply the same marker condition to inherited project and group nodes.

Before clearing a folder binding, resolve and capture the folder's current effective path, then derive dependent descendants from the tree/store path modes rather than rendered DOM. Require confirmation when descendants depend on the binding. On confirmation, persist explicit custom paths for those descendants using the captured effective path, leave unrelated custom paths untouched, and refresh the tree. Empty/unavailable effective paths must continue to use existing validation behavior.

The implementation deliberately keeps this flow local to the existing store/dialog boundaries: one shared `pathExists` helper for terminal and folder validation, one descendant traversal, and no new runtime service or visual connector state.
