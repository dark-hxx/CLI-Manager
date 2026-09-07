# 阶段 C：顶层终端 Tab 顶部/底部停靠

## Goal

实现顶层 Workspan Tab 的顶部/底部停靠，保持排序、拖拽、关闭、重命名、溢出列表和键盘交互。

版本：`V1.3.9`。

## Dependencies

- 父任务：`09-03-workspace-custom-layout`。
- 依赖阶段 B 确定的终端工作区布局槽位；背景样式依赖阶段 A，但 Tab 结构不应依赖背景图是否开启。
- 只移动顶层 Workspan Tab；Pane 内 `PaneTabBar` 的 Session Tab 继续保持顶部，不修改终端分屏树。

## Requirements

- C1：新增并持久化 `workspaceLayout.workspanTabBarPosition`，取值为 `top`/`bottom`，默认 `top`；非法值回退默认。
- C2：顶部和底部均保留 Workspan Tab 的排序、拖拽、关闭、重命名、溢出列表、滚轮和键盘操作。
- C3：Tab 栏移动只改变布局顺序，不改变 Workspan、Session、Pane 或 PTY 身份；终端内容区域正确获得剩余高度；Workspan 功能关闭时不保留空白 Tab 槽位。
- C4：拖拽插入预览、Tab 列表浮层、右键菜单和关闭确认锚点在底部布局可见且不越界。
- C5：复用阶段 B 的 `WorkspaceLayoutSection` 提供顶部/底部选项和恢复默认布局入口，文案覆盖中英文，不新增第二个布局设置入口。
- C6：workspace 背景开启时，Tab 栏使用共享背景上的半透明表面；关闭时保持终端主题样式。

## 文件职责与阶段边界

- 本阶段只移动顶层 Workspan Tab；Pane 内 `PaneTabBar` 永远留在各自 Pane 顶部，不修改分屏树。
- `TerminalTabs` 只负责把 Tab bar 放入顶部/底部布局槽位；`WorkspanTabBar` 负责列表、排序、拖拽、溢出和菜单；位置状态不进入 Tab 组件内部自行持久化。
- 设置布局控件、Tab bar 布局样式、浮层锚点适配和交互契约测试按职责拆分；不得把新的 Tab DnD 逻辑、布局迁移和终端尺寸处理堆入一个文件。
- 不按固定行数拆分已有大文件。只有职责混杂或无法独立验证时才抽取；左右垂直 Tab、自由 Dock 和无关 Tab 重构不在范围内。
- 目标模块为 `src/components/terminal/TerminalWorkspaceFrame.tsx`、`src/components/workspace/WorkspanTabBar.tsx`、`src/components/settings/pages/WorkspaceLayoutSection.tsx`、`src/styles/workspace-layout.css` 和 `scripts/workspanTabBarLayout.test.mjs`；`PaneTabBar` 与 `SplitTerminalView` 不迁移到这些模块。

## Acceptance Criteria

- [ ] 默认顶部布局与当前版本一致。
- [ ] 切换到底部后，单 Workspan、多 Workspan 和 Workspan 拖拽排序均正常，终端内容无空白或被遮挡。
- [ ] 关闭、重命名、溢出列表、滚轮、键盘导航和拖拽插入预览在顶部/底部均正常。
- [ ] 分屏时各 Pane 的 Session Tab 仍在 Pane 顶部，且其关闭、拆分、移动 Pane 等功能不回退。
- [ ] 重启恢复位置，恢复默认回到顶部；非法持久化值不导致空白布局。
- [ ] Workspan 功能关闭或 Tab 栏按既有条件隐藏时，不留下额外高度、空白或遮挡。
- [ ] 亮/暗主题、背景铺满开关、终端全屏、历史工作区、Workspan 开关场景通过人工验证。
- [ ] `npx tsc --noEmit` 通过。
- [ ] `CHANGELOG.md` 的 `V1.3.9` 段和 `docs/功能清单.md` 终端 Tab 板块完成记录。

## Technical notes

- 顶层 Tab 仍是横向列表，因此底部布局可以复用现有 `horizontalListSortingStrategy` 与横向溢出逻辑；左右垂直 Tab 不属于本阶段。
- 底部 Tab 栏必须参与终端可用高度计算，不能采用脱离文档流的绝对定位覆盖终端内容。
