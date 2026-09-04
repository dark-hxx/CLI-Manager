# Implementation Plan

## Ordered steps

1. Start the approved Trellis task after reviewing the final PRD, design, and this plan.
2. Re-run GitNexus upstream impact for `SessionReplayPanel.tsx` and confirm the LOW risk/file-local scope before editing.
3. Update `ProgressView` to use a `Set<string>` for independent turn expansion, preserving valid IDs across model updates and allowing an empty set.
4. Add a V1.3.9 entry to `CHANGELOG.md` under the existing AI replay/progress or equivalent terminal history section, and update the matching V1.3.9 section in `docs/功能清单.md`.
5. Run focused/static validation:
   - `npx tsc --noEmit`
   - `node --test scripts/replayProgressModel.test.mjs`
   - `git diff --check`
6. Run GitNexus `detect_changes()` and verify only the intended component, task artifacts, and the two V1.3.9 product records are in scope; inspect the final diff without staging unrelated user changes.
7. Report the root cause, discovery list, validation results, and manual UI checks for a human reviewer.

## Manual verification checklist

- In AI 进展 → 进展, collapse the current turn; verify it stays collapsed.
- Expand two or more turns; verify expanding one does not collapse the others.
- Collapse all turns; verify no turn reopens by itself during replay progress updates.
- Reopen any turn after all are collapsed.
- Switch replay sessions or refresh the timeline; verify no stale turn remains expanded and no invalid ID causes an error.
- Verify the conversation and nested step disclosure controls retain their existing behavior.

## Rollback point

If type-checking or the manual review reveals an unintended change outside timeline-turn disclosure, revert only the `ProgressView` state edit and keep unrelated worktree changes untouched; no database, IPC, or migration rollback is required.
