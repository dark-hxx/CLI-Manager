# 技术设计：顶层 Workspan Tab 顶部/底部停靠

## 1. 状态契约

复用父任务/阶段 B 的：

```ts
workspaceLayout.workspanTabBarPosition: "top" | "bottom";
```

默认 `top`，非法值由同一个 `migrateWorkspaceLayout` 回退。不得新增第二个独立 Tab 位置设置。

## 2. 布局策略

顶层 Workspan Tab 与终端内容处于同一个 flex column，并通过文档流顺序切换：

```text
top:    WorkspanTabBar -> terminal body
bottom: terminal body   -> WorkspanTabBar
```

Tab bar 保留现有高度 `h-9` 和横向列表，不使用 absolute 定位，确保终端 body 自动获得剩余高度；Workspan disabled/既有隐藏条件下不渲染占位高度。

仅移动顶层 Workspan Tab。每个 Split Pane 内部的 `PaneTabBar` 始终位于其 Pane 顶部，不消费该设置。

顶部模式的文档流和键盘顺序为 `WorkspanTabBar -> terminal body`；底部模式为 `terminal body -> WorkspanTabBar`，视觉顺序与可访问焦点顺序一致。两种模式只保留一个 `WorkspanTabBar` 实例和稳定 key，不通过双渲染切换。

## 3. 交互兼容

- 保留 Workspan DnD id、`horizontalListSortingStrategy`、横向滚动、左右按钮、溢出 Popover、右键菜单和关闭确认逻辑。
- 底部布局只改变容器上下位置；插入预览仍按横向坐标计算。
- 底部 Tab 的 Popover/确认浮层需要重新检查 viewport 边界和触发器 anchor，不能因 `align` 默认值从屏幕底部溢出。
- Workspan disabled、单 Workspan、多个 Workspan、History active、fullscreen 和 empty 状态均由现有条件继续控制。

## 4. 背景与主题

Tab bar 在 workspace 背景模式下使用半透明终端 chrome，在 terminal-only 模式下保持现有终端主题背景。Pane 内 Tab 和终端内容不因顶层 Tab 位置改变而重建。

## 5. 风险

- 终端高度变化会触发 XTerm fit；必须依赖现有 ResizeObserver/fit 调度，不在拖拽或设置切换中创建新的 session。
- Workspan 拖拽 insertion marker 当前按 top bar 的几何位置计算，底部布局需验证其 Y 位置但不改变横向排序模型。
- CSS fullscreen 规则对 top chrome/well 的 margin、radius、outline 需要同时覆盖底部状态。

## 6. 文件职责边界

- `TerminalTabs`：只负责读取位置状态并把 Tab bar、terminal body 接入布局，不重写 Tab 的业务交互。
- `WorkspanTerminalLayout`：负责按顶部/底部生成稳定 key 的文档流槽位，保证位置切换不卸载 Tab 或终端 body，并让可访问顺序与视觉顺序一致。
- `WorkspanTabBar`：只负责顶层 Workspan Tab 的渲染、横向排序、滚动、拖拽、溢出和菜单；不处理 Pane 内 Session Tab。
- 布局/锚点适配模块：只负责顶部/底部几何位置、Popover 边界和插入预览锚点，不复制 Workspan 状态管理。
- `WorkspaceLayoutSection`：只负责顶部/底部选项和恢复默认，不直接操作 DOM 或终端尺寸。
- Tab 停靠样式与契约测试按本阶段职责组织，不把背景根层、辅助面板 resize 或 SplitTerminalView 逻辑复制进来。

拆分依据是职责和可独立验证边界，不设固定行数目标；现有高内聚代码不做无关机械拆分。若 `WorkspanTabBar.tsx` 内的 Tab item 或 overflow menu 形成独立可验证职责，再拆为同目录子模块。
