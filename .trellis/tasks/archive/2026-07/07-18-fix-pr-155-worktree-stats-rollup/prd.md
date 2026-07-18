# Fix PR #155 Worktree Stats Rollup

## Goal

Repair PR #155 so realtime today usage rolls all active Worktree paths into the parent project exactly once, without duplicate counts, N-per-Worktree IPC calls, or dependence on the active checkout already having a history session.

## Requirements

- Extend `history_get_stats` with an optional multi-path project filter while preserving the existing single `projectPath` contract.
- Normalize, sort, and deduplicate project paths before filtering and cache-key generation.
- Match a history session when any configured project/Worktree path matches, but aggregate each indexed session only once.
- Replace frontend per-path `Promise.all` aggregation with one backend request.
- Keep ordinary single-project and unbound-path behavior compatible.
- Load project-level today usage whenever a usable path list exists, even if the active checkout has no `latestSession`.
- Keep session-level token/context/tool cards scoped to the active CLI session.
- Add Rust and frontend regression coverage for overlapping paths, cache identity, and request normalization.
- Update history stats contracts, `CHANGELOG.md` version `V1.2.9`, and `docs/功能清单.md`.
- Associate the commit with issue #137 / PR #155 and push to the contributor branch.

## Confirmed Facts

- `session_matches_project_path` treats a target path as matching the same path or any descendant cwd.
- CLI-Manager permits custom Worktree roots inside the parent repository.
- PR #155 currently queries every path separately and sums the responses.
- The realtime panel currently clears today usage whenever `latestSession` is null.
- The contributor branch is `Kyou12138/feat/137-worktree-stats-rollup` and maintainer edits are enabled.
- Changelog Target: `V1.2.9`.

## Acceptance Criteria

- [x] Main project plus nested Worktree paths do not double count sessions or tokens.
- [x] Sibling/default Worktrees roll up into the same parent project total.
- [x] The frontend performs one `history_get_stats` request per today-usage refresh.
- [x] A main or Worktree tab without its own latest history session can still show project-wide today usage.
- [x] Existing single `projectPath` callers remain compatible.
- [x] Cache keys differ for different multi-path filter sets and remain stable across ordering/duplicates.
- [x] Focused tests, TypeScript checking, Rust formatting/checking, and relevant Rust tests pass.
- [x] The repaired commit is ready to push to the original PR branch and maintainer write access was verified with `git push --dry-run`.

## Out Of Scope

- Changing historical dashboard project filter semantics.
- Changing session-level realtime cards.
- Fixing PR #156.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
