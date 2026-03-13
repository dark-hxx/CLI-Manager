# CLI-Manager

一款 **轻量、高性能的 Windows 桌面应用**，用于集中管理多个 PowerShell 项目终端，解决多窗口切换、重复输入命令的痛点，提升开发工作流效率。

## 核心功能

- **统一工作区管理**：项目分组、排序、快速搜索。
- **一键启动**：支持目录内批量启动终端，支持筛选/自定义选中批量启动。
- **终端内嵌**：应用内终端面板，Tab 管理多会话。
- **外部终端模式**：开关控制，使用 Windows Terminal（`wt`）在一个窗口内打开多个 Tab。
- **项目配置**：独立配置路径、CLI 工具、启动命令、环境变量。
- **右键菜单**：菜单树与终端 Tab 支持快捷操作。
- **集中设置**：齿轮入口打开设置弹窗，整合通用偏好、终端主题、快捷键、命令模板管理。
- **终端主题**：10 套预设配色（Dracula、Nord、Monokai 等），支持跟随应用主题自动切换。
- **快捷键配置**：新建/关闭终端、切换标签等快捷键可自定义录制。
- **命令模板**：全局或项目级模板，支持变量替换（`${projectPath}`、`${projectName}`），一键发送到终端。

## 技术栈

- **Tauri 2.x**
- **Rust**（PTY 进程管理）
- **React 19 + TypeScript + Vite 7**
- **xterm.js**
- **SQLite（tauri-plugin-sql）**
- **tauri-plugin-store**
- **Zustand**
- **Tailwind CSS 4**

## 开发与构建

```bash
npm install
npm run tauri dev
npm run tauri build
npx tsc --noEmit
cd src-tauri && cargo check
cd src-tauri && cargo test
```