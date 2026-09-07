# Design: Kimi Code local history

## Discovery list

| 触点 | 处理 |
|---|---|
| `src-tauri/src/commands/history.rs` HistoryRoots / list / delete / scan dispatch | 加 `kimi_config_dir`，dispatch kimi parser |
| `src-tauri/src/commands/history/kimi.rs` | 新建：collect / parse / exact lookup / delete |
| `history/catalog.rs` HistoryRoots 字面量 | 补 `kimi_config_dir` |
| `history_edit.rs` / `request_logs.rs` | 透传 `kimi_config_dir` |
| `history_sources.rs` | 登记 `kimi`，location=configRoot，`default_leaf=.kimi-code` |
| `history_backup.rs` restore candidates | 允许 `kimi` |
| `src/lib/historySources.ts` / `historyPathArgs.ts` / `historyResumeCommand.ts` | source、pathArgs、resume |
| `cliTools.ts` / `terminalStore.ts` / `projectStartupCommand.ts` / `saveSessionToSidebar.ts` / `resumeCliArgs.ts` | resume kind 与参数剥离 |
| `TerminalStatsPanel.tsx` `inferHistorySource` | 识别 kimi |
| `i18n.ts` | `historySources.source.kimi` |
| SSH / ccusage / convert / edit | 确认无关，不扩展 |
| 未跟踪 File Preview 文件 | 不纳入本 PR |

## Layout

```
$KIMI_CODE_HOME/
  session_index.jsonl
  sessions/<workDirKey>/<sessionId>/
    state.json
    agents/main/wire.jsonl
```

列表 `file_path` 指向 main `wire.jsonl`。`project_key` 用规范化完整 cwd。

## Exact lookup

合法 id：1–128，字母数字 `_-`，无 `/` `\` `\0` `..`。不要 `Uuid::parse_str`。index 按顺序应用同一 session 的有效记录，最后一条 active record 生效，最后一条 tombstone 表示不存在；缺少字符串 `sessionDir` / `workDir` 的畸形普通行忽略。`sessionDir` 必须为 `sessions/` 内的绝对路径且末级目录等于 session id。index 未命中时再扫 `sessions/*/<id>/agents/main/wire.jsonl`。历史与 Hook session id 在前端构造恢复命令前再次执行同一字符白名单。

## Wire parsing

- `turn.prompt` 只作为缺少对应 `context.append_message` 时的兼容回退，避免同一用户输入重复成两条消息。
- 助手内容及工具调用/结果从 `context.append_loop_event.event` 的 `content.part`、`tool.call`、`tool.result` 折叠。
- `step.end.usage` / `usage.record.usage` 将 `inputOther`、`output`、`inputCacheRead`、`inputCacheCreation` 分别映射为 input、output、cache read、cache creation；等值快照只计一次，任一缺失时另一项仍可作为回退。

## Delete

1. 校验 wire 路径在 kimi home 内并解析 session 目录
2. 备份 `state.json` + main `wire.jsonl`（及 index 原文）
3. 以一次 append write 追加 deletion tombstone
4. `remove_dir_all`
5. 目录删除失败则追加之前的 active record 作补偿；不得从备份覆盖整个 index

## WSL

对 `$KIMI_CODE_HOME` UNC 使用 `wsl.exe find -name wire.jsonl`，只保留 `agents/main/wire.jsonl`。
