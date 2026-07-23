# Design: Grok Hook / Resume / Terminal Realtime Stats

对齐对象：**Claude Code**（模块、设置 UX、resume 语义、终端统计绑定）。
Codex 仅作对照，不作为能力上限。

并行隔离：实现时只扩展 Grok 分支；不重排 Claude 安装逻辑。

---

## 1. Architecture Overview

```text
┌─ Settings UI (HookSettingsPage + settingsStore) ─────────────┐
│  grokHookBridgeEnabled / grokHookConfigDir / sections.grok   │
└───────────────────────────┬─────────────────────────────────┘
                            │ invoke
┌─ hook_settings.rs ──────────────────────────────────────────┐
│  install/uninstall/status (+ module)                         │
│  write ~/.grok/hooks/cli-manager.json                        │
│  patch ~/.grok/config.toml compat.claude|cursor.hooks=false  │
└───────────────────────────┬─────────────────────────────────┘
                            │ Grok runtime fires hooks
┌─ __hook --source grok ──► hook_client ──► daemon/bridge ──► App / terminalStore
│                              env: TAB_ID / PORT / TOKEN
└───────────────────────────┬─────────────────────────────────┘
                            │ cliSessionId
┌─ TerminalStatsPanel ──► history_list/get (source=grok) ──► cards
┌─ Resume ──► grok --resume <id> | grok --continue
```

---

## 2. S1 — Hook Management

### 2.1 Config roots

| Item | Path / key |
|------|------------|
| Grok home | `GROK_HOME` or `~/.grok` |
| Hooks dir | `<grok_home>/hooks/` |
| Managed file | `<hooks>/cli-manager.json`（固定名，便于所有权识别） |
| Compat file | `<grok_home>/config.toml` |
| Settings | `grokHookConfigDir: string \| null`（null = 默认 home） |
| Bridge | `grokHookBridgeEnabled: boolean`（default `true`，对齐 Claude） |

### 2.2 Hook JSON shape（对齐 Claude 事件）

Grok 文档使用与 Claude 相同的顶层 `hooks` 事件名。安装内容语义对齐 `apply_claude_hook_module`：

| Module | Events | Matcher | `--event` |
|--------|--------|---------|-----------|
| sessionStart | SessionStart | — | SessionStart |
| running | UserPromptSubmit | — | UserPromptSubmit |
| attention | PreToolUse | `Bash\|Edit\|Write\|MultiEdit` | PermissionRequest |
| stop | Stop | — | Stop |
| failure | StopFailure | — | StopFailure |
| subagent | SubagentStart, SubagentStop, PreToolUse×2, PostToolUse×2 | Agent\|Task / 空 | SubagentStart/Stop, AgentToolStart/Stop, ToolStart/ToolStop |

命令构造复用 `build_command(exe, "grok", event)`（Windows PowerShell 包装与现网一致）。

**所有权**：命令含 `__hook` 且 `--source grok` 视为自有；安装前 `remove` 旧自有条目再写入（install = upgrade）。

### 2.3 Compat isolation（安装原子步骤）

顺序建议：

1. 确保 hooks 目录存在。
2. 写/合并 `cli-manager.json`（自有 hooks）。
3. 编辑 `config.toml`：set `compat.claude.hooks = false`、`compat.cursor.hooks = false`（创建缺失 section；保留无关键与其它 section）。
4. 返回 status。

TOML 编辑策略（与 Codex `features.hooks` 类似，**精确最小改动**）：

- 若 table 存在：更新/插入 `hooks = false` 行。
- 若不存在：追加 `[compat.claude]` / `[compat.cursor]` 块。
- **不要**改 skills/rules/mcps/agents/sessions。
- **不要**写 `compat.codex`。

卸载：

1. 从 hooks JSON 移除自有命令；若文件仅剩空 hooks 可删文件或留空对象（实现选：文件仅含我们管理的内容则删文件，否则只剥命令）。
2. **不**修改 compat 为 true。
3. UI 文案提示：跨工具 hook 扫描保持关闭。

### 2.4 Status model

扩展 `HookSettingsStatus`：

```text
claude, codex, pi, grok, cc_switch, claude_auto_repaired
```

`ToolHookSettingsStatus` 复用；Grok 额外可把 compat 状态折叠进：

- `installed`：六模块齐全 **且** compat 两 hooks 均为 false。
- `partialInstalled`：有部分 hook 或 compat 未关。
- `feature_config_path`：指向 `config.toml`（展示用）。
- `hooks_feature_installed`：可复用含义 =「跨工具 hook 隔离已生效」（或单独字段 `crossVendorHooksDisabled`；若为减接口噪声，用 `hooks_feature_installed` 表达 isolation OK）。

Commands（对齐现有命名）：

- `hook_settings_get_status` — 增加 `grok_selected_dir`
- `hook_settings_install_grok` / `hook_settings_uninstall_grok`（module optional）
- 或统一 install 带 tool 参数 — **优先独立 command**，与 codex/pi 一致，少动 Claude 安装入口。

### 2.5 Frontend settings

- `HookSettingsSectionKey` 增加 `"grok"`。
- `HookTool` 增加 `"grok"`。
- 分区 UI 复制 Claude 卡片结构（目录选择、状态 pill、模块 Switch、安装/卸载、compat 说明）。
- i18n：`zh-CN` + `en-US` 同步。

### 2.6 Runtime env

`shouldEnableHookEnv`：

```ts
claude || codex || pi || (grokHookBridgeEnabled && status.grok.status === "installed")
```

`CliHookSource = "claude" | "codex" | "pi" | "grok"`。

`App.tsx` `getCliHookSourceName`：Grok Build。

`hook_client::title_for`：显式 `("grok", event)` 分支（文案对齐 Claude 句式，产品名 Grok Build）。

### 2.7 不改动

- Claude/Codex/Pi 安装算法本体。
- cc-switch 同步（Grok 无 common_config）。
- SSH remote hook（out of scope）。

---

## 3. S2 — History + Resume

### 3.1 Kind detection

扩展：

```ts
detectCliResumeKind(...): "claude" | "codex" | "grok" | null
```

判定顺序建议：codex → claude → grok（或 project `cli_tool`/vendor 优先）。
Pattern：`/\bgrok\b/i`；`getProviderSwitchAppType` / `cliTools` vendor `grok`。

### 3.2 Resume command

```ts
// hasValidId
`grok --resume ${id}`
// else
`grok --continue`
```

**`--no-alt-screen`**：Grok help 支持该全局选项。内置终端若 Claude 未强制 no-alt，则 Grok 默认同 Claude（不加）；若后续实测 TUI 清屏问题，再统一加。**初版默认不加**，与 `claude --resume` 对称；Codex 的 `--no-alt-screen` 是 Codex 特例。

`appendResumeCliArgs`：若 Grok 项目有 cli_args，按现有 Claude 路径尽量复用；无则原样。

### 3.3 Call sites（只扩分支）

| 位置 | 改动 |
|------|------|
| `terminalStore.buildCliResumeStartupCommand` | kind 含 grok |
| `detectCliResumeKind` | grok |
| `restoreSessions` 分流 | 自动吃 detect |
| 历史「继续对话」构造命令处 | 识别 source===grok |
| `externalSessionSyncStore` resume helper | 若硬编码 claude/codex，加 grok |
| `historySources.ts` grok capabilities | `resume: "supported"`；list/search/stats/rawOpen 与 parser 实际一致 → `supported`；`realtimeStats: "supported"`（S3）；usage：S3 补齐后 `supported`，否则先 `planned`→S3 完成改 supported |

### 3.4 History list

Parser 已存在；S2 焦点是 resume 与 capability，不重写扫描。若 list 已通，仅修「继续对话」按钮 enable 条件（source grok + resume supported）。

---

## 4. S3 — Terminal Realtime Stats（对齐 Claude 面板）

### 4.1 Data path（与 Claude 相同）

```text
Hook SessionStart/UserPromptSubmit/...
  → terminalStore 写 cliSessionId
  → TerminalStatsPanel inferHistorySource === "grok"
  → fetchLatestProjectSessionDetail(path, prev, "grok", cliSessionId, { forceCatalogRefresh })
  → history_get_session → usage/messages/tools cards
```

### 4.2 Frontend gaps

| Gap | Fix |
|-----|-----|
| `inferHistorySource` 无 grok | 加 `/\bgrok\b/` |
| `HistorySource` 类型若未含 grok | 确认 `types.ts` 已含则只改 infer |
| 保存到侧栏 kind 仅 claude/codex | 若按钮依赖 kind，扩展 grok 或禁用策略对齐 pi |

### 4.3 Parser usage 补齐（关键）

现状：`scan_grok_jsonl_session` 填 model、tool_call_count，**几乎不填 input/output/context**。
Claude 路径依赖这些字段驱动 Token 卡。

**S3 策略（最小、可测）**：

1. 读取同目录 `signals.json`（与 `updates.jsonl` 并列）：
   - `contextTokensUsed` → `last_context_tokens`
   - `contextWindowTokens` → `context_window`
   - 若存在累计 token 字段则映射 input/output；否则：
2. 用 `contextTokensUsed` 作为展示用「上下文占用」；input/output 若 Grok 日志无分项，可：
   - **方案 A（推荐）**：`last_context_tokens` + `context_window` 填满模型上下文卡；token 总量卡用 `contextTokensUsed` 映射到合理字段（例如记入 `input_tokens` 或 UI 已支持的 total）——实现时对照 `calculateTokenStats` 需要哪些字段。
   - 不从 ccusage 拉数。
3. `primaryModelId` / `modelsUsed` 辅助 `current_model`。
4. 单测：fixture 放在本任务 `research/fixtures/` 或现有 history fixture 目录（**新增** grok signals 样本，脱敏）。

### 4.4 Explicit non-goals

- `CcusageSource` 不加 grok。
- 不接 Grok 计费 USD（无稳定字段则 total_cost_usd=0）。

### 4.5 Hook events needed for stats

全量 Claude 模块已含 SessionStart → 足够绑定；Running/Stop 改善 Tab 态，与 Claude 一致。

---

## 5. Data / API Contracts

### 5.1 Install payload (conceptual)

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "... __hook --source grok --event SessionStart", "timeout": 15 }] }],
    "UserPromptSubmit": [ ... ],
    "PreToolUse": [{ "matcher": "Bash|Edit|Write|MultiEdit", "hooks": [ ... PermissionRequest ] }, ... AgentToolStart, ToolStart],
    "Stop": [ ... ],
    "StopFailure": [ ... ],
    "SubagentStart": [ ... ],
    "SubagentStop": [ ... ],
    "PostToolUse": [ AgentToolStop matcher, ToolStop ]
  }
}
```

### 5.2 Status JSON（前端）

```ts
interface HookSettingsStatus {
  claude: ToolHookSettingsStatus;
  codex: ToolHookSettingsStatus;
  pi: ToolHookSettingsStatus;
  grok: ToolHookSettingsStatus; // NEW
  ccSwitch: ...
  claudeAutoRepaired: boolean;
}
```

### 5.3 Resume commands

| Case | Command |
|------|---------|
| id | `grok --resume <uuid>` |
| no id | `grok --continue` |

---

## 6. Compatibility & Migration

- 首次安装 Grok hook：用户若依赖 Grok 读取 Claude hooks 做自动化，会被关掉 — **有意为之**（产品要求）。UI 安装确认或说明文案写清。
- 卸载不恢复 compat：避免回串线。
- 旧环境无 `grok` status 字段：前端缺省 `directoryMissing`/`notInstalled`。
- 不迁移 Claude settings 中的 hook。

---

## 7. Testing Strategy

| Layer | Cases |
|-------|--------|
| Rust unit | install writes hooks file + compat false；uninstall removes hooks keeps compat；module-only install；idempotent reinstall；TOML 保留无关键 |
| Rust history | signals.json → context fields；session id from summary |
| Frontend typecheck | tsc；settings section key |
| Manual | 装 Grok hook → `grok` 会话 toast source=grok；Claude 会话仍 source=claude；TerminalStats 绑定；resume 有/无 id |

避免全量无关回归测试；聚焦 grok 新测 + 现有 hook_settings 测不破坏。

---

## 8. Risk & Rollback

| Risk | Mitigation |
|------|------------|
| Grok 无原生审批 Hook，PreToolUse 可能早于 remembered approval | 仅匹配危险写操作；`bypassPermissions` 抑制，`auto` 保留通知 |
| 改用户 config.toml | 最小 diff；单测锁定；文档说明 |
| Token 字段语义不完全 | 优先 context 卡正确；总量卡允许近似 |
| 并行任务改 hook_settings | 只追加 grok 函数/字段，少改共享 helper 签名 |

Rollback：卸载 Grok hook 文件；compat 保持 false 属安全默认。

---

## 9. File Touch List（实现边界）

**优先改（Grok 扩展）**

- `src-tauri/src/commands/hook_settings.rs` — grok install/status/compat
- `src-tauri/src/hook_client.rs` — title_for grok
- `src-tauri/src/lib.rs` — register commands
- `src-tauri/src/commands/history.rs` — signals usage（S3）
- `src/stores/settingsStore.ts` — grok settings keys
- `src/components/settings/pages/HookSettingsPage.tsx` — Grok UI
- `src/stores/terminalStore.ts` — env、resume kind、CliHookSource
- `src/App.tsx` — source name / 若有 source 分支
- `src/components/terminal/TerminalStatsPanel.tsx` — infer grok
- `src/lib/historySources.ts` — capabilities
- `src/lib/i18n` 或文案表 — zh/en
- 历史 continue 入口相关组件（grep `resume` / `buildCliResume` 调用点）

**避免**

- 其他 `.trellis/tasks/*`
- ccusage.rs / CcusageStatsPanel（除非误伤类型）
- SSH hook_config 大改

---

## 10. Delivery Order

1. **S1** Hook + compat + settings + env + source 文案
2. **S2** detect/resume/history continue + capabilities
3. **S3** infer source + signals usage + 面板验收

每切片可独立 commit；S3 依赖 S1 绑定。
