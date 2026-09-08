# Fix WebDAV worktree sync conflicts

## Goal

Fix WebDAV sync missing worktree records and stale conflict resolution state.

## Changelog Target

V1.2.8

## Requirements

- WebDAV upload/download must include durable `worktrees` records so worktree child nodes survive cross-device sync and restore.
- Only active worktree records are synced; discarded worktrees and rows marked `missing` are out of sync scope.
- Restored worktree records must be checked against the local filesystem; absent directories become `missing` before the user can launch them.
- Synced project rows must include worktree isolation fields: `worktree_strategy`, `worktree_root`, and `worktree_deps_prompt_enabled`.
- Old remote/local sync payloads without `worktrees` must remain readable and must import as an empty worktree list.
- Conflict resolution must be observable:
  - "Keep Local" uploads local data and clears the conflict UI on success.
  - "Use Remote" applies remote data, refreshes project/worktree stores, and prevents the same resolved conflict from reappearing after restart.
- Legacy sync-config migration must stop recreating removed password keys, otherwise app startup creates repeated `sync-config.json.backup-*` files.
- Keep sync domain behavior simple: worktrees follow the `projects` domain because they are project children, not a separate user-selectable domain.
- Do not add dependencies or change WebDAV authentication/storage paths.

## Acceptance Criteria

- [x] Upload payload includes projects, groups, command templates, and active worktrees.
- [x] Download/apply restores active worktrees only when the projects domain is selected; unselected project-domain restores preserve local worktrees.
- [x] Discarded or missing worktrees are not uploaded or restored.
- [x] Restored worktrees whose local directories no longer exist are marked missing and cannot be launched from sidebar, scoped terminal, or terminal tab actions.
- [x] Legacy `sync-config.json` migration ignores removed password keys and stops repeated backup creation.
- [x] Legacy payloads with no `worktrees` import without throwing.
- [x] `resolveConflict(true)` leaves `status="success"` and clears `conflictInfo` / `pendingRemoteData`.
- [x] `resolveConflict(false)` writes the resolved snapshot back to the current device remote snapshot so startup auto-download does not show the same conflict again.
- [x] `npx tsc --noEmit` passes.
- [x] `cargo check --manifest-path src-tauri/Cargo.toml` passes.

## Notes

- GitNexus impact was rebuilt for this worktree before editing. Reported risk is LOW for `applySyncData`, frontend `upload`, frontend `download`, `resolveConflict`, and `loadWorktrees`.
- `cargo fmt --manifest-path src-tauri/Cargo.toml` could not run because `cargo-fmt.exe` is not installed for toolchain `1.95.0-x86_64-pc-windows-msvc`.
