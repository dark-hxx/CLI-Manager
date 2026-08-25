# Grok SSH CLI/Hook 与本地历史删除

## Changelog Target

TEMP（等待用户指定版本号）

## Goal

对照 PR #219 / #220 为 Kimi Code 落地的能力，把 Grok Build 补成同等的一等 CLI/Hook source，并补齐本地历史删除。本地 Hook、历史列表、搜索、恢复和实时统计已存在；本任务不重做那些路径。

## Root-Cause / Feature Statement

SSH CLI 集成把 `SshToolSource` 限制为 Claude/Codex/Kimi，Grok 只能当普通远程命令启动，不能配置根目录、注入 `GROK_HOME`、检查/安装/卸载远端 Hook。本地历史删除白名单只有 Claude/Codex/Kimi，Grok 会话目录无法按 Kimi 同级协议安全移除。修复必须落在 source 准入、SSH Agent Grok adapter、启动环境注入、以及目录级删除边界，而不是在 UI 做假成功。

## Requirements

### 1. SSH CLI / Hook（对标 #219）

- `SshToolSource` 增加 `grok`；`SshHistorySource` 仍仅为 Claude/Codex。
- 默认根 `$HOME/.grok`；命令解析支持 `grok` / `grok.exe` 及带路径形式。
- SSH CLI 集成页与项目覆盖根显示 Grok；host primary / project override / retained root 可 inspect / preview / apply / uninstall。
- 非空有效根注入 `GROK_HOME`；空根保留远端原生环境。本地自定义 Hook 目录不注入本地启动环境。
- SSH Agent 规划 `hooks/cli-manager.json` 与 `config.toml` 跨工具隔离，事件集合对齐本地 Grok installer（含 `PreToolUse -> PermissionRequest` matcher `Bash|Edit|Write|MultiEdit`）。
- Grok installation record 不携带 `historySourceCandidate`，不写 `history_source_instance_id`。
- 旧 Agent 不支持 Grok 时显式失败，不伪造成功。
- Agent 版本 `0.1.9` → `0.1.10`，协议保持 `1.11`。

### 2. 本地历史删除（对标 #220 的删除方向）

- 本地/WSL Grok 删除：校验 `updates.jsonl` 落在 history home 内，备份 `updates.jsonl` 与 `summary.json` 后 `remove_dir_all` 整个 session 目录。
- 会话 ID 白名单 `[A-Za-z0-9_-]{1,128}`，禁止 `/` `\` NUL `..`。
- 失败不得声称成功；路径穿越拒绝。
- 列表/搜索/恢复/`grok --resume`/实时统计保持现有行为。
- SSH Grok 历史仍 unsupported。
- 不接入转换、消息编辑、ccusage、远程历史 parser。

### 3. 文案

- 用户可见文案兼容 zh-CN / en-US；时间保持 24 小时制。

## Scenario Matrix

| 维度 | 预期 |
|---|---|
| 窗口焦点 / 分屏 / 托盘 / sidebar / Workspan / focus mode | 复用现有 SSH 集成与历史面板，不新增抢焦点 |
| 本地 PS/CMD/Pwsh、macOS/Linux Bash | 删除 `~/.grok/sessions/<workspace>/<id>` |
| WSL UNC | 删除路径必须在 Grok history root 内；扫描仍走既有 WSL 策略 |
| Worktree | 按 cwd/project_key 过滤，与现有 Grok 列表相同 |
| Hook 已装/未装 | 实时统计仍只认绑定 sessionId |
| 自定义 Hook 目录 vs 默认 Home | SSH 非空根注入 `GROK_HOME`；本地 Hook 目录不注入 |
| SSH Grok | Hook 可管理；历史仍走既有不支持提示 |
| 精确 sessionId 未进 catalog | 现有 UUID 直查保持不变 |
| 删除失败 | 不静默成功；尽量从备份恢复关键文件 |

## Acceptance Criteria

- [x] SSH CLI 集成页稳定渲染 Claude、Codex、Kimi、Grok；Grok 默认 `$HOME/.grok`，browse/reset/Hook action 可用。
- [x] 裸命令、路径和引号 executable 中的 `grok` / `grok.exe` 识别为 Grok；非空根注入 `GROK_HOME`。
- [x] Grok SSH Hook inspect/preview/install/uninstall 写入 `hooks/cli-manager.json` 并设置 `compat.claude.hooks` / `compat.cursor.hooks = false`；用户字段保留；无 history candidate。
- [x] 本地 Grok 历史可删除整棵 session 目录；路径穿越被拒绝。
- [x] SSH Grok 历史仍 unsupported；Claude/Codex/Kimi 无回归。
- [x] zh-CN / en-US 文案完整。
- [x] `CHANGELOG.md` 与 `docs/功能清单.md`、相关契约已更新。
- [x] focused Node/Rust tests、TypeScript、Rust check、format/diff checks 通过。
- [x] 在真实 GUI 上检查 SSH CLI 集成页、历史删除入口、中英文切换。

## Notes

- GitNexus MCP 本环境不可用，触点用契约 + grep 枚举。
- 真实 GUI 验收按用户要求执行；仓库默认禁止启动 Tauri 的约定被本次用户指令覆盖。
