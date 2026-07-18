# Versioned Backup Contracts

## Scope

Applies to `src/stores/syncStore.ts`, `src/lib/syncSettings.ts`, the backup settings page, `src-tauri/src/sync/mod.rs`, `src-tauri/src/webdav/mod.rs`, and sync Tauri commands.

## Snapshot contract

- New writes use `BackupSnapshotV3` only: `version = 3`, `manifest`, and `data`.
- `manifest` contains `snapshotId`, `createdAt`, `appVersion`, `deviceId`, `deviceName`, `platform`, and `contentHash`.
- `contentHash` is SHA-256 over canonicalized `data`; snapshot id and creation time are excluded.
- Data domains are fixed: `workspace`, `preferences`, `modelPrices`, `notifications`, and `statusline`.
- Workspace is atomic and contains groups, full projects including timestamps, active Worktrees, and persistent command templates.
- Project and Worktree paths are restored byte-for-byte. Missing local paths are reported by existing project diagnostics and Worktree missing-state checks.

## Inclusion policy

- Every `Settings` key must be classified by `SETTING_BACKUP_POLICY`; a new unclassified key must fail TypeScript compilation.
- Portable preferences may include command-suggestion provider/base URL/API key/model and file-explorer ignore rules.
- Device/runtime/resource state is excluded: default shell, external-terminal selection, platform/WSL/GPU/low-memory/symlink flags, shell profiles, scrollback, session restore, Workspan, backgrounds, desktop-pet data, usage/test results, hook installation/config paths, and cc-switch paths.
- Notifications are a separate domain and preserve complete sanitized target configuration.
- Statusline backup contains CLI-Manager `statusline/settings.json` plus `statusline/profiles.json`; restore validates both and never edits Claude settings, Codex `config.toml`, cc-switch, or font installation state.
- WebDAV password remains only in the operating-system credential store and never enters a snapshot.
- Snapshots are plaintext. UI disclosure must mention project environment variables, command templates, suggestion API keys, and third-party Hook credentials in both languages.

## Storage and WebDAV

- WebDAV path: `<remoteDir>/backups/<UTC>--<deviceName>--<deviceId>--<snapshotId>.json`.
- WebDAV client supports `PROPFIND Depth: 1` for enumeration and `DELETE` for explicit removal.
- Remote paths accepted for download/delete must remain under the normalized backup directory and must end in a strictly parsed snapshot filename.
- A successful upload is not failed by retention cleanup. Cleanup keeps the newest 10 snapshots for the same `deviceId`.
- Local export path is `cli-manager-backup-YYYYMMDD-HHmmss-<snapshotId>.zip`, containing `snapshot.json`.
- Legacy ZIP files containing `sync.json`, plus V1/V2 JSON payloads, remain explicit import inputs; all subsequent writes use V3.
- Successful WebDAV response bodies are limited to 16 MiB.

## Lifecycle

- Startup never auto-downloads or resolves conflicts. It only retries the current WebDAV target's outbox asynchronously.
- Exit auto-backup first writes `.cli-manager/backups/outbox/<targetHash>/<snapshotId>.json`, then attempts upload inside the existing 8-second exit budget.
- Failed or timed-out uploads leave the outbox file for the next startup.
- Automatic backup skips when `contentHash` matches the last queued/created backup. Manual backup always creates a new snapshot.
- Legacy `autoSyncOnClose = upload` migrates once to `autoBackupOnClose = true`; startup/download legacy actions migrate to off.

## Restore

- Restore validates the full snapshot before mutation and creates `.cli-manager/backups/restore-safety/latest.zip` first.
- Workspace and model-price replacements run in a SQLite transaction.
- Selected domains are replaced completely; unselected domains are untouched.
- Preferences are restricted to the classified portable key set. Notification targets are sanitized.
- Statusline files use existing validation and same-directory temporary replacement.
- After workspace restore, reload project/Worktree stores, refresh project diagnostics, and mark missing Worktrees.
- Any failure applies the safety snapshot automatically. The latest safety snapshot also supports one explicit undo.

## Required verification

- `npx tsc --noEmit`
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- Manual checks: create two snapshots without overwriting, auto-backup no-change skip, offline outbox retry, five-domain restore, rollback/undo, legacy ZIP import, Chinese/English UI, and 24-hour timestamps.
