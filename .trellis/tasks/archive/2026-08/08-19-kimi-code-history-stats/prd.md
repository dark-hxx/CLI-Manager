# Kimi Code 本地历史、删除、恢复与实时统计

## Changelog Target

V1.3.7

## Goal

按 owner 在 PR #219 评论中点名的四个方向，把当前 Kimi Code（`$KIMI_CODE_HOME`，默认 `~/.kimi-code`）接入本地历史会话列表、删除、恢复和终端实时统计。旧 `kimi-cli` / `~/.kimi` 不扫描、不删除、不迁移。SSH 历史继续只支持 Claude/Codex。

## Root-Cause / Feature Statement

上一轮只把 Kimi 做成 Hook source，历史 source 刻意拆开。实时统计绑定 `cliSessionId` 后走 `history_list_sessions`；catalog 没有 kimi parser 和精确 id 直查时，新会话用量会一直为 0。当前 Kimi wire 又把助手/工具事件封装在 `context.append_loop_event.event`，Token 使用 camelCase 专有字段，`session_index.jsonl` 是 latest-wins 的 append-only 日志；因此修复必须落在历史根发现、真实 wire 折叠、精确 session 直查和 tombstone 删除协议，以及前端 resume/source 登记，而不是在统计面板做项目最近会话兜底或重写共享索引。

## Requirements

- 本地/WSL 历史列表只索引 `agents/main/wire.jsonl`；子 Agent wire 不单独成行，随父会话目录删除。
- catalog miss 且 `source=kimi`、合法 sessionId、`limit=1`、`offset=0` 时直查磁盘，禁止全库扫描或回退最近会话。
- 删除：备份 `state.json`、main `wire.jsonl` 与 index 快照，向 `session_index.jsonl` 单次追加 `{sessionId, deleted:true}` 后再 `remove_dir_all` 整个 session 目录；目录删除失败时追加原 active record 作补偿。禁止整文件重写；路径必须在 history home 内；失败不得声称成功。
- 恢复：`kimi --session <id>`；无 id 时 `kimi --continue`；剥离 `--session/-S/--resume/-r/--continue/-c/-C`，历史与 Hook ID 在拼接 shell 命令前执行 `[A-Za-z0-9_-]{1,128}` 白名单校验。
- 历史根：`history source configRoot ?? kimiHookConfigDir ?? $KIMI_CODE_HOME ?? ~/.kimi-code`。本地自定义 Hook 目录不注入启动环境。
- WSL UNC 用 `wsl.exe find`，不做宿主递归。
- 转换、消息编辑、ccusage 看板、SSH 历史、旧 `~/.kimi` 均不做。
- 用户可见文案兼容 zh-CN / en-US；时间保持 24 小时制。

## Scenario Matrix

| 维度 | 预期 |
|---|---|
| 窗口焦点 / 分屏 / 托盘 / sidebar / Workspan / focus mode | 复用现有历史与统计面板，不新增抢焦点 |
| 本地 PS/CMD/Pwsh、macOS/Linux Bash | 读 `~/.kimi-code` |
| WSL UNC | `wsl.exe find` `wire.jsonl`，再过滤 `agents/main/wire.jsonl` |
| Worktree | 按 cwd/project_key 过滤，与 Grok 相同 |
| Hook 已装/未装 | 实时统计只认绑定的 `cliSessionId`，禁止回退项目最近会话 |
| 自定义 Hook 目录 vs 默认 Home | 历史用 history source / hook config dir / 默认 home |
| SSH Kimi | 历史与 SSH 实时统计仍 unsupported，走既有通用提示 |
| 旧 `~/.kimi` | 不扫描、不删除、不迁移 |
| 精确 sessionId 未进 catalog | 直查磁盘 |
| 删除失败 | 不静默成功；tombstone 追加失败则不删目录；删目录失败则追加补偿记录恢复 latest-wins 状态 |

## Acceptance Criteria

- [x] 本地 Kimi 会话出现在历史列表/搜索/统计，标题与 cwd 来自 `state.json` / index。
- [x] 实时统计按 Hook `sessionId` 命中，catalog 未索引时仍能读到 usage。
- [x] 删除移除 session 目录并更新 `session_index.jsonl`；路径穿越被拒绝。
- [x] 历史恢复生成 `kimi --session <id>`，冲突 resume 参数被剥离。
- [x] SSH Kimi 仍不能读远程历史；旧 `~/.kimi` 不被当成来源。
- [x] `CHANGELOG.md` V1.3.7 与 `docs/功能清单.md`、相关契约已更新。
- [x] 聚焦 Rust/Node 测试、`npx tsc --noEmit`、`cargo fmt --check`、`git diff --check` 通过。

## Notes

- GitNexus 影响分析显示统计扫描链路为 HIGH 风险；修复保持在 Kimi parser/index 边界，并用真实上游 wire fixture 覆盖。
- 对标 Grok 的目录型会话 + 精确直查 + hook 绑定实时统计；删除对标 Claude/Codex 本地文件删除，但 kimi 必须删整目录并维护 index。
