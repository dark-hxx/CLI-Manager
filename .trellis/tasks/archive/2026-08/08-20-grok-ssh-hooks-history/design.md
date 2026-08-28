# Design: Grok SSH CLI/Hook and local delete

## Discovery list

| 触点 | 处理 |
|---|---|
| `SshToolSource` / `resolveSshToolSource` / `DEFAULT_SSH_TOOL_CONFIG_ROOT` | 加 `grok`，history resolver 仍只放行 Claude/Codex |
| `SshCliIntegrationDialog` / `sshAgentIntegrationStore` / i18n | 第四个 source 卡片与 grokRoot 持久化 |
| `ssh_launch.rs` / `terminalStore` | 准入 `grok`，注入 `GROK_HOME` |
| `ssh.rs` / `ssh_db.rs` / `ssh_integration.rs` | source 白名单、file roles、history candidate 缺失校验、preferences |
| `ssh-agent/hook_config.rs` + `hook_runtime.rs` | `Source::Grok`，JSON+compat TOML，runtime 事件 |
| `history.rs` `history_delete_session` | 允许 grok，整目录删除 |
| `historySources.ts` / `history_sources.rs` | `delete: supported` |
| `historyResumeCommand` / `resumeCliArgs` / `saveSessionToSidebar` | Grok session ID 白名单 |
| SSH history / convert / ccusage | 确认无关 |
| CHANGELOG / 功能清单 / cli-hook / ssh-agent / history-index 契约 | 更新 |

## SSH Grok files

```
$GROK_HOME/
  hooks/cli-manager.json   # role grokHooks
  config.toml              # role grokCompat: compat.claude.hooks / compat.cursor.hooks = false
```

Native/bridge mapping 对齐本地 `apply_named_hook_module(..., "grok", ...)`。不调用 grok CLI doctor。

## Delete

1. `looks_like_grok_updates_file`
2. session 目录在 `resolve_grok_history_root` 内
3. 目录名通过 `[A-Za-z0-9_-]{1,128}`
4. 备份 updates.jsonl + summary.json
5. `remove_dir_all`；失败则尽量从备份写回并返回错误

## Agent

- version `0.1.10`，protocol `1.11`
- Grok 与 Kimi 一样不生成 history candidate
