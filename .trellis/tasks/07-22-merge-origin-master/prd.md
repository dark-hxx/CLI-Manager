# 合并远程主分支并解决冲突

## Goal

将 `origin/master` 的最新代码合并到当前分支 `feat/web-management-capabilities`，解决冲突并保留当前工作区已有改动。

## Requirements

* 拉取 `origin/master` 最新引用。
* 合并到当前分支，不覆盖 `AGENTS.md`、`CLAUDE.md` 的未提交改动。
* 逐项解决合并冲突，不引入额外功能修改。

## Acceptance Criteria

* [ ] `origin/master` 已合入当前分支。
* [ ] 工作区不存在未解决冲突标记。
* [ ] 原有未提交改动仍被保留。
* [ ] Git 状态与合并结果已检查。

## Changelog Target

`[TEMP]`，本次仅同步分支，不新增变更日志条目。

## Out of Scope

* 不推送远程。
* 不提交用户原有未提交改动。
* 不修改无关代码。

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
