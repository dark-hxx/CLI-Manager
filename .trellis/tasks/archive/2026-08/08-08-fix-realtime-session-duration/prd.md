# fix: restore realtime session duration

## Changelog Target

`[TEMP]`

## Goal

Restore accurate realtime session duration in the sidebar by deriving history timestamps from transcript events when the source file's creation and modification times are identical, as is currently common for Codex rollout JSONL files.

## What I Already Know

- The frontend computes duration as `updated_at - created_at`.
- Rust `session_file_fingerprint` currently supplies filesystem creation/modification times to the cached session computation.
- Current Codex rollout files commonly have equal filesystem creation and modification times, while transcript records contain real timestamps.
- Session lookup and realtime detail loading succeed; the defect is in the timestamp data source.

## Requirements

- Prefer the earliest and latest valid transcript timestamps for session `created_at` and `updated_at` when available.
- Preserve filesystem timestamps as the fallback for transcripts without usable timestamps.
- Keep cache invalidation based on the file fingerprint unchanged.
- Preserve source-specific metadata overrides such as Cursor and Grok behavior.
- Add a regression test covering Codex session metadata and later transcript events.
- Update `CHANGELOG.md` and `docs/功能清单.md` under `[TEMP]`.

## Acceptance Criteria

- [ ] A Codex rollout with equal file creation/modification times reports a positive duration based on transcript timestamps.
- [ ] A live Codex session's latest transcript timestamp advances `updated_at` after re-scan.
- [ ] A transcript without valid timestamps still uses filesystem metadata without panic or invalid ordering.
- [ ] Existing history Rust tests pass, `cargo check` passes, and frontend type-check passes.
- [ ] GitNexus change detection reports only expected history/statistics paths before commit.

## Definition of Done

- Root-cause fix implemented at the history parsing boundary.
- Regression coverage added.
- Changelog and feature inventory updated.
- Quality checks completed and changes committed to Git.

## Out of Scope

- Changing the frontend duration formatting or adding a display-only fallback.
- Rebuilding or deleting users' derived history cache files.
- Changing the history IPC command signatures.

## Technical Notes

- Relevant backend: `src-tauri/src/commands/history.rs` (`SessionSummaryScan`, transcript scanners, `build_session_computation`).
- Relevant frontend consumer: `src/components/terminal/TerminalStatsPanel.tsx`.
- Root-cause lane: behavioral, cross-layer, and regression; fix belongs at transcript timestamp extraction rather than the UI.
- GitNexus impact was attempted for the Rust symbols but those symbols are not indexed; the fallback contract plus source cross-reference is `history-index-contracts.md`.
