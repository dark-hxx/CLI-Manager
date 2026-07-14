# 修复 WSL Codex 历史会话查看恢复与转换

## Goal

修复 Windows 版 CLI-Manager 读取 WSL Codex 历史时的项目键不一致、历史缓存跨根污染和跨 UNC SQLite 锁问题，使历史查看、恢复后的实时回读以及 Claude -> Codex 转换在 `Ubuntu-22.04` 中可用。

## Requirements

- WSL Codex 会话校验必须按规范路径定位候选文件，并以 rollout 内的 `cwd` 推导真实项目键，不能把 `sessions/<year>/...` 的年份当作项目键。
- 来源、项目键、JSONL 后缀和历史根目录边界校验必须继续生效。
- 历史目录切换到 WSL 后，旧的 Windows Codex 缓存条目不得进入列表、搜索或 legacy catalog 播种。
- 写入 Codex 运行时索引的 WSL rollout 路径必须使用 Linux 路径；CLI-Manager 对前端仍返回可读取的 UNC 路径。
- Windows 进程不得跨 `\\wsl.localhost` 写入 WSL Codex 的 WAL SQLite 状态库；Windows 本地 Codex 的登记行为保持不变。
- WSL 转换成功后由 `codex resume <id>` 在 WSL 内发现 rollout 并修复状态库，不因 `database is locked` 将已生成的转换结果报告为失败。
- 不修改前端 Tauri command 签名、数据库 schema、依赖或 PTY 启动逻辑。
- 不删除现有转换残留文件，不覆盖工作区内其他未提交改动。

## Changelog Target

`[TEMP]`

## Acceptance Criteria

- [x] WSL Codex 索引项目键为 `tabGo`、重新枚举键为 `2026` 时，历史详情可正常打开并返回 `tabGo`。
- [x] 恢复 WSL Codex 会话后，实时历史回读不再出现 `session_file_not_indexed`。
- [x] WSL Codex session index 使用 `/home/...` Linux rollout 路径。
- [x] Codex 正占用 `state_5.sqlite-wal/-shm` 时，Claude -> Codex 转换不再返回 `codex_state_register_failed: database is locked`。
- [x] 当前 Codex 根为 WSL 时，旧 Windows Codex 缓存条目不会再触发 `session_file_outside_history_scope`。
- [x] 错误项目、错误来源、非 JSONL 和越界路径仍被拒绝。
- [x] `cargo test history --lib` 通过（84/84）。
- [x] `cargo check` 通过。
- [x] `npx tsc --noEmit` 通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
