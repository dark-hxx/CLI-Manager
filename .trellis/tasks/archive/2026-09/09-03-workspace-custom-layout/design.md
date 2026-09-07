# VS Code 式工作区布局控制设计

## 1. 设计结论

采用“标题栏快速控制 + `...` 自定义布局菜单”的有限布局方案，作为当前 Issue #248 A/B/C 背景与停靠能力之上的交互层。

本阶段不实现 VS Code 式任意拖拽 Dock。现有左右停靠、上下 Tab 栏和宽度 sash 已足够覆盖当前产品的布局维度；先把入口从设置页迁移到工作区顶部，降低用户发现和操作成本。

## 2. 目标布局模型

布局由三类独立状态组成：

| 区域 | 当前状态来源 | 本阶段控制方式 | 备注 |
| --- | --- | --- | --- |
| 项目侧栏 | `workspaceLayout.projectSidebarSide` + `Sidebar` 的折叠/宽度状态 | 标题栏快速切换、菜单左右停靠 | 停靠侧持久化，折叠和宽度继续由 `Sidebar` 持有 |
| 终端辅助面板 | `workspaceLayout` + `TerminalTabs` 面板状态 | 快速显示/隐藏；菜单左右停靠 | 隐藏区域不关闭具体面板 |
| Workspan Tab 栏 | `workspanEnabled` + `workspaceLayout` | 快速显示/隐藏；菜单上下位置 | 隐藏栏不销毁 Workspan |

原生窗口控制、终端操作栏和终端中心区不是本阶段可隐藏区域：

- 原生窗口控制始终保留；
- 终端操作栏始终保留，作为重新打开辅助面板的入口；它与辅助面板保持同侧并位于外缘；
- 中心终端区始终保留，只有终端没有活跃会话时显示现有空状态。

## 3. 状态设计

### 3.1 `workspaceLayout` 扩展

在 `src/lib/workspaceLayout.ts` 中将版本升级为 `3`，继续集中定义类型、默认值和迁移函数：

```ts
type WorkspaceLayoutSettings = {
  version: 3;
  projectSidebarSide: "left" | "right";
  terminalSidePanelSide: "left" | "right";
  workspanTabBarPosition: "top" | "bottom";
  terminalSidePanelVisible: boolean;
  workspanTabBarVisible: boolean;
};
```

迁移规则：

1. 读取缺失值时先与默认值合并；
2. `version <= 2` 的旧对象补充 `projectSidebarSide: "left"`、`terminalSidePanelVisible: true` 和 `workspanTabBarVisible: true`；
3. 位置字段只接受明确的联合值；
4. 可见性字段只接受布尔值；
5. 最终输出统一为版本 `3`，避免组件分别处理旧格式。

项目侧栏只将停靠侧放入该对象；折叠状态、宽度和恢复展开逻辑仍由 `Sidebar` 持有，布局控件通过现有 `SIDEBAR_TOGGLE_REQUEST_EVENT` 与其交互。`App` 根据停靠侧改变项目侧栏和终端主区的 flex 顺序，`Sidebar` 同步调整分隔线、折叠箭头和宽度拖拽计算。

### 3.2 显示/隐藏语义

- `terminalSidePanelVisible = false` 只隐藏辅助面板区域，不修改 Git/统计/历史回放/文件/供应商等 `*Open` 状态，也不关闭终端会话。
- 当用户从终端操作栏打开一个辅助面板，而区域当前隐藏时，先写入 `terminalSidePanelVisible = true`，再设置目标面板打开状态。
- `workspanTabBarVisible = false` 只隐藏 Tab 栏容器，不修改 `workspanEnabled`、Workspan pane 数量、Tab 顺序或 PTY 会话。
- 当 Workspan 未启用时，Tab 栏显示控制置为 disabled，并通过 tooltip 说明不可用；不能因为点击而隐式启用 Workspan。
- 当 Workspan 功能开启但当前没有 Workspan Tab 时，Tab 栏显示控制同样置为 disabled，并通过 tooltip 说明不可用；不能产生“状态改变但界面无变化”的无效操作。
- 没有产生空的布局占位：区域隐藏后，中心区使用可用空间；恢复时由现有布局组件重新参与 flex/grid 计算。

### 3.3 恢复默认

恢复默认只重置布局维度：

```ts
{
  projectSidebarSide: "left",
  terminalSidePanelSide: "right",
  workspanTabBarPosition: "top",
  terminalSidePanelVisible: true,
  workspanTabBarVisible: true,
}
```

项目侧栏若处于折叠状态，则通过已有展开事件恢复显示，保留用户上一次展开宽度。辅助面板宽度、面板打开状态、PTY 会话和终端内容均保留。

## 4. 组件职责

### `WindowTitleBar`

- 保留应用标题、拖拽区域和原生窗口按钮；
- 在中间/右侧插入 `WorkspaceLayoutControls`；
- 不直接读取或修改具体面板状态；
- 对设置页和会话历史页继续应用现有不透明标题栏样式。

### `WorkspaceLayoutControls`

建议新增 `src/components/layout/WorkspaceLayoutControls.tsx`，只负责：

- 渲染三个快速切换按钮和 `...` 菜单；
- 读取当前布局状态并生成 `aria-pressed`、disabled 和 tooltip；
- 调用窄接口：切换项目侧栏、改变项目侧栏停靠侧、切换辅助区域、改变辅助区域停靠侧、切换 Tab 栏、恢复默认；
- 使用 i18n 文案。

组件不负责：

- 计算终端 flex 顺序；
- 直接操作 `*Open` 面板状态；
- 处理背景图片和透明度；
- 处理原生窗口按钮。

### `workspaceLayout.ts`

- 定义状态类型、默认值、版本迁移和纯更新函数；
- 不依赖 React、DOM 或具体组件。

### `settingsStore`

- 继续持久化 `workspaceLayout`；
- 暴露最小化的更新入口；
- 不把标题栏菜单逻辑塞入 store。

### `TerminalTabs`

- 将辅助区域可见性映射给 `TerminalWorkspaceFrame`；
- 将 Tab 栏可见性映射给 `WorkspanTerminalLayout`；
- 保持现有各具体面板 `*Open` 状态；
- 在打开具体辅助面板时调用“确保区域可见”的更新；
- 不渲染标题栏菜单。

### `WorkspaceLayoutSection`

从 `SidebarSettingsPage` 移除并删除无调用方的旧布局设置组件，避免出现两个控制入口和两套行为。

### `App` 与 `Sidebar`

- `App` 读取 `projectSidebarSide`，只在普通工作区布局中交换项目侧栏与终端主区的 flex 顺序；紧凑模式和沉浸式全屏保持原有语义。
- `Sidebar` 接收停靠侧，右停靠时把 resize sash、边框和折叠箭头镜像到靠近终端的一侧；宽度记忆键和折叠状态不变。

## 5. 标题栏交互和布局

控件组放在自定义标题栏的非拖拽容器内，原生窗口按钮仍位于最右侧。建议顺序：

```text
应用图标/标题 —— 可拖拽空白 —— 侧栏  辅助面板  Tab 栏  ... —— 最小化 最大化 关闭
```

项目侧栏与终端主区的横向顺序由 `projectSidebarSide` 决定：默认是“项目侧栏 | 终端主区”，切换后是“终端主区 | 项目侧栏”。终端辅助面板和操作栏相对终端中心按自身 `terminalSidePanelSide` 排列，操作栏位于辅助面板外缘，因此可以组合出“操作栏 | 辅助面板 | 终端 | 项目侧栏”的布局。

交互规则：

- 快速按钮点击后立即更新 UI，并复用设置 store 的持久化路径；
- 快速按钮的 active 状态表示“当前可见”，不是表示某个具体子面板已打开；
- `...` 菜单中的当前位置使用 checked/active 状态；
- 项目侧栏左/右停靠与辅助面板左/右停靠分别显示选中态，二者可以组合；
- 当前已经是目标位置时菜单项仍可点击但不产生多余状态写入；
- 菜单打开时点击外部、按 `Escape` 或切换窗口焦点按现有菜单规范关闭；
- 键盘可通过 Tab 聚焦、Enter/Space 操作，菜单支持方向键导航；
- 控件组不能触发标题栏拖拽，点击菜单不能误触发窗口最大化。

窄窗口处理：

- 优先保留原生窗口按钮和 `...` 菜单；
- 三个快速按钮在空间不足时缩短间距或折叠进 `...` 菜单；
- 不覆盖原生按钮，不产生标题栏横向溢出；
- 不新增横向滚动条。

## 6. 背景和页面模式兼容

本设计不修改背景作用域，只保证新控件使用正确的页面样式：

- 终端工作区：继续由现有 `fillWorkspace` 决定侧栏、辅助面板和 Tab 区域是否与终端共用背景；
- 设置页：工作区背景保持不透明，新标题栏控件所在标题栏保持不透明；
- 会话历史页：历史内容保持不透明，新标题栏控件所在标题栏保持不透明；
- 关闭“背景铺满工作区”时，不得因为布局控制而把背景扩展到侧栏或 Tab 区域；
- 隐藏/恢复区域只改变布局占位，不改变背景图片的加载和裁剪策略。

## 7. 国际化与无障碍

新增文案统一放在 `src/lib/i18n.ts`，至少覆盖：

- 项目侧栏显示/隐藏；
- 辅助面板显示/隐藏；
- Workspan Tab 栏显示/隐藏；
- 自定义布局；
- 辅助面板停靠左侧/右侧；
- Workspan Tab 栏位于顶部/底部；
- 恢复默认布局；
- Workspan 未启用时的不可用提示。

按钮必须有可读的 `aria-label`，状态按钮使用 `aria-pressed`，菜单项使用菜单语义和选中状态。中英文切换不能改变现有时间格式约束。

## 8. 验证策略

- 纯函数测试：默认值、版本迁移、非法值回退、布局更新；
- 静态契约测试：标题栏挂载控件、设置页移除旧入口、三个可见性状态正确传递；
- 前端类型检查：`npx tsc --noEmit`；
- Rust 检查：本阶段无 Rust 改动时至少确认不受影响；
- 手工验证：普通/最大化/窄窗口、左右停靠、上下 Tab、隐藏恢复、刷新重启、中英文、背景铺满开关、设置页和历史页。
