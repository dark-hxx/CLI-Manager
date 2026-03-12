# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CLI-Manager 是一款 Windows 桌面应用，用于集中管理基于 PowerShell 的多个开发项目的 CLI 工具（如 claude、codex）。

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
- **Rust 后端**（`src-tauri/src/`）：仅负责 PTY 会话管理（创建/写入/调整大小/关闭 PowerShell 进程）
- **前端**（`src/`）：项目 CRUD 通过 `@tauri-apps/plugin-sql` 直接操作 SQLite，UI 渲染和状态管理

### IPC 通信
- 前端 → 后端：`invoke('pty_create' | 'pty_write' | 'pty_resize' | 'pty_close', args)`
- 后端 → 前端：`app_handle.emit("pty-output-{sessionId}", data)` 推送 PTY 输出

### 关键目录
```
src/
  components/       # React 组件（Sidebar, TerminalTabs, XTermTerminal, ConfigModal）
  stores/           # Zustand stores（projectStore, terminalStore, settingsStore）
  lib/              # 工具（db.ts 数据库连接, types.ts 类型定义）
src-tauri/src/
  lib.rs            # Tauri 入口，插件注册，migrations
  commands/         # Tauri command handlers
    terminal.rs     # PTY 相关 commands
  pty/
    manager.rs      # PtyManager：ConPTY 会话生命周期管理
```

### 数据层
- SQLite 表：`projects`（项目配置）、`command_templates`（命令模板）
- migrations 定义在 `src-tauri/src/lib.rs`
- 前端通过 `@tauri-apps/plugin-sql` 的 `Database.load("sqlite:cli-manager.db")` 直接执行 SQL
