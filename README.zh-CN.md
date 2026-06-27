# CLI-Manager

> **Language**: [English](README.md) | 简体中文

<div align="center">

**🚀 跨平台 AI CLI 增强工作台**

[![Tauri](https://img.shields.io/badge/Tauri-2.x-blue?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-blue?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-latest-orange?logo=rust)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/dark-hxx/CLI-Manager)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue)](LICENSE)

专为 **Claude Code / Codex CLI** 深度优化的多项目终端管理器

[功能特性](#-核心特性) • [界面预览](#-界面预览) • [快速开始](#-快速开始) • [技术栈](#-技术栈) • [交流讨论](#-交流讨论)

</div>

---

## 💡 项目简介

CLI-Manager 是一款专注于 **AI CLI 工作流增强**的桌面应用，将多项目终端管理与 Claude Code / Codex CLI 深度集成。

> **平台支持**：Windows（完整测试） | macOS / Linux（实验性支持，欢迎反馈）

### 🎯 为什么选择 CLI-Manager？

在多项目并行开发中，你可能遇到这些痛点：

- ❌ Claude / Codex 跑任务时得盯着终端，错过权限请求就卡住
- ❌ 想回看某次会话改了什么代码，Claude 历史没有 Diff 视图
- ❌ 不知道这个月用了多少 Token、哪个项目最费钱
- ❌ 多个项目频繁切换终端，重复输入相同命令
- ❌ 想给不同项目用不同的 Claude 后端（官方 / 中转），每次手动改环境变量

**CLI-Manager 提供：**

✅ **实时 Hook 通知** — Claude 需要审批时桌面弹窗提醒，点击直接跳转<br>
✅ **会话实时统计** — 每个终端显示当前会话 Token 用量、费用、工具调用<br>
✅ **历史 Diff 回看** — 统一查看所有历史会话的代码变更，支持跳回触发消息<br>
✅ **用量分析看板** — 多维度统计（热力图、趋势图、效率散点）<br>
✅ **项目级供应商切换** — 一键切换 Claude 后端（官方 / 中转 / 自建），无需手动改配置<br>
✅ **灵活分屏布局** — 自由的终端分屏 + Tab 跨 pane 拖拽<br>
✅ **命令面板 & 模板** — `Ctrl+P` 快速启动项目 / 执行常用命令

---

## ✨ 核心特性

### 🔥 Claude Code / Codex CLI 深度集成

<table>
<tr>
<td width="50%">

#### 🔔 Hook 实时通知

- **权限审批提醒** — Claude 需要审批时桌面弹窗，点击跳转
- **任务状态同步** — 终端 Tab 实时显示运行中 / 待审批 / 完成 / 失败状态
- **OSC 133 Shell 集成** — 标准化命令边界检测
- **SessionStart 会话绑定** — 自动关联终端与 Claude 会话 ID

</td>
<td width="50%">

#### 📊 会话实时统计

- **Token 用量实时监控** — 当前会话 input / output / cache Token 构成
- **费用估算** — 实时计算当前会话成本
- **工具调用明细** — 查看 Claude 调用了哪些工具 / MCP 扩展
- **Git 分支显示** — 自动识别当前项目 Git 分支

</td>
</tr>
</table>

<table>
<tr>
<td width="50%" align="center">
<img src="docs/消息通知跳转.gif" width="100%" alt="Hook 通知与状态同步" />
<br><sub>Hook 通知弹窗 + Tab 状态实时同步</sub>
</td>
<td width="50%" align="center">
<img src="docs/实时统计.png" width="100%" alt="会话实时统计面板" />
<br><sub>终端实时统计：Token / 费用 / Git 分支</sub>
</td>
</tr>
</table>


---

### 📜 历史会话统一管理

<table>
<tr>
<td width="50%">

#### 🗂️ 会话浏览

- **统一视图** — Claude Code / Codex 历史会话集中查看
- **智能筛选** — 按来源 / 项目 / 时间分组
- **会话内搜索** — 搜索高亮 + 跳转定位
- **标签 & 收藏** — 为重要会话打标签

</td>
<td width="50%">

#### 🔍 Diff 回看

- **代码变更可视化** — Unified Diff / Codex Patch 风格
- **行级高亮** — 新增 / 删除 / hunk header 分色显示
- **跳回触发消息** — 从 Diff 块快速定位到对应的对话
- **Prompt Library** — 提取历史 Prompt 快速复用

</td>
</tr>
</table>

<p align="center">
<img src="docs/会话历史.png" width="85%" alt="历史会话列表" />
<br><sub>历史会话列表 + 会话内搜索与 Diff 回看</sub>
</p>

---

### 📈 多维度用量分析

#### 多维度数据洞察

- **Token 构成分析** — input / output / cache creation / cache read 分项统计
- **费用估算** — 支持 Claude、GPT、o 系列模型自动定价
- **项目排行榜** — 点击项目名即可按项目过滤（可交互）
- **活跃热力图** — 7 / 30 / 90 天范围，点击日期下钻查看当日会话
- **Token 趋势图** — 会话 / 消息 / Token 趋势，支持 hover 详情
- **效率散点图** — 项目效率分析（Token 使用 vs 会话数）
- **24 小时活跃分布** — 了解自己的高效时段

<table>
<tr>
<td width="50%" align="center">
<img src="docs/用量分析看板.png" width="100%" alt="用量分析看板" />
<br><sub>多维度统计看板：热力图 / Token 趋势 / 效率散点 / 项目排行</sub>
</td>
<td width="50%" align="center">
<img src="docs/多维度统计.png" width="100%" alt="多维度统计详情" />
<br><sub>Token 构成饼图 / 模型占比 / 活跃时段分布</sub>
</td>
</tr>
</table>

---

### 🔄 cc-switch 供应商集成

#### 项目级后端一键切换

- **供应商管理** — 只读解析 cc-switch 数据库，按 app_type 分类展示
- **项目级切换** — 右键项目 → 切换供应商 → 自动写入 `.claude/settings.json`
- **跟随全局 / 项目覆盖** — 灵活选择全局默认或项目级覆盖
- **供应商徽标** — 项目树为覆盖供应商的项目显示独立徽标

**使用场景：**
- 官方接口调试项目 A
- 中转接口开发项目 B
- 自建后端测试项目 C
- 无需手动修改环境变量，一键切换

<table>
<tr>
<td width="50%" align="center">
<img src="docs/供应商列表.png" width="100%" alt="供应商管理" />
<br><sub>供应商列表与详情</sub>
</td>
<td width="50%" align="center">
<img src="docs/切换供应商.png" width="100%" alt="项目级供应商切换" />
<br><sub>项目右键菜单：一键切换供应商</sub>
</td>
</tr>
</table>

---

### 💻 终端与分屏

<table>
<tr>
<td width="50%">

#### 🖥️ 内置终端

- **多 Shell 支持** — Windows（PowerShell / CMD / Pwsh / WSL / Git Bash）、macOS / Linux（Bash / Zsh 等）
- **Tab 管理** — 拖拽排序 / 溢出滚动 / 复制配置
- **性能优化** — 高频输出合并 / WebGL 渲染 / 非激活降频
- **中文输入法完美支持** — 候选框锚点冻结 / 流式重绘免疫
- **终端搜索** — `Ctrl+F` 搜索历史输出
- **自定义背景** — 支持图片 / 透明度 / 高斯模糊 / 暗化覆盖

</td>
<td width="50%">

#### 📐 灵活分屏

- **自由布局** — Split Right / Split Down / 混合嵌套
- **拖拽分隔线** — 调整相邻 pane 比例
- **Tab 跨 pane 拖拽** — Tab 拖到其它 pane 或边缘创建分屏
- **独立 Tab 栏** — 每个 pane 拥有独立 Tab 栏

</td>
</tr>
</table>

<p align="center">
<img src="docs/终端与分屏.png" width="85%" alt="终端分屏" />
<br><sub>灵活分屏布局 + Tab 跨 pane 拖拽</sub>
</p>

---

### ⚡ 命令复用与快捷操作

#### 🎯 命令面板

- **`Ctrl+P` 全局面板** — 模糊搜索 / 键盘导航
- **快速启动项目** — 从命令面板直接启动项目终端
- **执行命令模板** — 一键执行常用命令

#### 📝 命令模板

- **三级作用域** — 全局 / 项目 / 会话级模板
- **变量替换** — `${projectPath}` / `${projectName}`
- **命令历史** — 自动记录历史命令，支持搜索与一键重放

<table>
<tr>
<td width="50%" align="center">
<img src="docs/全局面板.png" width="100%" alt="命令面板" />
<br><sub>命令面板：模糊搜索 + 快速启动</sub>
</td>
<td width="50%" align="center">
<img src="docs/命令模板.png" width="100%" alt="命令模板" />
<br><sub>命令模板：三级作用域 + 变量替换</sub>
</td>
</tr>
</table>

---

### 🗂️ 项目管理

- **项目分组** — 支持多层级分组 / 拖拽排序 / 折叠展开
- **项目配置** — 独立配置路径 / Shell / 启动命令 / 环境变量
- **健康检查** — 自动检测失效路径
- **右键菜单** — 打开所在目录 / 切换供应商 / 启动终端
- **Git 集成** — 自动识别项目 Git 分支

---

### ☁️ WebDAV 云同步

- **多设备同步** — 按设备名保存独立快照
- **自定义远程目录** — 支持多级路径（如 `backups/cli-mgr`）
- **冲突检测** — 本地优先 / 远程优先 / 手动合并
- **本地导入导出** — 支持 zip 格式备份

---

### 🎨 个性化与主题

- **应用主题** — 多种内置主题与自定义能力
- **终端主题** — Tokyo Night / Dracula / Monokai / Nord / Solarized 等
- **字体自定义** — UI 字体 / 终端字体 / 字号 / 字体颜色
- **快捷键配置** — 所有快捷键可自定义
- **精简模式** — 紧凑界面 + 外部终端默认启动

---

## 🧪 Beta 功能

以下功能正在开发打磨中，欢迎体验与反馈：

### 🤖 子 Agent 自动分屏（类 cmux）

- **智能分屏** — Claude Code 派发子 Agent 时自动创建分屏终端
- **会话关联** — 每个子 Agent 独立终端，状态实时同步
- **布局优化** — 根据 Agent 数量自动调整分屏布局

> 💡 此功能处于 Beta 阶段，如遇问题欢迎提交 [Issue](https://github.com/dark-hxx/CLI-Manager/issues)。

---

## 📸 界面预览

<p align="center">
<img src="docs/主界面.png" width="90%" alt="主界面" />
<br><sub>主界面 — 终端工作区</sub>
</p>

---

## 🛠️ 技术栈

### 前端

- **框架**：React 19 + TypeScript 5.8
- **构建工具**：Vite 7
- **状态管理**：Zustand
- **样式**：Tailwind CSS 4
- **终端**：xterm.js + FitAddon + WebglAddon
- **UI 组件**：Radix UI, Mantine Core
- **图表**：ECharts
- **拖拽**：@dnd-kit
- **Diff 展示**：react-diff-view

### 后端

- **运行时**：Tauri 2.x
- **语言**：Rust
- **数据库**：SQLite (tauri-plugin-sql)
- **存储**：tauri-plugin-store
- **PTY**：Rust PTY 会话管理
- **云同步**：WebDAV 适配层

### 核心能力

- 跨平台桌面应用（Windows / macOS / Linux，基于 Tauri 2）
- 多 Shell 支持（Windows：PowerShell / CMD / Pwsh / WSL / Git Bash；macOS / Linux：Bash / Zsh 等）
- PTY 会话管理与状态广播
- Claude Code / Codex Hook Bridge（127.0.0.1 回环 + bearer token 校验）
- 子 Agent 自动分屏（类 cmux，Claude Code 派发子 Agent 时自动创建分屏终端）
- 历史解析（Claude / Codex 会话与 Diff）
- cc-switch 供应商数据库只读解析
- WebDAV 云同步与冲突处理
- Git 集成（分支识别 / 项目路径健康检查）

---

## 🚀 快速开始

### 方式一：下载可执行版本

前往 [Releases](https://github.com/dark-hxx/CLI-Manager/releases) 页面获取最新版本。

> 目前主要提供 Windows 构建产物；macOS / Linux 用户建议从源码构建（见下方）。

### 方式二：从源码运行

#### 前置要求

- Node.js >= 18
- Rust >= 1.70
- 操作系统：Windows 10/11 | macOS | Linux

#### 安装依赖

```bash
npm install
```

#### 开发运行

```bash
npm run tauri dev
```

#### 构建发行版本

```bash
npm run tauri build
```

#### 其他常用命令

```bash
# TypeScript 类型检查
npx tsc --noEmit

# Rust 检查
cd src-tauri && cargo check

# Rust 测试
cd src-tauri && cargo test
```

---

## 🎯 适用场景

- ✅ 高频使用 Claude Code / Codex CLI 的开发者
- ✅ 需要实时监控 Token 用量与费用的用户
- ✅ 想回看历史会话代码变更的用户
- ✅ 多项目并行开发，需要频繁切换终端的场景
- ✅ 使用 cc-switch 管理多个 Claude 后端的用户
- ✅ 需要跨设备同步开发配置的用户

---

## 📋 功能速查

<details>
<summary><b>项目管理</b></summary>

- 项目分组 / 搜索 / 拖拽排序
- 项目配置（路径 / Shell / 启动命令 / 环境变量）
- 路径健康检查
- Git 分支自动识别
- 右键菜单（打开目录 / 切换供应商）

</details>

<details>
<summary><b>终端工作区</b></summary>

- 内置 PTY 终端（xterm.js）
- Tab 管理（拖拽排序 / 溢出滚动 / 复制配置）
- 灵活分屏（Split Right / Split Down / 混合嵌套）
- Tab 跨 pane 拖拽
- 终端搜索（`Ctrl+F`）
- 自定义背景（图片 / 透明度 / 高斯模糊）
- 中文输入法完美支持

</details>

<details>
<summary><b>Claude / Codex 集成</b></summary>

- Hook 实时通知（权限审批 / 任务完成 / 失败）
- Tab 状态点（运行中 / 待审批 / 完成 / 失败）
- 会话实时统计（Token / 费用 / 工具调用 / Git 分支）
- 历史会话统一管理
- Diff 回看（Unified Diff / Codex Patch）
- 会话内搜索 / 标签 / 收藏
- Prompt Library

</details>

<details>
<summary><b>用量分析</b></summary>

- 多维度统计看板
- Token 构成分析（input / output / cache）
- 费用估算
- 项目排行榜（可交互）
- 活跃热力图（7 / 30 / 90 天）
- Token 趋势图
- 效率散点图
- 24 小时活跃分布

</details>

<details>
<summary><b>cc-switch 集成</b></summary>

- 只读解析供应商数据库
- 按 app_type 分类展示
- 项目级供应商一键切换
- 自动写入 `.claude/settings.json`
- 跟随全局 / 项目覆盖

</details>

<details>
<summary><b>命令复用</b></summary>

- 命令面板（`Ctrl+P`）
- 命令模板（全局 / 项目 / 会话级）
- 命令历史（自动记录 / 搜索 / 一键重放）
- 变量替换（`${projectPath}` / `${projectName}`）

</details>

<details>
<summary><b>云同步</b></summary>

- WebDAV 多设备同步
- 自定义远程目录
- 冲突检测（本地优先 / 远程优先）
- 本地导入导出（zip）

</details>

<details>
<summary><b>个性化</b></summary>

- 应用主题 / 终端主题
- 字体自定义（UI / 终端 / 字号 / 颜色）
- 快捷键配置
- 精简模式
- 终端背景自定义

</details>

---

## 🔑 默认快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+P` | 打开命令面板 |
| `Ctrl+K` | 打开会话历史 |
| `Ctrl+Shift+T` | 新建终端 |
| `Ctrl+W` | 关闭当前终端 |
| `Alt+ArrowRight` | 下一个 Tab |
| `Alt+ArrowLeft` | 上一个 Tab |
| `F11` | 终端全屏 |
| `Ctrl+F` | 终端搜索 / 会话内搜索 |

> 💡 所有快捷键可在「设置 - 快捷键」中自定义

---

## 💬 交流讨论
<p align="center">
  <img src="docs/wechat-group-qr.png" width="280" alt="微信交流群" />
  <br>
  <sub>扫码加入微信交流群，获取最新动态与技术支持</sub>
</p>

---

## 🎉 致谢

本项目在 [LINUX DO](https://linux.do/) 社区推广，感谢 LINUX DO 社区对开源项目的支持与认可。

---

## 📄 许可证

CLI-Manager 采用双授权模式：

- **开源授权**：[AGPL-3.0-or-later](LICENSE)。公司和个人均可在遵守 AGPL 条款的前提下使用、研究、修改、分发或通过网络提供本项目。
- **商业授权**：如果需要闭源集成、闭源改造、用于不接受 AGPL 义务的内部产品化平台、商业分发，或以专有条款提供托管/服务化能力，需要单独取得商业授权。详见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

Copyright (c) 2026 Chenyme。详见 [NOTICE](NOTICE)。

正常使用未经修改的官方应用不需要商业授权；遵守 AGPL-3.0-or-later 的开源使用也不需要商业授权。

---

<div align="center">

**⭐ 如果这个项目对你有帮助，欢迎 Star 支持！**

[提交 Issue](https://github.com/dark-hxx/CLI-Manager/issues) • [贡献代码](https://github.com/dark-hxx/CLI-Manager/pulls) • [查看文档](docs/功能清单.md)

</div>
