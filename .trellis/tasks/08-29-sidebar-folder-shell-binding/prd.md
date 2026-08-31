# Sidebar folder shell and path binding

## Goal

TBD.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.

## Final requirements: inherited indicator, validation, and binding clear cascade

- Show the inherited-path link icon to the left of the existing appearance icon for inherited projects and folders without shifting any existing row content.
- When editing a folder and changing its binding to an empty custom path, detect descendant groups/projects that inherit from this folder.
- If dependent descendants exist, warn before saving. On confirmation, materialize the folder's current effective path into each affected descendant so it no longer depends on the cleared binding; cancel leaves all records unchanged.
- Preserve unrelated custom paths and support nested, collapsed, mixed, local, WSL, and SSH project trees.
- Add all warning, accessibility, and status copy in zh-CN and en-US.
- Validate non-empty custom folder binding paths with the same `check_paths_exist` path existence check used by terminal editing; block save when unavailable.
- Keep the implementation within the existing store, dialog, and tree boundaries; do not add a separate path service or connector-line layout system.

### Follow-up acceptance criteria

- [ ] Inherited project and folder rows show the link icon with no layout shift.
- [ ] Clearing a folder binding with inheriting descendants requires confirmation and reports the affected count/path.
- [ ] Confirming materializes the effective path into all affected descendants and refreshes the tree.
- [ ] Canceling or a failed save preserves the original folder and descendant state.
# 侧边栏文件夹 Shell 与绑定路径

## 目标

优化左侧项目列表的文件夹（分组）管理：文件夹右键菜单提供“修改”，在同一弹窗中配置本组 Shell 和绑定路径；新建项目/终端时可继承上级文件夹绑定路径。

## 需求

1. 文件夹右键菜单新增“修改”入口。
2. 修改弹窗支持：
   - 批量修改本组（含子文件夹）项目 Shell；
   - 设置/清除绑定路径。
3. 创建项目/终端时，路径字段改为“继承父级 / 自定义”下拉模式：
   - 继承父级时显示最近上级文件夹绑定路径，并禁止编辑；
   - 自定义时恢复文本输入与文件夹浏览图标按钮。
4. 绑定路径持久化到分组，并在新建子文件夹/终端流程中正确继承。
5. 新增/修改用户可见文案同步支持 zh-CN 与 en-US。

## 验收标准

- 文件夹右键菜单可打开修改弹窗，保存后刷新列表仍保留设置。
- 批量 Shell 修改覆盖本组及递归子组项目，不影响其他组。
- 新建终端默认选择继承父级；无绑定路径时自动回退到自定义模式。
- 自定义模式可手动输入路径并通过内嵌文件夹图标选择目录。
- 本地、WSL、SSH 项目类型行为不回归；类型检查通过。
