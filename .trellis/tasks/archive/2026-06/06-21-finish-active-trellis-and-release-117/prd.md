# Finish Active Trellis Tasks and Release V1.1.7

## Goal

Merge the latest `origin/master`, finish/close the active Trellis work that is already represented in the current working tree, update release notes for `V1.1.7`, verify the codebase with static checks, and create a local commit. Do not push.

## Requirements

* Pull and merge `origin/master` into the current `master` branch.
* Preserve existing local uncommitted work while merging remote changes.
* Treat the existing working-tree changes as the implementation scope; do not redesign or refactor unrelated code.
* If conflicts or verification failures appear, make only the smallest necessary fixes.
* Update app version metadata from `1.1.6` to `1.1.7` across npm, Cargo, and Tauri sources.
* Add a `V1.1.7` section to `CHANGELOG.md` summarizing the current changes.
* Finish/archive active Trellis task directories that are complete or superseded by the current release scope.
* Run relevant static checks: `npx tsc --noEmit` and `cd src-tauri && cargo check`.
* Run GitNexus change detection before commit.
* Create a local git commit for the release work; do not push.

## Acceptance Criteria

* [ ] `master` includes latest `origin/master` or any pull failure is explicitly reported.
* [ ] Existing local work remains present after merge.
* [ ] Version sources all report `1.1.7`.
* [ ] `CHANGELOG.md` contains a `V1.1.7` entry above `V1.1.6`.
* [ ] TypeScript check passes, or remaining failures are reported with exact output.
* [ ] Rust `cargo check` passes, or remaining failures are reported with exact output.
* [ ] Completed Trellis tasks are archived or clearly left active with reason.
* [ ] GitNexus `detect_changes` is run before commit.
* [ ] A local commit is created and no push is performed.

## Definition of Done

* Keep changes minimal and limited to release/verification/fix scope.
* Avoid dependency changes unless already present in the working tree or required by existing implementation.
* Do not start the Tauri desktop app; runtime UI verification is manual.
* Report verification results honestly.

## Technical Approach

Use a reversible stash including untracked files before pulling so dirty local work is protected. Merge `origin/master`, re-apply local work, resolve conflicts if any, then verify. Version updates follow `.trellis/spec/guides/version-update-checklist.md`. Changelog content is derived from the current diff and Trellis PRDs. Trellis archive operations are performed after verification so task state matches the code snapshot being committed.

## Decision (ADR-lite)

**Context**: The repository has many active historical Trellis tasks and an already-dirty working tree.

**Decision**: Treat this as a release consolidation task: preserve and verify current work rather than re-implementing each historical task from scratch.

**Consequences**: This keeps the operation practical and low-risk, but some old active tasks may be archived as superseded by the release instead of individually reopened.

## Out of Scope

* Pushing to remote.
* Creating tags or GitHub releases.
* Manual desktop UI verification by the AI.
* Reworking historical tasks that are not represented by current code changes.
* Broad cleanup or refactor unrelated to merge/verification failures.

## Technical Notes

* Relevant specs read:
  * `.trellis/spec/backend/index.md`
  * `.trellis/spec/backend/cli-hook-contracts.md`
  * `.trellis/spec/frontend/index.md`
  * `.trellis/spec/frontend/component-guidelines.md`
  * `.trellis/spec/frontend/state-management.md`
  * `.trellis/spec/frontend/quality-guidelines.md`
  * `.trellis/spec/guides/index.md`
  * `.trellis/spec/guides/version-update-checklist.md`
* Current upstream: `origin/master`.
* Current version before release: `1.1.6`.
* Runtime UI verification must be manual per project memory and frontend quality guideline.
