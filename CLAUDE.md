# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CLI-Manager 是一款 Windows 桌面应用，用于集中管理多个开发项目的 CLI 终端（支持 PowerShell / CMD / PWsh / WSL / Bash）。

## 技术栈

- **框架**: Tauri 2.x
- **后端**: Rust（PTY 进程管理 via portable-pty）
- **前端**: React 19 + TypeScript + Vite 7
- **终端**: xterm.js + FitAddon + WebglAddon
- **数据库**: SQLite（tauri-plugin-sql，前端直接访问）
- **KV 存储**: tauri-plugin-store（用户偏好）
- **状态管理**: Zustand
- **样式**: Tailwind CSS 4（Vite 插件模式）
- **包管理**: npm

## 开发命令

```bash
npm install                          # 安装前端依赖
npm run tauri dev                    # 启动开发模式（Vite + Tauri 窗口）
npm run tauri build                  # 构建生产包
npx tsc --noEmit                     # 前端类型检查
cd src-tauri && cargo check          # Rust 编译检查
cd src-tauri && cargo test           # Rust 测试
npm run tauri add <plugin>           # 安装 Tauri 插件
```

## 架构

### 前后端分工
- **Rust 后端**（`src-tauri/src/`）：PTY 会话管理（多 Shell 支持）、文件系统操作（路径验证）、外部终端调用、历史会话索引与检索
- **前端**（`src/`）：项目 CRUD 通过 `@tauri-apps/plugin-sql` 直接操作 SQLite，UI 渲染和状态管理

### IPC 通信
- 前端 → 后端：`invoke('pty_create' | 'pty_write' | 'pty_resize' | 'pty_close' | 'check_paths_exist' | 'open_windows_terminal' | 'set_debug_logging' | 'history_list_sessions' | 'history_get_session' | 'history_search', args)`
  - `pty_create` 接受 `shell` 参数指定 Shell 类型
  - `check_paths_exist` 批量验证项目路径有效性
  - `open_windows_terminal` 批量打开外部终端 Tab
  - `history_list_sessions` 获取历史会话摘要列表（支持来源过滤）
  - `history_get_session` 读取单个会话详情
  - `history_search` 执行跨会话全文搜索
- 后端 → 前端：`app_handle.emit("pty-output-{sessionId}", data)` 推送 PTY 输出

### 关键目录
```
src/
  components/       # React 组件（Sidebar, TerminalTabs, SplitTerminalView, XTermTerminal, CommandPalette, ConfigModal, CommandHistoryPanel, HistoryWorkspace）
  stores/           # Zustand stores（projectStore, terminalStore, settingsStore, commandHistoryStore, templateStore, historyStore）
  hooks/            # React hooks（useKeyboardShortcuts）
  lib/              # 工具（db.ts 数据库连接, types.ts 类型定义, externalTerminal.ts 外部终端, logger.ts 日志, terminalThemes.ts 终端主题）
src-tauri/src/
  lib.rs            # Tauri 入口，插件注册，migrations（v1-v6）
  commands/         # Tauri command handlers
    terminal.rs     # PTY 相关 commands（pty_create 支持 shell 参数）
    fs.rs           # 文件系统 commands（check_paths_exist）
    shell.rs        # 外部终端 commands（open_windows_terminal）
    logging.rs      # 日志 commands（set_debug_logging）
    history.rs      # 历史会话 commands（list/get/search）
  pty/
    manager.rs      # PtyManager：ConPTY 会话生命周期管理，多 Shell 支持
```

### 数据层
- SQLite 表：`projects`（项目配置，含 shell 字段）、`groups`（项目分组）、`command_templates`（命令模板）、`command_history`（命令历史）、`session_meta`（历史会话元数据）
- migrations 定义在 `src-tauri/src/lib.rs`（v1-v6）
- 前端通过 `@tauri-apps/plugin-sql` 的 `Database.load("sqlite:cli-manager.db")` 直接执行 SQL
- 前端依赖 `@dnd-kit/core` + `@dnd-kit/sortable` 实现拖拽排序（侧边栏项目 + 终端 Tab）
