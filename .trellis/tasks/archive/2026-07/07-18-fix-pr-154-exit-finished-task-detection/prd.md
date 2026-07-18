# Fix PR #154 Exit Finished Task Detection

## Goal

Repair PR #154 so the optional exit check includes only finished Claude/Codex hook tasks, without changing default exit behavior or treating ordinary shell commands as CLI tasks.

## Requirements

- Preserve the existing running-task rule for PTY sessions.
- When `backgroundIncludeFinishedTasks` is enabled, include only hook-source `done` and `failed` states.
- When the setting is disabled, `attention`, `done`, and `failed` must not change the existing exit decision.
- Keep daemon finished-session detection behind the same setting.
- Add focused regression coverage for running, attention, hook-finished, and shell-finished states.
- Keep PR #154's settings, i18n, and sync behavior intact.
- Record the behavior change under `CHANGELOG.md` version `V1.2.9`.
- Keep the commit associated with issue #142 / PR #154.

## Confirmed Facts

- `tabNotifications` merges hook and shell runtime states.
- Ordinary shell `command_finished` events produce `done` or `failed`.
- The existing background-task contract counts only `running` by default.
- PR #154 is based on commit `16fdec3`; current `origin/master` has advanced.
- The contributor branch is `Kyou12138/fix/142-background-include-finished` and permits maintainer edits.

## Acceptance Criteria

- [x] Default setting off produces the same exit-task IDs as the pre-PR running-task selector.
- [x] Hook `done` and `failed` are included only when the setting is on.
- [x] Shell-only `done` and `failed` are never included as finished CLI tasks.
- [x] `attention` is not newly included by this setting.
- [x] Existing running Claude/Codex and shell tasks remain detected.
- [x] Type checking and focused tests pass.
- [x] The repaired commit is ready to push to the original PR branch and maintainer write access was verified with `git push --dry-run`.

## Out Of Scope

- Changing daemon lifecycle behavior.
- Changing the exit dialog wording or available actions.
- Fixing PR #155 or PR #156.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
