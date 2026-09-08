# 修复文件浏览器右键菜单遮挡

## Goal

确保文件浏览器在项目侧栏和终端辅助面板中的所有右键菜单都由 Radix 按应用视口完成碰撞避让，不再被辅助面板边界或窗口底部裁剪，同时保持现有菜单配色、操作与键盘交互。

## Background

- 用户截图显示：同一文件浏览器菜单在列表中部可完整显示，在窗口底部附近右键时下半部分被裁掉。
- `src/components/files/FileExplorerSidebar.tsx:698,1494` 当前把菜单 Portal 容器设为文件浏览器根元素，并将该容器传给文件树、文件搜索、代码搜索和根空白区域四类菜单。
- `src/components/terminal/ResizableTerminalPanelFrame.tsx:147` 的终端辅助面板使用 `overflow-hidden`；`src/styles/components.css:5431` 的 `.ui-terminal-side-panel-frame` 使用 `transform: translateX(0)`。transform 创建 fixed 定位包含块，使嵌套 Portal 中的 Radix fixed 浮层受辅助面板 overflow 裁剪。
- `src/components/ui/context-menu.tsx` 已支持自定义 Portal 容器，但把共享的 `.context-menu` 直接加在 Radix `Content` / `SubContent` 上；该样式的 `position: fixed` 使内容脱离 Radix Popper wrapper 的正常测量流。
- `src/components/ui/Portal.tsx` 已提供挂载到 `document.body` 的通用 Portal。
- 第一轮只把 Portal 宿主移到 `document.body`。用户复测仍能稳定看到菜单在窗口右侧/底部被裁剪，证明祖先裁剪只是一个触发条件，并非完整根因。
- 当前 `master` 与 `origin/master` 同步（领先 0、落后 0），但工作区已有 13 项未提交改动；本任务必须保留这些改动。
- GitNexus 索引落后 9 个提交，并未返回相关组件符号；impact 结果为 `UNKNOWN`。发现清单因此按仓库规则降级为提交历史、前端契约与全文检索。

## Root-cause statement

缺陷跨越两个浮层边界：文件浏览器把 Portal 宿主放在 transform/overflow 裁剪子树内，同时共享 `.context-menu { position: fixed }` 又把 Radix 内容子节点移出 Popper wrapper 的正常流，导致 wrapper 无法测得完整菜单宽高。完整修复必须同时把主题化宿主移到 `document.body`，并让 Radix `Content` / `SubContent` 参与 wrapper 测量；任何单边修复都不能保证菜单在所有窗口边缘完整显示。

## Requirements

- R1：文件浏览器菜单 Portal 宿主必须位于 `document.body`，不得继续作为 `.ui-terminal-side-panel-frame` 或 `.ui-sidebar-shell` 的后代。
- R2：Portal 宿主必须继续承载 `panelStyle`，保证终端辅助面板中的菜单保留终端面板语义色；项目侧栏中的菜单继续跟随应用主题。
- R3：文件树节点、文件名搜索结果、代码搜索结果和根空白区域四类菜单继续共用同一 Portal 宿主。
- R4：保留 Radix 现有碰撞检测、焦点管理、Escape/外部点击关闭与菜单动作；不得引入手写 clientX/clientY 定位。
- R5：保留 `PathCopyMenu` 的原位替换菜单以及本地/WSL/SSH/Worktree、读写/只读和 Live Server 条件动作。
- R6：共享 Radix `ContextMenuContent` 与 `ContextMenuSubContent` 必须使用专用类恢复正常流测量；手工坐标菜单继续使用基础 `.context-menu { position: fixed }`。
- R7：不改变终端辅助面板的 transform、进入动画和 overflow 布局；共享组件的样式修复适用于所有 Radix 消费者，但不得改变它们的动作和视觉皮肤。
- R8：版本记录写入 V1.3.9；本修复不新增用户可见文案，因此无需增加翻译键。
- R9：文件、目录及两类搜索结果的右键触发行在菜单打开期间必须复用选中高亮；关闭菜单后自动恢复原选择，不得仅为高亮而打开文件或改变编辑器活动项。

## Scenario coverage

- 展示位置：项目侧栏；合并终端辅助面板；独立文件辅助面板。
- 停靠位置：辅助面板左停靠、右停靠。
- 触发区域：文件、目录、文件名搜索结果、代码搜索结果、根空白区域。
- 垂直位置：窗口顶部、中部、靠近底部；窗口高度不足时沿用菜单内部滚动。
- 项目环境：本地 Windows、WSL、SSH 只读项目、Worktree；环境不改变 Portal 语义。
- 菜单内容：普通文件、HTML/Live Server、Git 变更文件、目录、根目录、`PathCopyMenu` 原位替换。
- 主题：浅色/深色应用主题及终端辅助面板主题。
- 分屏、Workspan、焦点模式、窗口失焦/最小化和 Hook 安装状态不改变菜单宿主；没有右键激活事件时不打开菜单。

## Discovery list

- [x] `src/components/files/FileExplorerSidebar.tsx`：缺陷来源与四类菜单 Portal 宿主；本任务修改。
- [x] `src/components/ui/Portal.tsx`：现有 body Portal，可直接复用；确认无需修改。
- [x] `src/components/ui/context-menu.tsx`：`Content` / `SubContent` 同时继承固定定位样式，破坏 Popper 测量；本任务修改共享包装层。
- [x] `src/components/terminal/ResizableTerminalPanelFrame.tsx`：提供 transform/overflow 触发状态，布局行为有效；确认不修改。
- [x] `src/styles/components.css`：基础 `.context-menu` 需保留给手工定位菜单；新增 Radix 专用正常流覆盖。
- [x] `src/components/PathCopyMenu.tsx`：菜单内容原位替换依赖父菜单；纳入回归验证，确认无需修改。
- [x] `src/components/sidebar/index.tsx`、`src/components/history/HistoryListPane.tsx`：手工 `.context-menu` 依赖 fixed 坐标；确认基础样式不可全局改为 relative。
- [x] `src/components/TerminalTabs.tsx`、`src/components/files/FileEditorTabs.tsx`、`src/components/git/GitTreeNode.tsx`、`src/components/history/*`：共享 Radix 包装层的消费者；纳入回归范围，无需逐调用点修改。
- [x] `scripts/fileExplorerPathActions.test.mjs`：追加 Portal 边界与 Popper 测量边界两类回归断言。
- [x] `.trellis/spec/frontend/quality-guidelines.md`：记录 Portal 宿主和 Radix 内容测量两个不可分割的定位契约；本任务修改。
- [x] `src/lib/i18n.ts`：无新增文案；确认无需修改。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：按 V1.3.9 更新交付记录。

## Acceptance Criteria

- [x] AC1：在终端辅助面板底部附近右键文件或目录时，完整菜单向上避让并保持在应用视口内，不再被面板或窗口底边裁剪。
- [x] AC2：项目侧栏及左/右停靠、合并/独立终端辅助面板中，菜单均能正确避让左右和上下边缘。
- [x] AC3：四类菜单触发面共用 body 级宿主；Radix wrapper 能测得完整内容尺寸，菜单超过可用高度时使用现有内部滚动而不是溢出视口。
- [x] AC4：右键目标行在菜单打开期间保持选中高亮（含忽略项），关闭后恢复原选择；终端面板菜单配色、浅深主题、菜单动作、键盘导航、关闭行为以及 `PathCopyMenu` 原位替换无回归。
- [x] AC5：静态回归测试、`npx tsc --noEmit` 和 `npm run build` 通过；人工验证项按前端规范列出，不由 AI 启动 Tauri 应用。
- [x] AC6：V1.3.9 的 `CHANGELOG.md` 与“文件浏览器搜索与菜单”功能清单准确记录本修复，且现有未提交内容未被覆盖。

## Out of scope

- 自研浮层定位器或重写 Radix 碰撞算法。
- 修改终端辅助面板布局、动画、transform 或裁剪策略。
- 调整菜单动作、文字、顺序、权限或新增依赖。
- 修改项目树、Git、历史等非文件浏览器右键菜单的动作或视觉设计。
