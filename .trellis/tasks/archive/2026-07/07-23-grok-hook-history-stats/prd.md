# Grok Build: Hook, history resume, realtime stats

Changelog Target: V1.3.1

## Goal

将 **Grok Build** 提升为与 **Claude Code** 同级的一等 CLI 工具（对齐 Claude 体验，而非 Codex 子集）：

1. **S1 Hook**：设置页安装/卸载/模块开关；`--source grok`；安装时关闭 Claude/Cursor 跨工具 hook 兼容。
2. **S2 历史 + Resume**：历史可浏览；「继续对话」/终端恢复走 `grok --resume` / `grok --continue`。
3. **S3 终端实时统计**：Hook 绑 `cliSessionId` 后 `TerminalStatsPanel` 展示会话用量（不扩展全局 ccusage）。

## Parallel Isolation（强制）

1. 规划/研究只写入 `.trellis/tasks/07-23-grok-hook-history-stats/**`。
2. 实现只改本任务 `implement.md` / `relatedFiles` 列出的文件；共享模块只加 Grok 分支。
3. 禁止修改其他 task 目录。
4. 不重构 Claude/Codex/Pi 既有语义；冲突先停手问用户。

## Background / Confirmed Facts

### Hook（Claude 对齐基线）

- Claude 模块：`SessionStart` / `Running(UserPromptSubmit)` / `Attention(Notification matcher)` / `Stop` / `Failure(StopFailure)` / `Subagent(+ ToolStart/Stop, AgentTool*)`。
- 上报：`cli-manager.exe __hook --source <tool> --event <Event>` + env `CLI_MANAGER_TAB_ID|NOTIFY_PORT|NOTIFY_TOKEN`。
- 设置：`claudeHookBridgeEnabled` + `claudeHookConfigDir`；状态枚举 `directoryMissing|notInstalled|partialInstalled|installed`。
- Grok 原生 hooks：`~/.grok/hooks/*.json`；事件名与 Claude 高度同构。
- Grok 默认扫描 Claude/Cursor hooks → 串线；Codex foreign hooks **inert，无需处理**。

### 历史 / Resume

- `history.rs` 已有 Grok 扫描与 `scan_grok_jsonl_session`（消息/工具次数/模型；**token 字段目前多为 0**）。
- `historySources.ts` 中 grok 能力为 `jsonReaderCapabilities`：`resume/realtimeStats` 未标 supported。
- Resume CLI：`grok --resume <id>` / 无 id 时 `grok --continue`；可选 `--no-alt-screen`（design 定）。
- `detectCliResumeKind` / `buildCliResumeStartupCommand` 仅 claude|codex。

### 实时统计

- `TerminalStatsPanel`：hook `cliSessionId` → `fetchLatestProjectSessionDetail(source, sessionId)` → 会话卡片。
- `inferHistorySource` 未识别 `grok`。
- 全局 `CcusageStatsPanel` 仅 claude|codex — **本任务不扩展**。
- Grok `signals.json` 含 `contextTokensUsed` / `contextWindowTokens` 等，可作为 S3 token 补齐源。

## Scope（S1 → S2 → S3）

| 切片 | 内容 | 对齐 Claude |
|------|------|-------------|
| S1 | 安装到 `~/.grok/hooks/`；关 `compat.claude/cursor.hooks`；设置页 Grok 分区；env 注入；`source=grok` 全链路 | 同模块集合 |
| S2 | resume 分流 + 历史「继续对话」+ capability 标记 | 同 resume 产品语义 |
| S3 | TerminalStatsPanel + parser usage 补齐 | 同面板绑定语义 |

## Requirements

### R1 Hook 安装与所有权

- 配置根默认 `~/.grok`（可自定义，设置项 `grokHookConfigDir`）。
- 安装写入自有 hooks 文件（如 `hooks/cli-manager.json`），命令 `__hook --source grok --event …`。
- 模块与 Claude 一致：`sessionStart|running|attention|stop|failure|subagent`（事件映射同 `apply_claude_hook_module`）。
- 只管理含 `__hook` 的自有条目；保留用户其它 Grok hooks。
- 设置页：`grokHookBridgeEnabled`（默认 true，与 Claude 一致）+ Grok 折叠分区 + 模块开关。

### R1b 跨工具 Hook 隔离（安装时强制）

安装时写入目标 `config.toml`：

```toml
[compat.claude]
hooks = false
[compat.cursor]
hooks = false
```

- 只改 hooks 单元；不关 skills/rules/mcps/agents。
- 不写 Codex compat hooks。
- 幂等；卸载 **不** 恢复 true（用户可手动改回）。
- 状态检测：自有 hook 已装 **且** 两处 compat hooks 为 false 才算 installed（partial 若缺一）。

### R2 运行时绑定

- `shouldEnableHookEnv` / 创建终端注入：纳入 Grok bridge+installed。
- `CliHookSource` / toast / Tab 状态支持 `grok`。
- `hook_client::title_for` 增加 grok 文案（对齐 Claude 事件集合）。

### R3 历史与 Resume

- `detectCliResumeKind` 支持 `grok`（cli_tool / startupCmd 含 grok）。
- 有 id：`grok --resume <id>`（是否加 `--no-alt-screen`：与内置终端策略一致，见 design）。
- 无 id：`grok --continue`。
- 历史继续对话入口走同一命令构造。
- `historySources` grok：`resume` → supported；list/search/stats 与现网 parser 能力对齐为 supported（若已能 list）。

### R4 终端实时统计

- 仅 `TerminalStatsPanel`；不扩 ccusage。
- `inferHistorySource` 识别 grok；lookup `source=grok`。
- SessionStart 等绑定 sessionId 后卡片有数据；parser 从 `signals.json`（及/或 updates）补 `context_window` / token 类字段，避免永远 0。
- 未绑定：空骨架 / 引导装 Hook。

## Decisions Locked

| # | 决策 |
|---|------|
| D1 | 安装时 `compat.claude.hooks` + `compat.cursor.hooks` = false |
| D2 | 只隔离 hooks，不关 skills/rules/mcps |
| D3 | 不处理 Codex foreign hooks |
| D4 | 卸载不恢复 compat |
| D5 | 同任务 S1→S2→S3 |
| D6 | 无 session id → `grok --continue` |
| D7 | S3 = TerminalStatsPanel only |
| D8 | Hook 事件模块 **全量对齐 Claude** |
| D9 | 产品目标：**对齐 Claude**，不是 Codex 子集 |

## Out of Scope

- 全局 Ccusage / 第三方 ccusage CLI 支持 Grok。
- SSH 远端 Grok Hook 安装。
- Grok 历史消息编辑写回 / mutation。
- 自动改 Grok skills/rules/MCP 兼容。
- 其它 in_progress 任务文件。

## Acceptance Criteria

### S1

- [ ] 设置 → Hook → Grok：安装后 `~/.grok/hooks` 出现 CLI-Manager 条目，`--source grok`。
- [ ] 安装后 `config.toml` 中 claude/cursor `hooks=false`；Grok 会话不再执行 Claude 配置里的 hook。
- [ ] 卸载移除自有 hook 条目，compat 保持 false。
- [ ] 模块开关可单独装/卸，与 Claude 六模块一致。
- [ ] 内置 Grok 终端在 installed 时注入 hook env；事件 `source=grok`。

### S2

- [ ] 历史 Grok 会话「继续对话」→ `grok --resume <id>`（有 id）或 `grok --continue`（无 id）。
- [ ] 应用恢复标签时 Grok 会话走 resume 分流，不误走 claude/codex。
- [ ] capability：grok resume 标记 supported。

### S3

- [ ] Hook 绑定后 TerminalStatsPanel 对 Grok 会话出数据（至少 session 绑定正确；token/context 在 signals 可用时非空）。
- [ ] 未装 Hook 时空态正确；Ccusage 面板无 Grok 选项。

### 全局

- [ ] Claude/Codex/Pi 路径无回归。
- [ ] Diff 不含其他 task 目录。

## Notes

- 复杂任务：以本 `prd.md` + `design.md` + `implement.md` 为准；实现前 `task.py start`。
- 研究产出仅 `research/`。
