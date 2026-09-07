# 本地 Token 用量与用量记录对齐 CC Switch

## Goal

在不依赖外部 `ccusage`、不新增依赖和数据库表的前提下，使用本地历史文件/数据库解析结果，为 Claude、Codex、Gemini、OpenCode、Grok 提供与 CC Switch 语义一致的 Token 用量统计和持久化请求记录。

变更记录目标：`[TEMP]`。

## Requirements

- 扩展现有历史解析与 `request_logs` 同步链路，覆盖且仅覆盖 Claude、Codex、Gemini、OpenCode、Grok。
- 统一统计输入、输出、缓存创建、缓存读取、真实总 Token、缓存命中率、请求数、成本和未定价 Token。
- 新增请求级统计 IPC，支持来源、项目、模型、日期范围筛选，并提供趋势、来源分布、模型分布。
- 保留现有项目排行、热力图、效率、会话分析等历史统计能力；其他来源继续使用现有会话统计，不接入新的请求记录链路。
- 用量记录页支持五类来源和全局筛选；复用现有请求记录表、同步锁、启动/定时同步机制。
- OpenCode 继续使用现有 SQLite 会话定位方式；Claude/Codex 保留现有 Windows/WSL 路径策略；不新增 WSL 来源协议。
- 前端所有新增用户可见文案同步 `zh-CN`/`en-US`，不硬编码文案。
- 不修改独立的外部 `ccusage` 分支（`CcusageStatsPanel`、`ccusageStore`、Bun/bunx 配置）。

## Acceptance Criteria

- [x] 五类来源的本地历史请求可同步、去重、增量更新，并可在记录页查询。
- [x] Gemini 的每条消息、Grok 的每个完成回合、Claude/Codex/OpenCode 的现有事件均保留稳定事件键，重复同步不会重复计数。
- [x] 请求级统计的 Token 汇总和缓存命中率符合 CC Switch 语义；未知模型成本进入未定价 Token，不使用来源显式成本覆盖本地定价规则。
- [x] 看板展示请求级概览、趋势、来源/模型构成，并保留现有项目/热力图/效率/会话分析。
- [x] 看板和记录页的来源、项目、模型、日期筛选结果一致；首次打开、后台定时同步、手动刷新后数据可更新。
- [ ] 中英文界面均可正常渲染，英文日期时间仍使用 24 小时制（需启动应用后人工确认）。
- [x] 通过 `npx tsc --noEmit`、`cargo check`、相关 Rust 测试及 Trellis 质量检查；不提交 Git commit。

## Scenario Matrix

- 窗口焦点：当前窗口、切换到其他窗口、后台/失焦。
- 分屏与会话：单会话、多会话切换、深层项目目录。
- 窗口状态：正常、最小化、托盘恢复。
- 运行时：Windows PowerShell、CMD、Pwsh、WSL/Bash（仅验证既有 Claude/Codex 路径策略）。
- 项目路径：主目录、子目录、Worktree、目录缺失。
- Hook/日志：Claude/Codex hook 均安装、仅一方安装、均未安装；Gemini/OpenCode/Grok 日志缺失或部分损坏。

## Constraints

- 最小必要改动；不引入新依赖、不新增表、不改外部 ccusage 流程。
- 先复用现有 `request_logs` schema、解析器和同步机制；语义变化时提升 parser version。
