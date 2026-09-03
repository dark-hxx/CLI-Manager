# 技术设计：终端辅助面板左右停靠

## 1. 状态契约

新增工作区布局设置：

```ts
interface WorkspaceLayoutSettings {
  version: 1;
  terminalSidePanelSide: "left" | "right";
  workspanTabBarPosition: "top" | "bottom";
}
```

本阶段只消费 `terminalSidePanelSide`，默认 `right`。`workspaceLayout` 标记为 `preferences` 并加入 `syncSettings.ts` 的穷尽映射；旧设置缺失或非法时回退默认。

## 2. DOM 布局

终端工作区保持文档流布局：

```text
left:  panel(s) -> terminal center -> action rail
right: terminal center -> panel(s) -> action rail
```

辅助面板可为合并的 `TerminalSidePanel`，也可为非合并模式下的多个 `ResizableTerminalPanelFrame`。右停靠时当前“中心→外侧”的渲染顺序是基准；左停靠时只反转外层 DOM 呈现，使中心→外侧的视觉顺序不变，状态中的 panel 顺序、width key 和业务 Tab 顺序不变。

终端操作 rail 是独立的终端操作入口，MVP 固定在最右侧，不随卡片面板移动。这样保留现有 tooltip 向左显示、CommandTemplate popover 的侧向锚点以及稳定的键盘顺序。

## 3. 方向感知 resize

`ResizableTerminalPanelFrame` 增加 `dockSide`：

- `right`：`rawWidth = startWidth + startX - currentX`，sash 在左侧，使用 `border-l`。
- `left`：`rawWidth = startWidth + currentX - startX`，sash 在右侧，使用 `border-r`。

两种方向都使用现有 RAF DOM preview、边界 rebase 和 mouseup 单次持久化。`aria-orientation` 仍为 vertical，resize label/title 通过 i18n 提供。

## 4. 渲染状态

- `TerminalTabs` 读取窄选择器 `workspaceLayout.terminalSidePanelSide`，不把整个 settings store 订阅到高频终端内容。
- 位置变化只影响 panel 的 DOM order、边框和 CSS 属性，不改变 session、workspan、pane tree 或 PTY。
- side panel 的 tab、lazy panel 内容、capability 判断、合并/独立开关逻辑保持原实现。
- `fillWorkspace` 由阶段 A 提供；本阶段只让 panel shell 在 workspace 背景模式下使用半透明 surface，关闭时继续使用 `TERM_PANEL.bg`。

## 5. 设置入口

新增独立的 `WorkspaceLayoutSection` 并由 `SidebarSettingsPage` 装配，提供左/右选择卡和恢复默认布局操作。恢复默认应只重置 `workspaceLayout`，不重置用户已经调整的 `sidebarWidth` 或 `terminalPanelWidths`；因此面板回到右侧时仍保留用户宽度。

## 6. 兼容与风险

- 不改 `SplitTerminalView` 和 `terminalPaneTree`。
- 主项目 Sidebar 继续固定左侧，避免与辅助面板同侧时引入第二套导航排序。
- 当辅助面板关闭、没有可用 Tab 或进入 History 时，位置设置仍保留，重新打开可恢复原停靠侧。
- `terminalToolbarVisibility`、merged/single-open、fullscreen、compact 和外部终端模式不得因 panel order 改变而改变语义。

## 7. 多面板顺序契约

- 面板顺序的业务真值仍由现有 `TerminalTabs` 状态/条件决定，不新增一套“左侧顺序”。
- 右停靠继续按现有渲染顺序从终端中心向外排列；左停靠使用该序列的反向 DOM 顺序，以抵消左右镜像后的视觉方向变化。
- CSS `direction`、整体镜像和改变 panel width key 均禁止；它们会同时改变文本、Tab、辅助功能或持久化语义。

## 6. 文件职责边界

- `TerminalTabs`：只负责读取窄布局选择器并编排 center/panel/action rail 的槽位，不实现 resize 热路径。
- `TerminalSidePanel`：只负责面板内容、面板 Tab、lazy 内容和 capability；不根据鼠标坐标计算宽度。
- `ResizableTerminalPanelFrame`：只负责停靠边框、sash、拖拽预览、clamp/rebase 和一次性持久化；不拥有面板业务内容。
- `WorkspaceLayoutSection`：只负责左/右选项、恢复默认和 i18n；不直接改 DOM 或面板宽度。
- 面板停靠样式与 resize 契约测试按本阶段职责组织，不将 Workspan Tab DnD 或背景根层实现复制进来。

拆分按职责和独立验证边界执行，不以固定行数为目标；若现有面板文件仍保持内聚，则不做无关机械拆分。
