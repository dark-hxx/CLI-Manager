# Changelog
## [V0.0.9] - 2026-04-21

### 精简模式启动器

- 新增精简模式：隐藏内嵌终端，并将项目启动行为切换为外部终端启动
- 将精简模式入口移动到主页面侧栏底部，并统一“外部终端”和“精简模式”的卡片样式
- 调整精简模式的窗口宽度切换逻辑：开启时收窄到 350，关闭时恢复到进入前宽度
- 同步更新本地项目说明和忽略规则等当前工作区内的相关改动
## [V0.0.8] - 2026-04-02

### 版本号显示与更新检测

- 新增 `src-tauri/src/commands/version.rs`：`get_app_version` command，返回应用版本号与名称。
- 新增 `src/stores/updateStore.ts`：更新状态管理，支持检查更新、状态流转、错误处理。
- 新增 `src/components/settings/AboutSection.tsx`：设置页面「关于」区块，显示当前版本号与检查更新按钮。
- 修改 `src/components/settings/pages/GeneralSettingsPage.tsx`：底部集成 AboutSection 组件。
- 更新检测通过 GitHub API（`dark-hxx/CLI-Manager` 仓库）获取最新 Release，支持版本比较与 Release Notes 展示。
- 有新版本时显示版本卡片，点击「下载更新」通过 `tauri-plugin-opener` 打开浏览器。

## [V0.0.7] - 2026-03-31

### WebDAV 云同步

- 新增 `src-tauri/src/webdav/` 目录：WebDAV 客户端实现，支持 CONNECT/GET/PUT/DELETE 请求。
- 新增 `src-tauri/src/sync/` 目录：同步数据打包、解包、冲突检测逻辑。
- 新增 `src-tauri/src/commands/sync.rs`：`sync_test_connection` / `sync_upload` / `sync_download` Tauri commands。
- 新增 `src/stores/syncStore.ts`：同步状态管理，支持 WebDAV 配置、上传/下载、冲突解决。
- 新增 `src/components/settings/pages/SyncSettingsPage.tsx`：WebDAV 配置页面，支持 URL、用户名、密码输入与连接测试。
- 新增 `src/components/sidebar/SyncStatusIndicator.tsx`：侧栏底部同步状态指示器，显示同步状态、上次同步时间、上传/下载按钮。
- SQLite migration v7：新增 `sync_meta` 表，存储设备 ID 与最后同步时间。
- 同步范围：项目、分组、命令模板；支持冲突检测与本地/远程优先解决策略。

### 终端会话恢复

- 新增 `src/stores/sessionStore.ts`：使用 `tauri-plugin-store` 持久化终端会话元数据到 `sessions.json`。
- 修改 `src/lib/types.ts`：`TerminalSession` 扩展 `cwd`/`shell`/`envVars`/`startupCmd` 字段；新增 `PersistedSplit` 类型。
- 修改 `src/stores/terminalStore.ts`：新增 `restoreSessions` 方法，刷新后重建 PTY 并恢复分屏布局；应用关闭时清除持久化数据。
- 修改 `src/App.tsx`：初始化流程加载 `sessionStore` 与 `syncStore`，调用 `restoreSessions` 恢复终端。

## [V0.0.6] - 2026-03-26

### UI Refactor
- 设置系统完成容器拆分：新增 `src/components/settings/` 下布局、导航、顶部栏与四个页面（通用/终端主题/快捷键/命令模板），`SettingsModal` 改为页面级容器。
- 设置弹层改为全屏覆盖并保留系统标题栏区域，修复打开设置后右侧大面积留白与布局错位问题；`SettingsModal` 通过 `Portal` 挂载，避免受侧栏容器裁剪影响。
- 主界面按 `prototype/风格/DESIGN.md` 重构视觉体系：落地 Surface Layering、No-Line Rule、Primary 渐变 CTA、Glass 浮层与统一状态层级。
- 侧栏与终端工作区重构：`Sidebar`、`ProjectTree`、`TreeNodeItem`、`TerminalTabs`、`WindowTitleBar`、`EmptyState` 样式统一，去除硬分割线，改为背景层级区分。
- Command Template / Command History 面板样式统一为玻璃浮层；上下文菜单、按钮、输入框、分段控件统一交互反馈与 focus ring。

### 主题与可读性修复
- 修复“浅色应用 + 黑色终端”场景下终端空态文案对比度不足问题：新增 inverse 文本 token，并为终端空态启用高对比模式。
- 增强“配色方案卡片”选中态可见性：增加明显高亮环、选中徽标与色块强化，提升当前方案识别效率。
- 修复配色联动问题：浅色配色方案不再固定红色强调色，左侧树与选中态颜色随 `warm-paper / cream-green / ink-red` 方案切换。

### 其他
- 终端主题预设补充元数据（`family` / `tone`）用于主题页分类展示与筛选。
- 命令模板作用域支持强化（全局/项目/会话）并补充相关设置页交互收口。

## [V0.0.5] - 2026-03-25

### 分析看板图表升级（S1~S4）

#### S1：趋势 + Token 构成
- 新增 `src/components/stats/StatsTrendChart.tsx`：会话/消息趋势组合图，支持 hover、键盘聚焦与日期下钻。
- 新增 `src/components/stats/StatsTokenDonut.tsx`：输入/输出 Token 环形构成图。
- `src/components/stats/StatsPanel.tsx`：接入 C1/C2/C3 到主分析区。

#### S2：项目与模型构成
- 新增 `src/components/stats/StatsProjectBar.tsx`：项目活跃 TopN 横向柱图，支持点击柱条按项目过滤。
- 新增 `src/components/stats/StatsModelComposition.tsx`：模型构成图（前 5 模型 + 其他合并）。
- `src/components/stats/StatsPanel.tsx`：接入 C4/C5 图表组件。

#### S3：热力图统一交互
- `src/components/stats/TimelineHeatmap.tsx`：统一图表交互样式（hover/selected 高亮、键盘方向键导航、Enter/Space 下钻、增强 a11y 标签）。

#### S4：后端扩展并落地
- `src-tauri/src/commands/history.rs`：扩展 `history_get_stats` 返回字段：
  - `daily_series`
  - `source_distribution`
  - `project_efficiency`
  - `hourly_activity`
- `src/lib/types.ts` + `src/stores/historyStore.ts`：补充新字段类型定义与归一化。
- 新增图表组件：
  - `src/components/stats/StatsTokenTrendChart.tsx`（C7 Token 日趋势）
  - `src/components/stats/StatsSourceComparisonChart.tsx`（C8 来源对比）
  - `src/components/stats/StatsProjectEfficiencyScatter.tsx`（C9 项目效率散点）
  - `src/components/stats/StatsHourlyActivityChart.tsx`（C10 活跃时段分布）
- `src/components/stats/StatsPanel.tsx`：接入 C7~C10。

### 分析看板

#### 历史统计后端
- `src-tauri/src/commands/history.rs`：新增 `history_get_stats`，支持按来源/项目/时间范围聚合历史会话统计。
- 统计维度包含：会话数、消息数、输入/输出 Token、项目活跃排行、模型占比、日级热力图数据。
- `src-tauri/src/lib.rs`：注册 `history_get_stats` command。

#### 前端数据与类型
- `src/lib/types.ts`：新增 Stats 相关类型（项目排行、模型占比、热力图、整体 payload）。
- `src/stores/historyStore.ts`：新增 `loadingStats`、`stats`、`loadStats`，并补充后端返回结构归一化。

#### 分析看板 UI
- 新增 `src/components/stats/StatsPanel.tsx`：统计卡片、项目排行、模型占比、日期会话清单。
- 新增 `src/components/stats/TimelineHeatmap.tsx`：活跃热力图，支持点击日期。

#### 入口与挂载调整
- `src/components/sidebar/index.tsx`：新增看板入口按钮，位置在“设置”按钮左侧。
- `src/App.tsx`：全局挂载 `StatsPanel`，避免只覆盖侧边栏区域。
- `src/components/HistoryWorkspace.tsx`：移除历史详情区内的看板入口，防止入口重复。

### 核心增强

#### 历史会话列表与交互
- `src/components/HistoryWorkspace.tsx`：新增会话时间分组（Today/Yesterday/This Week/This Month/Earlier）
- `src/stores/settingsStore.ts`：新增 `historySidebarWidth`，历史侧栏宽度可持久化
- `src/components/HistoryWorkspace.tsx`：优化左右拖拽性能（拖动过程帧节流，松手后持久化）
- `src/components/HistoryWorkspace.tsx`：修复拖拽宽度计算问题（相对容器左边界计算），恢复可拖动性
- `src/components/HistoryWorkspace.tsx`：移除分支筛选（历史日志分支值稳定性不足）

#### Diff 视图增强
- 新增 `src/components/history/DiffModal.tsx`：支持 Unified Diff 与 Codex `*** Begin Patch` 风格展示
- `src/components/HistoryWorkspace.tsx`：接入 Diff 入口与“跳回触发消息”联动
- `src/components/history/DiffModal.tsx`：新增行级高亮（新增/删除/hunk/header）
- `src/components/history/DiffModal.tsx` + `src/App.css`：修复横向滚动体验，代码块内独立滚动并保留可见滚动条样式

#### 历史解析兼容增强
- `src-tauri/src/commands/history.rs`：增强 `parse_message`，支持从 `custom_tool_call` / `tool_call` / `file-history-snapshot` 中提取 patch 内容
- `src-tauri/src/commands/history.rs`：新增 `looks_like_patch` 规则，提升 diff 命中率并降低无关内容噪声

#### 模板作用域增强
- `src/stores/templateStore.ts`：新增会话级模板（内存态）与生命周期清理逻辑
- `src/components/CommandTemplatePanel.tsx`：模板创建支持全局/项目/会话作用域
- `src/components/CommandPalette.tsx`：模板检索按当前项目 + 当前会话上下文合并

### 验收

#### 历史会话后端能力
- 新增 `src-tauri/src/commands/history.rs`，提供 `history_list_sessions`、`history_get_session`、`history_search` 三个 Tauri commands
- 支持扫描 Claude 与 Codex 的本地会话 JSONL 文件，提取消息、标题、时间、分支等摘要信息
- `src-tauri/src/commands/mod.rs` / `src-tauri/src/lib.rs` 注册历史命令
- SQLite migration v6：新增 `session_meta` 表与索引（别名、收藏、标签等会话元数据）

#### 历史会话前端工作区
- 新增 `src/stores/historyStore.ts`，统一管理历史工作区状态、会话列表、全局搜索、会话详情与元数据更新
- 新增 `src/components/HistoryWorkspace.tsx`，支持：
  - 来源筛选（Claude/Codex）
  - 全局搜索命中跳转
  - 会话内搜索高亮与上下跳转
  - 别名/标签编辑与收藏
- `src/components/TerminalTabs.tsx` 集成 History 入口按钮并支持切换历史工作区
- `src/components/CommandPalette.tsx` 新增“打开历史会话”动作
- `src/hooks/useKeyboardShortcuts.ts` 新增：
  - `Ctrl+K` 打开历史会话并聚焦全局搜索
  - `Ctrl+F` 在历史工作区内聚焦会话内搜索
- `src/lib/types.ts` 新增 History 相关类型定义

#### 其他
- `src-tauri/.gitignore` 增加 `/target-check*/`，避免临时校验目录入库

## [V0.0.4] - 2026-03-18

### UI 优化（按 `ui-optimization.md` 实施）

#### 设计系统与视觉统一
- `App.css` 重构为 Tailwind CSS 4 `@theme` Token 模式，统一主题色与动画时长变量
- 新增 `lucide-react` 图标体系，替换主要内联 SVG，统一图标尺寸与线宽风格
- `App.tsx` 挂载 `sonner` 的 `<Toaster />`，建立全局通知能力（含主题适配）

#### 侧边栏架构重构
- `Sidebar.tsx` 拆分为 `src/components/sidebar/` 模块化结构（`index.tsx` + `TreeNodeItem.tsx` + `TreeContext.tsx`）
- 新增树操作上下文 `TreeContext`，减少层层透传回调，提升可维护性
- 新增侧边栏拖拽调宽（180-500px）并持久化到 `settingsStore.sidebarWidth`

#### 交互体验增强
- 新增 `src/components/ui/EmptyState.tsx` 与 `src/components/ui/Skeleton.tsx`，用于终端空态与项目区加载态
- `TerminalTabs.tsx` 终端空态升级，提供显式引导动作
- `ConfigModal.tsx` / `ConfirmDialog.tsx` / `SettingsModal.tsx` / `CommandPalette.tsx` 等组件统一进入动画
- `src-tauri/tauri.conf.json` 增加窗口最小尺寸（`minWidth: 800`, `minHeight: 500`）

### Bug 修复
- **[High]** 终端 Tab 切换后内容混乱
  - `XTermTerminal.tsx`：ResizeObserver 回调增加可见尺寸守卫，隐藏 Tab 不再向 PTY 发送 `0 cols/rows`
  - `XTermTerminal.tsx`：新增激活态重算逻辑，Tab 切回时主动 `fit()` 恢复终端网格
  - `SplitTerminalView.tsx` / `TerminalTabs.tsx`：透传 `isActive` 至终端组件
- **[High]** 内置终端在底部输入中文时，候选框触发界面抽搐变形
  - `XTermTerminal.tsx`：`fit()` 改为 `requestAnimationFrame` 合并调度，避免高频重复重排
  - `XTermTerminal.tsx`：ResizeObserver 增加尺寸去重（微小抖动不触发 fit）
  - `XTermTerminal.tsx`：输入法组合输入（`compositionstart/end`）期间暂停自动 fit，结束后一次性重算
- **[Medium]** 外部终端启动失败缺少可见反馈
  - `externalTerminal.ts`：启动异常从控制台日志升级为 `toast.error` 用户提示

## [V0.0.3] - 2026-03-16

### 功能扩展

#### 3.2 终端分屏
- 新增 `src/components/SplitTerminalView.tsx` — 分屏渲染组件，支持水平/垂直分割，可拖拽分隔条调整比例（20%-80%）
- 修改 `src/stores/terminalStore.ts` — 新增 `SplitState` 类型、`splits` 状态、`splitTerminal`/`unsplitTerminal`/`setSplitRatio` 方法
- 修改 `src/components/TerminalTabs.tsx` — 用 SplitTerminalView 替换直接渲染，右键菜单增加分屏/取消分屏选项

#### 3.3 命令面板（Ctrl+P）
- 新增 `src/components/CommandPalette.tsx` — 全局命令面板，模糊搜索项目/命令模板/操作，键盘导航（↑↓ 选择、Enter 执行、Escape 关闭）
- 修改 `src/hooks/useKeyboardShortcuts.ts` — `Ctrl+P` 触发命令面板，不受输入框焦点影响
- 修改 `src/stores/settingsStore.ts` — 新增 `commandPalette` 快捷键，加载时合并新旧快捷键配置防止字段缺失
- 修改 `src/components/SettingsModal.tsx` — 快捷键设置面板增加"命令面板"项
- 修改 `src/App.tsx` — 挂载 CommandPalette 组件

#### 终端 Tab 拖拽排序
- 修改 `src/stores/terminalStore.ts` — 新增 `reorderSessions` 方法
- 重写 `src/components/TerminalTabs.tsx` — 提取 `SortableTab` 组件，集成 dnd-kit 水平拖拽排序，5px 激活距离，拖拽半透明反馈

### 外部终端增强
- 新增 `src-tauri/src/commands/shell.rs` — `open_windows_terminal` Tauri command，支持多 Tab 批量打开、按项目 Shell 配置启动
- 修改 `src/lib/externalTerminal.ts` — 前端 `openWindowsTerminal` 接口对接后端 command

### 日志系统
- 新增 `src-tauri/src/commands/logging.rs` — `set_debug_logging` command，支持运行时切换日志级别
- 新增 `src/lib/logger.ts` — 前端日志桥接，`attachConsole` 接收 Rust 日志，`logInfo`/`logWarn`/`logError` 显式记录

### Bug 修复
- **[High]** `lib.rs` — 日志时区从 UTC 改为本地时区（`TimezoneStrategy::UseLocal`）
- **[High]** `shell.rs` — 外部终端标题被 Shell 覆盖，添加 `--suppressApplicationTitle` 参数
- **[High]** `XTermTerminal.tsx` — 终端内 Ctrl+V 粘贴无效，添加剪贴板读取并写入 PTY
- **[High]** `logger.ts` — `wrapConsole` + `attachConsole` + Webview 日志目标形成递归死循环，移除 `wrapConsole` 修复

## [V0.0.2] - 2026-03-13

### 功能扩展

#### 2.1 命令历史记录与搜索
- 新增 `src/stores/commandHistoryStore.ts` — 命令历史 Zustand store，SQLite 持久化，最大 1000 条 FIFO 清理
- 新增 `src/components/CommandHistoryPanel.tsx` — 终端 Tab 栏命令历史下拉面板，支持搜索和一键重放
- 修改 `src/components/XTermTerminal.tsx` — 添加 `inputBuffer` 追踪键入，Enter 时自动记录命令
- 修改 `src/components/TerminalTabs.tsx` — 集成 CommandHistoryPanel 按钮
- 修改 `src/lib/types.ts` — 新增 `CommandHistoryEntry` 接口
- SQLite migration v4：`command_history` 表 + 索引（project_id、executed_at）
- 自动去重：同项目连续相同命令不重复记录

#### 2.2 拖拽排序
- 新增依赖 `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`
- 修改 `src/components/Sidebar.tsx` — 集成 dnd-kit，`TreeNodeItem` 使用 `useSortable` hook
- 支持根级和分组内拖拽排序，排序结果持久化到 SQLite
- 修改 `src/stores/projectStore.ts` — 新增 `reorderItems()` 方法

#### 2.3 空状态引导
- 修改 `src/components/Sidebar.tsx` — 无项目时显示欢迎信息、快速添加按钮和使用提示

#### 2.4 项目健康检查
- 新增 `src-tauri/src/commands/fs.rs` — `check_paths_exist` Tauri command，批量验证路径有效性
- 修改 `src-tauri/src/commands/mod.rs` — 注册 `fs` 模块
- 修改 `src-tauri/src/lib.rs` — 注册 `check_paths_exist` handler
- 修改 `src/stores/projectStore.ts` — `fetchAll()` 调用路径验证，维护 `projectHealth` 状态
- 修改 `src/components/Sidebar.tsx` — 路径无效时项目节点显示警告三角图标

#### 2.5 多 Shell 支持
- SQLite migration v5：`projects` 表新增 `shell` 列（默认 `powershell`）
- 修改 `src-tauri/src/pty/manager.rs` — 新增 `resolve_shell()` 支持 powershell/cmd/pwsh/wsl/bash
- 修改 `src-tauri/src/commands/terminal.rs` — `pty_create` 新增 `shell` 参数
- 修改 `src/stores/terminalStore.ts` — `createSession` 传递 shell 参数
- 修改 `src/components/ConfigModal.tsx` — 新增 Shell 下拉选择器
- 修改 `src/lib/types.ts` — Project 接口新增 `shell` 字段，新增 `SHELL_OPTIONS` 常量
- 修改 `src/lib/externalTerminal.ts` — 支持按项目配置启动不同 Shell 的外部终端

### Bug 修复
- **[High]** `externalTerminal.ts` — 外部终端硬编码 powershell，改为根据项目 shell 配置动态选择
- **[Medium]** `Sidebar.tsx` — "外部 PowerShell" 标签改为 "外部终端"，匹配多 Shell 支持

### 其他变更
- 替换应用图标为 folder+shell 风格图标（512x512 PNG → `npx tauri icon` 生成全尺寸）

### 设置系统

#### 2.1 集中设置入口
- 新增 `src/components/SettingsModal.tsx` — 四 Tab 设置弹窗（通用 / 终端主题 / 快捷键 / 命令模板）
- 修改 `src/components/Sidebar.tsx` — Footer 添加齿轮按钮打开设置弹窗

#### 2.2 终端主题预设注册表
- 重写 `src/lib/terminalThemes.ts` — 扩展为 10 套预设配色（Tokyo Night Dark/Light、Dracula、Monokai、Nord、Solarized Dark/Light、One Dark、GitHub Dark/Light）
- 修改 `src/stores/settingsStore.ts` — 新增 `terminalThemeName` 字段，支持 `"auto"`（跟随应用主题）或按 ID 指定
- 修改 `src/components/XTermTerminal.tsx` — 新增 `terminalThemeName` prop，按名称获取主题
- 修改 `src/components/TerminalTabs.tsx` — 从 store 读取 `terminalThemeName` 传递

#### 2.3 快捷键可配置
- 修改 `src/stores/settingsStore.ts` — 新增 `keyboardShortcuts` 字段（`ShortcutAction` → 组合键映射）
- 重写 `src/hooks/useKeyboardShortcuts.ts` — 从 store 读取快捷键替代硬编码，导出 `eventToCombo` 工具函数
- 设置弹窗快捷键 Tab 支持录制模式修改快捷键、恢复默认

#### 2.4 命令模板管理增强
- 设置弹窗命令模板 Tab 支持完整的增删改操作、行内编辑

### Bug 修复
- **[High]** `TerminalTabs.tsx` — 将 New/Templates 按钮移出 `overflow-x-auto` 滚动容器，修复下拉面板被裁剪导致 Templates 按钮"无法点击"的问题，同时保证按钮在标签过多时不会被挤走

### 功能扩展

#### 1.1 命令模板系统
- 新增 `src/stores/templateStore.ts` — 命令模板 Zustand store，支持 SQLite CRUD
- 新增 `src/components/CommandTemplatePanel.tsx` — 终端 Tab 栏内的命令模板下拉面板
- 修改 `src/lib/types.ts` — 新增 `CommandTemplate`、`CreateTemplateInput`、`UpdateTemplateInput` 类型定义
- 支持变量替换：`${projectPath}`、`${projectName}`
- 模板区分全局与项目级，按当前活跃项目自动筛选

#### 1.2 终端主题跟随应用主题
- 新增 `src/lib/terminalThemes.ts` — 提供 dark/light 两套终端配色（Tokyo Night 风格）
- 修改 `src/components/XTermTerminal.tsx` — 新增 `resolvedTheme` prop，主题切换时仅更新颜色不重建终端实例
- 修改 `src/components/TerminalTabs.tsx` — 透传 `resolvedTheme` 至 XTermTerminal

#### 1.3 基础键盘快捷键
- 新增 `src/hooks/useKeyboardShortcuts.ts` — 全局键盘快捷键
  - `Ctrl+Shift+T` 新建终端
  - `Ctrl+W` 关闭当前终端
  - `Ctrl+Tab` / `Ctrl+Shift+Tab` 切换终端标签
- 修改 `src/App.tsx` — 注册 `useKeyboardShortcuts()` hook

#### 1.4 项目/终端状态指示器
- 修改 `src-tauri/src/pty/manager.rs` — 新增 `PtyProcessStatus` 结构体，reader 线程退出时上报进程状态（running/exited/error）
- 修改 `src-tauri/src/commands/terminal.rs` — 新增 `pty_status` command
- 修改 `src-tauri/src/lib.rs` — 注册 `pty_status` handler
- 修改 `src/stores/terminalStore.ts` — 新增 `SessionStatus` 类型，监听 `pty-status-{sessionId}` 事件
- 修改 `src/components/TerminalTabs.tsx` — Tab 标签前显示状态圆点（绿/橙/红）
- 修改 `src/components/Sidebar.tsx` — 项目节点显示聚合状态指示器，使用 `useCallback` 优化

### 审计修复
- **[Critical]** `XTermTerminal.tsx` — 从初始化 `useEffect` 依赖数组移除 `resolvedTheme`，防止主题切换时销毁终端缓冲区
- **[High]** `manager.rs` — `try_wait()` 的 `Err(_)` 分支映射为 `"error"` 而非 `"exited"`
- **[Medium]** `TerminalTabs.tsx` / `Sidebar.tsx` — 状态指示点添加 `role="status"` 和 `aria-label` 无障碍属性
- **[Medium]** `Sidebar.tsx` — `getProjectStatus` 改用 `useCallback` 稳定引用，状态回退使用 `?? "running"`
