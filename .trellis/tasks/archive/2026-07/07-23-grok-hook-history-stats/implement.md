# Implement: Grok Hook / Resume / Terminal Stats

执行前：`python ./.trellis/scripts/task.py start 07-23-grok-hook-history-stats`（或当前 task 名）。
加载 `trellis-before-dev` 后按切片推进。只改本清单文件。

---

## S1 — Hook（对齐 Claude 全模块）

### Checklist

- [x] **settingsStore**：`grokHookBridgeEnabled`（default true）、`grokHookConfigDir`、section key `grok`、migrate 默认值。
- [x] **hook_settings.rs**
  - [x] `resolve_grok_dir`（`GROK_HOME` / `~/.grok` / selected）。
  - [x] 六模块对齐 Claude；`apply_named_hook_module(..., "grok", module)`。
  - [x] 写 `hooks/cli-manager.json`；安装前清自有 `__hook`。
  - [x] `set_toml_table_bool` → `compat.claude|cursor.hooks = false`。
  - [x] `build_grok_status`：模块 + isolation（`hooks_feature_installed`）。
  - [x] commands：`hook_settings_install_grok` / `uninstall_grok`；`get_status` 增 `grok`。
  - [x] 单测：install/uninstall/compat/idempotent。
- [x] **lib.rs**：注册新 command。
- [x] **hook_client.rs**：`title_for` grok 分支。
- [x] **HookSettingsPage**：Grok 分区 UI + invoke。
- [x] **terminalStore.shouldEnableHookEnv** + `CliHookSource` 含 grok。
- [x] **App / TerminalTabs / SidebarFooter**：status 与 env 判定含 grok。
- [x] 验证：`cargo test install_then_uninstall_grok` ok；`npx tsc --noEmit` ok。

### S1 Done when

设置可装/卸；config.toml 两 hooks=false；Grok 终端 env 注入；事件 source=grok。

---

## S2 — Resume + History

### Checklist

- [x] `detectCliResumeKind` + `buildCliResumeStartupCommand` 支持 grok。
- [x] 历史「继续对话」支持 grok（`HistoryWorkspace`）。
- [x] `appendResumeCliArgs` / `saveSessionToSidebar` 支持 grok。
- [x] `historySources.ts`：grok resume / realtimeStats / usage → supported。
- [x] 手工：有 id / 无 id 两条 resume 命令（用户侧验证通过）。

### S2 Done when

历史与标签恢复对 Grok 走 `grok --resume` / `grok --continue`，不误判 claude。

---

## S3 — TerminalStatsPanel

### Checklist

- [x] `TerminalStatsPanel.inferHistorySource` 识别 grok。
- [x] `history.rs`：`apply_grok_signals_stats` 读邻接 `signals.json`。
- [ ] fixture + 单测（可选补强）。
- [x] capabilities：`realtimeStats`/`usage` → supported。
- [x] 手工：装 hook → 开 Grok 会话 → 面板绑定 sessionId（用户侧验证通过）。

### S3 Done when

与 Claude 相同绑定路径；不引入 ccusage Grok。

---

## Validation Commands

```bash
npx tsc --noEmit
cd src-tauri && cargo test install_then_uninstall_grok
cd src-tauri && cargo test set_toml_table_bool
```

## Manual Regression Fixes

- [x] Grok 历史恢复项目匹配：`matchesHistorySource` 不再把 Grok 项目过滤为零候选。
- [x] Grok Hook 本地接收：`normalize_source` 与 `is_valid_payload` 放行安装器写入的 Grok 事件集合。
- [x] 回归测试：Grok 合法事件通过，未知事件继续拒绝。
- [x] Grok 实时统计恢复 Claude/Codex 的严格会话绑定：未绑定 `cliSessionId` 时不回退项目最近会话，仅“今日项目用量”按项目聚合。
- [x] Hook 绑定与后台加载期间保留卡片骨架，不切换为整面板加载态。
- [x] Grok 审批通知改为原生 `PreToolUse(Bash|Edit|Write|MultiEdit)` 映射 `PermissionRequest`；`bypassPermissions` 抑制，单模块卸载保留共享的 `ToolStart`。
- [x] Grok 精确 sessionId 在 catalog miss 时直扫对应本地会话目录；后台索引刷新改为 `wait=false`，避免 1GB catalog 全量刷新卡死实时轮询。

## Risky files

- `hook_settings.rs`（大文件，只追加）
- `history.rs`（只改 grok 扫描路径）
- `terminalStore.ts`（detect/resume/env 三处）

## Rollback

卸载 Grok hook；代码 `git revert` 本任务 commits。compat 保持 false 可接受。
