# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

DO NOT send optional commentary

## 项目概述

CLI-Manager 是一款 Windows 桌面应用，用于集中管理基于 PowerShell 的多个开发项目的 CLI 工具（如 claude、codex）。

## 最近变更（2026-03-25）

- 分析看板 S1（C1/C2/C3）：新增趋势图与 Token 构成图，支持会话/消息趋势联动、hover 提示、日期下钻到当天会话。
- 分析看板 S2（C4/C5）：项目活跃排行升级为可点击横向柱图（可直接触发项目过滤）；模型占比升级为构成图（前 5 模型 + 其他合并）。
- 分析看板 S3（C6）：热力图重构为统一图表交互样式，补齐 hover/selected 高亮、键盘导航（方向键 + Enter/Space）与可访问性标注。
- 分析看板 S4（V2，C7~C10）：后端 `history_get_stats` 扩展 `daily_series`、`source_distribution`、`project_efficiency`、`hourly_activity`；前端落地 Token 日趋势、来源对比、项目效率散点、24 小时活跃分布四类图表。

- 历史会话列表增强：新增时间分组（Today/Yesterday/This Week/This Month/Earlier）、来源筛选与历史侧栏宽度记忆。
- 历史会话交互优化：修复左右拖拽卡顿，拖动过程使用帧节流更新，松手后再持久化设置；并修复拖拽宽度计算错误导致的“无法拖动”问题。
- 历史会话筛选调整：移除“分支筛选”（历史日志中的分支字段存在 `HEAD` 等不稳定值，易误导）。
- Diff 视图增强：支持 Unified Diff 与 Codex `*** Begin Patch` 风格；支持从 diff 块跳回触发消息；新增行级高亮（新增/删除/hunk/header）。
- Diff 滚动体验修复：代码块保留独立横向滚动容器与可见滚动条样式，避免整页横向空白拖动。
- 后端历史解析增强：放宽 Codex tool-call patch 提取（`custom_tool_call`、`file-history-snapshot`）以提高 diff 命中率。
- 模板作用域增强：命令模板支持全局/项目/会话（会话级模板仅在当前会话有效，随会话生命周期清理）。
- 分析看板（Phase P2）：新增历史统计接口 `history_get_stats`，支持会话数/消息数/输入输出 Token 汇总、项目排行、模型占比、30 天热力图。
- 分析看板 UI：新增 `StatsPanel` 与 `TimelineHeatmap`，支持按项目与时间范围筛选、点击热力图日期查看当天会话并跳转。
- 入口调整：分析看板入口从“历史会话”内迁出，移动到侧边栏底部“设置”按钮左侧，并在 `App` 全局挂载弹层。
- 说明：本次摘要按要求不包含 `P1-1 Prompt Library（三级作用域）` 作为验收项。

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

## 国际化规则

- 前端新增或修改任何用户可见文案时，必须同步兼容 `zh-CN` 与 `en-US`。
- 覆盖范围包括按钮、菜单、悬浮提示、aria 标签、空状态、toast、系统通知、设置页、历史会话、统计看板，以及 hook 通知脚本相关文案。
- 不要硬编码中文/英文；优先通过 `src/lib/i18n.ts` 和 `useI18n()` / `translateCurrent()` 取文案。
- 交付前至少手动切换“设置 -> 通用 -> 界面语言”，确认新增界面在中英文下都生效，时间格式不得因英文切换变成 12 小时制。

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
- **Rust 后端**（`src-tauri/src/`）：PTY 会话管理、历史会话索引/检索/统计聚合
- **前端**（`src/`）：项目 CRUD、历史工作区、Diff/Prompt/Stats 视图渲染与交互状态管理

### IPC 通信
- 前端 → 后端：`invoke('pty_create' | 'pty_write' | 'pty_resize' | 'pty_close' | 'history_list_sessions' | 'history_get_session' | 'history_search' | 'history_list_prompts' | 'history_get_stats', args)`
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
    history.rs      # 历史会话 list/get/search/prompts/stats
  pty/
    manager.rs      # PtyManager：ConPTY 会话生命周期管理
```

### 数据层
- SQLite 表：`projects`（项目配置）、`command_templates`（命令模板）
- migrations 定义在 `src-tauri/src/lib.rs`
- 前端通过 `@tauri-apps/plugin-sql` 的 `Database.load("sqlite:cli-manager.db")` 直接执行 SQL

## 修复与新需求前置（强制）

改任何 bug、加任何需求前，先过分诊闸机 `.trellis/spec/guides/fix-triage-guide.md`：

- **修 bug**：先判定"最小修复"还是"根因修复"。表现层静态值（颜色/文案/常量）走最小修复；行为性、跨边界、回归、偶发或你想加兜底的，一律走根因——产出根因陈述 + 发现清单，禁止只在症状处打补丁。
- **加需求**：动手前对照该文档 §5 的场景维度清单枚举场景（窗口焦点、分屏、WSL、Worktree、hook 装没装……），别只做主路径漏掉边界场景。
- 找全代码触点优先用 GitNexus，不可用时降级到 `.trellis/spec/*-contracts.md` 契约 + grep。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **CLI-Manager** (15645 symbols, 30414 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/CLI-Manager/context` | Codebase overview, check index freshness |
| `gitnexus://repo/CLI-Manager/clusters` | All functional areas |
| `gitnexus://repo/CLI-Manager/processes` | All execution flows |
| `gitnexus://repo/CLI-Manager/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
