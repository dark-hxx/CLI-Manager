# 恢复旧 Grok 临时 Home 会话

## Goal

恢复旧错误 Grok 临时 Home 中已经产生的会话，并保证快照释放/垃圾回收不会删除尚未恢复的用户历史。

## Background

- Changelog Target: `[TEMP]`
- 已确认旧快照 `generated/grokbuild/<snapshot>/grok/sessions` 中存在真实会话文件。
- 新启动链路已不再替换 `GROK_HOME`，但旧持久化快照会在重建时调用 release；原实现直接递归删除快照，存在历史数据丢失风险。

## Root-Cause Statement

根因位于供应商快照生命周期边界：旧 Grok 快照被错误当作纯临时配置，release/GC 未识别其中已被 Grok 写入的会话用户数据，因此修复必须在删除快照前完成可验证、可重试的历史恢复。

## Requirements

- 删除旧 Grok 快照前，检测其中的 session 目录。
- 先复制到 `.cli-manager/backups/provider-grok-history/<snapshotId>`，再把缺失会话复制到当前真实 Grok history root。
- 不覆盖目标中已存在的同 ID 会话；备份永久保留供人工恢复。
- 任一步失败时不得删除源快照。
- WSL UNC 目标不得用宿主文件 API 访问；保留源快照并返回稳定错误。
- 新格式无临时 Grok Home 的快照和 Claude/Codex 快照保持原释放行为。

## Acceptance Criteria

- [x] 旧快照会话成功备份并出现在真实 `.grok/sessions`。
- [x] 重复恢复幂等，不覆盖已有会话。
- [x] 复制失败、符号链接或 WSL UNC 目标时保留源快照。
- [x] release 与 GC 使用同一恢复 helper。
- [x] Rust 定向/provider 测试与 `cargo check` 通过。

## Verification Evidence

- `cargo test provider:: --lib`: 102/102 passed.
- Recovery regressions cover backup/restore idempotence, existing-session no-overwrite, and WSL fail-before-mutation.
- `cargo check`, `cargo fmt --all -- --check`, `npx tsc --noEmit`, `node scripts/resumeCliArgs.test.mjs`, and `git diff --check` passed.
- The user machine contains a legacy generated Grok session, confirming the migration path is exercised by real affected data on the next release/GC cycle.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
