# Changelog

## [V0.0.6] - 2026-03-24

### Phase P1 核心增强（不含 P1-1 Prompt Library）

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

#### 历史解析兼容增强（Codex）
- `src-tauri/src/commands/history.rs`：增强 `parse_message`，支持从 `custom_tool_call` / `tool_call` / `file-history-snapshot` 中提取 patch 内容
- `src-tauri/src/commands/history.rs`：新增 `looks_like_patch` 规则，提升 diff 命中率并降低无关内容噪声

#### 模板作用域增强
- `src/stores/templateStore.ts`：新增会话级模板（内存态）与生命周期清理逻辑
- `src/components/CommandTemplatePanel.tsx`：模板创建支持全局/项目/会话作用域
- `src/components/CommandPalette.tsx`：模板检索按当前项目 + 当前会话上下文合并

#### 说明
- 本版本变更摘要按要求不包含 `P1-1 Prompt Library（三级作用域）` 作为验收项。

## [V0.0.5] - 2026-03-20

### Phase P0 验收（CLI History Hub）

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

### P2 功能扩展

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

### P1 功能扩展

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

### P1 Bug 修复
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

### P0 功能扩展

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
