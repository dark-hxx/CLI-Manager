# Changelog

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
