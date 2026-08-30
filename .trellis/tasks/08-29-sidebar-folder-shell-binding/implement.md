# 实现清单

- [x] 扩展 Group 类型、数据库 migration、projectStore CRUD。
- [x] 实现父级绑定路径解析与递归项目收集。
- [x] 新增 GroupEditDialog（Shell 批量修改 + 绑定路径浏览）。
- [x] 接入分组右键菜单与 ConfigModal 路径继承/自定义切换。
- [x] 继承项目保存路径来源并在启动、分屏、外部终端和命令面板中动态解析嵌套父级绑定。
- [x] 拖拽移动保留路径绑定方式；继承项移入新父级继续跟随，移到根层固化为移动前有效路径。
- [x] 继承节点显示父子连接线，并限制拖拽排序不得跨越自定义节点。
- [x] 修正连接线挂载位置与拖拽校验，保留其他层级正常拖拽能力。
- [x] 将垂直连接线贴合子树容器左边缘，并仅限制继承节点落到自定义节点下方；自定义节点移动不再被拦截。
- [x] 连接线仅绘制继承节点；终端编辑切换分组时重新解析继承路径并禁用无绑定选项。
- [x] 继承连接线末端在横线处收口，并在终端编辑分组下拉选项右侧显示有效绑定路径。
- [x] 继承节点后的自定义兄弟项保持纵向连接线连续，嵌套列表连接点按折叠图标位置对齐。
- [x] 补齐中英文 i18n 文案并通过前端类型检查。
- [ ] Rust `cargo check`（当前环境未安装 cargo）。
## Follow-up implementation

1. Trace group edit save, path-resolution, descendant traversal, and project update persistence.
2. Add the folder inherited marker with non-flow positioning and localized accessibility text.
3. Add dependent-descendant detection, effective-path capture, confirmation, and cascade persistence with cancel/error handling.
4. Update `CHANGELOG.md` and `docs/功能清单.md`, then run TypeScript checks and targeted verification.
5. Reuse the terminal `check_paths_exist` validation contract for non-empty custom folder bindings.
