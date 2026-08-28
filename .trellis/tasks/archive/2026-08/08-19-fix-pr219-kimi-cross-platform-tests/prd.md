# Fix PR #219 Kimi cross-platform test failures

## Goal

Make PR #219's Kimi Code Hook validation reproducible on Windows without weakening the
Linux-only SSH Agent path-safety contract, then push the repair to the PR branch for a
fresh review.

## Confirmed Facts

- PR #219 head is `kcng0:agent/kimi-code-cli-hooks` at
  `a00622b4981e78b9d5682047b1c957bdd9219154`.  Its clean isolated checkout is
  synchronized with `origin/agent/kimi-code-cli-hooks`.
- `scripts/kimiHookFrontend.test.mjs:13` extracts `mapCliHookEvent` with a
  LF-only regular expression.  On the project's Windows checkout
  (`core.autocrlf=true`), the TypeScript source uses CRLF and the assertion at
  line 14 fails before the four focused tests are registered.
- `src-tauri/ssh-agent/src/hook_config.rs:1789` creates a host temporary
  directory and passes its canonical path into `plan_files`.  The remote Agent
  intentionally rejects paths containing `\\` in
  `validate_canonical_path` (`hook_config.rs:209`), so the test fails on
  Windows even though the Agent is released only for Linux x64/arm64.
- The review's merge-tree check found a content conflict only in
  `CHANGELOG.md`.  The user explicitly deferred rebase or merge work until
  after the repaired PR is reviewed again.

## Requirements

- R1. The Kimi frontend focused test must normalize checkout line endings before
  it applies its source-extraction regular expression.  It must continue to
  exercise the existing `mapCliHookEvent` implementation rather than duplicate
  or change production lifecycle logic.
- R2. The remote Kimi config-planning test and its Unix-only test imports must run
  only on Unix hosts, matching the SSH Agent's supported POSIX runtime contract.
  The runtime canonical-path validator must remain strict.
- R3. Commit and push the repair only to
  `kcng0:agent/kimi-code-cli-hooks`.  Do not rebase the branch or merge it
  into `master` during this task; request a fresh review after push.
- R4. Record this repair under `V1.3.7` in `CHANGELOG.md` and update the
  Kimi Hook section of `docs/功能清单.md`.

## Acceptance Criteria

- [ ] With `core.autocrlf=true`, `node scripts/kimiHookFrontend.test.mjs`
  completes all four tests successfully.
- [ ] On the Windows host, `cargo test --manifest-path
  src-tauri/ssh-agent/Cargo.toml` passes; the Kimi Unix-only test imports do not
  emit host-platform unused-import warnings.
- [ ] On Unix, the Kimi config-planning test remains compiled and executed.
- [ ] `npx tsc --noEmit`, `cargo fmt --check` for the affected Rust crate,
  and `git diff --check` pass.
- [ ] The PR branch remains limited to the planned test/documentation/task
  artifacts, is pushed to its fork head branch, and is ready for a new review.
- [ ] The changelog and feature inventory include accurate V1.3.7 repair notes.

## Scope Boundaries

### In scope

- The CRLF-safe Kimi frontend test extraction.
- Unix gating for the SSH Agent Kimi config-planning test and its imports.
- V1.3.7 records, focused validation, task artifacts, and push to the PR
  source branch.

### Out of scope

- Changes to Kimi Hook product behavior, the Kimi TOML planner, or the
  canonical-path security rule.
- New Hook events, UI changes, dependencies, protocol changes, migrations, or
  remote history support.
- Rebasing, merging, or resolving the known `CHANGELOG.md` conflict against
  `master`; these are deferred until the repaired PR has passed review.
- Unrelated changes currently present in the local `master` worktree.

## Key Decisions

- Normalize text in the frontend test at the file-read boundary.  This is the
  source of the CRLF-sensitive failure and keeps the production state mapper
  unchanged.
- Gate the remote Agent test on Unix instead of accepting Windows paths.  The
  Agent's installer, release workflow, and production execution target only
  Linux; loosening its validator would change a security boundary to satisfy a
  host-only test setup.
- The user selected PR-first delivery: repair, push, and re-review happen before
  any base-branch synchronization or merge operation.
- The user selected `V1.3.7` for both required product records.

## Open Questions

None.  The requested scope, release-record version, target PR branch, and
compatibility behavior are explicit.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
