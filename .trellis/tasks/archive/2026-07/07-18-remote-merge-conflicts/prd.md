# 拉取远程并解决冲突

## Goal

将 `origin/master` 的最新代码合并到当前本地 `master`，保留本地版本化备份功能与远端新增改动，解决所有冲突并保持工作区可验证、可提交。

## Changelog Target

不写入（仅代码集成，不新增产品行为记录）。

## Requirements

- 使用普通 merge 拉取远端，避免重写已提交的本地历史。
- 逐项分析冲突，不能简单选择 ours/theirs 覆盖整文件。
- 保留本地三个提交，同时纳入远端六个提交。
- 冲突解决后运行适合改动范围的 TypeScript 与 Rust 检查。
- 不推送远端。

## Acceptance Criteria

- [ ] `origin/master` 已合并到本地 `master`。
- [ ] Git 不存在未解决冲突。
- [ ] 本地版本化备份功能未被远端覆盖。
- [ ] 远端新增代码未被无理由丢弃。
- [ ] `npx tsc --noEmit` 与 `cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过。
- [ ] 合并结果已提交，工作区干净。

## Technical Approach

执行 `git merge origin/master`，读取每个冲突的 base/ours/theirs 和相关调用点，按语义合并。完成后检查 diff、运行验证并提交 merge commit。

## Decision (ADR-lite)

选择 merge 而不是 rebase：当前本地已有功能、任务归档和会话记录三个提交，merge 可保留历史且避免重写已经形成的提交链。

## Out of Scope

- 不更新 `CHANGELOG.md`。
- 不推送代码。
- 不顺手重构与冲突无关的模块。

## Goal

TBD.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
