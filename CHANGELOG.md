# Changelog

## [Unreleased] - 2026-03-13

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
