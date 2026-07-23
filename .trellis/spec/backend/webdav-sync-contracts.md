# Versioned Backup Contracts

## Scope

Applies to `src/stores/syncStore.ts`, `src/lib/syncSettings.ts`, the backup settings page, `src-tauri/src/sync/mod.rs`, `src-tauri/src/webdav/mod.rs`, and sync Tauri commands.

## Snapshot contract

- New writes use `BackupSnapshotV3` only: `version = 3`, `manifest`, and `data`.
- `manifest` contains `snapshotId`, `createdAt`, `appVersion`, `deviceId`, `deviceName`, `platform`, and `contentHash`.
- `contentHash` is SHA-256 over canonicalized `data`; snapshot id and creation time are excluded.
- Data domains are fixed: `workspace`, `preferences`, `modelPrices`, `notifications`, and `statusline`.
- Workspace is atomic and contains groups, SSH host groups, portable SSH host profiles, full projects including timestamps, active Worktrees, and persistent command templates.
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
- Workspace and model-price replacements run in one Rust-owned SQLite transaction on one SQLx connection, with foreign keys enabled and a bounded busy timeout.
- Selected domains are replaced completely; unselected domains are untouched.
- Preferences are restricted to the classified portable key set. Notification targets are sanitized.
- Statusline files use existing validation and same-directory temporary replacement.
- After workspace restore, reload SSH host, project, and Worktree stores, refresh project diagnostics, and mark missing Worktrees.
- Any failure applies the safety snapshot automatically. The latest safety snapshot also supports one explicit undo.

## Scenario: Connection-Affine Database Restore

### 1. Scope / Trigger

- Trigger: restoring `workspace` or `modelPrices` from WebDAV, local ZIP, legacy cloud data, a safety rollback, or explicit undo.
- Goal: replace selected database domains atomically without allowing transaction control to move between pooled SQLite connections.

### 2. Signatures

- Frontend statement: `DatabaseStatement { sql: string; values: unknown[] }`.
- Backend command: `backup_restore_database(statements: Vec<BackupDatabaseStatement>) -> Result<(), String>`.
- Owned tables: `groups`, `ssh_host_groups`, `ssh_hosts`, `projects`, `worktrees`, `command_templates`, and `model_prices`.

### 3. Contracts

- The frontend may build parameterized statements, but Rust validates the complete batch before opening the write transaction.
- The backend resolves the canonical database through `app_paths::db_path()`, refuses to create a missing database, and executes `BEGIN IMMEDIATE`, all mutations, and `COMMIT` on one `SqliteConnection`.
- Accepted SQL is limited to exact whole-table `DELETE` statements and parameterized `INSERT` statements with the current owned column lists.
- New snapshots include `workspace.sshHostGroups` and `workspace.sshHosts`; their portable fields are restored in the order SSH host group -> SSH host -> project. `identity_file`, `credential_ref`, `config_file`, and `proxy_command` never enter a snapshot. A same-ID destination host retains those local fields; missing identity material downgrades `identity_file` to `interactive`, `credential_ref` to `password_prompt`, and a missing local ProxyCommand to no proxy.
- Older snapshots without both SSH workspace arrays retain the prior behavior: do not replace local SSH host tables, and restore SSH projects without a host binding.
- Use WAL, foreign keys, a 15-second busy timeout, and one process-level restore lock. Preserve the original restore error if connection close also fails.
- Never send `BEGIN` / mutations / `COMMIT` as separate `tauri-plugin-sql` IPC calls; its SQLx pool does not guarantee connection affinity between calls.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Empty batch, more than 1000 statements, or more than 30000 parameters in one statement | Reject before `BEGIN IMMEDIATE`. |
| SQL targets an unowned table, changes the allowed columns, contains multiple statements, or uses an unsupported operation | Return `backup_restore_database_statement_invalid` without mutating data. |
| Value is an array/object or an unsigned integer outside SQLite's signed range | Return `backup_restore_database_value_invalid` and roll back. |
| A mutation fails after earlier deletes/inserts | Roll back the complete database-domain batch. |
| The database remains busy beyond 15 seconds | Return the SQLite lock error; keep the previous database contents. |

### 5. Good/Base/Bad Cases

- Good: workspace and model prices restore together, commit once, then their frontend stores reload.
- Base: only `model_prices` is selected, so workspace tables are untouched.
- Bad: a WebView call starts a transaction through `tauri-plugin-sql`, then assumes later `execute` calls use the same pooled connection.

### 6. Tests Required

- Commit a delete-plus-insert batch and assert the replacement row survives with integer SQLite affinity.
- Commit SSH host group, host, and project inserts in one batch and assert the project retains its host binding and remote path.
- Force a duplicate-key failure after a delete and assert the original row remains.
- Submit a statement outside the owned-table whitelist and assert rejection occurs without writes.
- Run `npx tsc --noEmit`, focused sync/history Rust tests, and `cargo check --locked --manifest-path src-tauri/Cargo.toml`.

### 7. Wrong vs Correct

#### Wrong

```typescript
await db.execute("BEGIN IMMEDIATE");
await db.execute("DELETE FROM projects");
await db.execute("COMMIT");
```

#### Correct

```typescript
await invoke("backup_restore_database", { statements });
```

## Scenario: Portable SSH Workspace Backup

### 1. Scope / Trigger

- Trigger: changing WebDAV/local workspace snapshot collection or restore for SSH projects, SSH hosts, or SSH host groups.
- Goal: a restored SSH project retains its remote path and host binding without synchronizing credentials or device-local filesystem references.

### 2. Signatures

- `WorkspaceBackup.sshHostGroups?: Record<string, unknown>[]`
- `WorkspaceBackup.sshHosts?: Record<string, unknown>[]`
- `projects.ssh_host_id TEXT REFERENCES ssh_hosts(id) ON DELETE SET NULL`
- Restore-owned tables: `ssh_host_groups`, `ssh_hosts`, and `projects`.

### 3. Contracts

- New V3 snapshots include both SSH arrays and `projects.ssh_host_id`; restore deletes and inserts in `ssh_host_groups -> ssh_hosts -> projects` dependency order after deleting dependent project records.
- Portable host fields include endpoint, user, Config alias, auth mode, jump relation, HTTP/SOCKS5 endpoint, timeout, keepalive, encoding, startup script, notes, sorting, and timestamps.
- `identity_file`, `credential_ref`, `config_file`, and `proxy_command` remain destination-local. When a host ID already exists on the destination, those local fields are merged back into its restored row.
- Without matching local identity material, restore changes `identity_file` to `interactive`, `credential_ref` to `password_prompt`, and `proxy_command` to `none`.
- V3 and legacy snapshots without both SSH arrays do not delete destination SSH hosts; their restored SSH projects remain unbound.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Both SSH arrays are present | Replace SSH host groups and hosts in the same database batch as projects. |
| Either SSH array is absent | Keep destination SSH host tables unchanged and set restored project `ssh_host_id` to `null`. |
| Project references a host not in the snapshot | Insert the project with `ssh_host_id = null`. |
| Snapshot host uses a missing local key or credential reference | Keep the host profile but downgrade to interactive/password-prompt authentication. |
| A legacy structured proxy host embeds `@` credentials | Disable that proxy before serializing the snapshot. |
| Any host/group/project statement fails | Roll back the entire database batch, then apply the existing safety snapshot. |

### 5. Good / Base / Bad Cases

- Good: a WebDAV snapshot restores a host group, host endpoint, `/srv/project`, and project binding on a new device; the user only supplies local authentication material.
- Base: an older snapshot restores its SSH project as unbound while existing destination hosts remain available.
- Bad: serializing a saved credential reference or a custom SSH Config path into the snapshot.

### 6. Tests Required

- Assert the Rust whitelist accepts SSH host group, host, and project INSERT statements in one transaction and the restored project joins to its host.
- Assert a frontend-created snapshot includes `ssh_host_id` and excludes `identity_file`, `credential_ref`, `config_file`, and `proxy_command`.
- Assert a malformed legacy HTTP/SOCKS5 proxy containing `@` is omitted from the snapshot.
- Assert old snapshots with missing SSH arrays retain the previous unbound-project behavior.

### 7. Wrong vs Correct

```typescript
// Wrong: loses the binding even when the snapshot contains it.
environmentType, null, remotePath

// Correct: accept only a host present in the same snapshot.
environmentType, sshHostIds.has(item.ssh_host_id) ? item.ssh_host_id : null, remotePath
```

## Required verification

- `npx tsc --noEmit`
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- Rust restore tests cover successful commit, rejection of non-owned statements, and full rollback after a statement failure.
- Manual checks cover an SSH host/project WebDAV round-trip and confirm exported snapshots omit credentials and local path references.
- Manual checks: create two snapshots without overwriting, auto-backup no-change skip, offline outbox retry, five-domain restore, rollback/undo, legacy ZIP import, Chinese/English UI, and 24-hour timestamps.

## Scenario: CLI argument history preference sync

### 1. Scope / Trigger

- Applies when changing `Settings.cliArgsHistory`, its backup classification, or preference restore behavior.

### 2. Signatures

- `Settings.cliArgsHistory: CliArgsHistoryEntry[]`
- `CliArgsHistoryEntry = { cliTool: string; cliArgs: string; count: number; lastUsedAt: number }`
- `SETTING_BACKUP_POLICY.cliArgsHistory = "preferences"`

### 3. Contracts

- Preference snapshots include the complete normalized CLI argument history.
- Restore replaces the local `cliArgsHistory` field when the snapshot contains it; counts from two devices are not merged.
- Older snapshots without the field leave the current local history unchanged.

### 4. Validation & Error Matrix

- Missing field -> skip the key and preserve local history.
- Malformed entries -> `normalizeCliArgsHistory` drops invalid rows and merges duplicate tool/argument pairs after load.
- Valid field -> persist through `settingsStore.update`, then reload normalized settings state.

### 5. Good / Base / Bad Cases

- Good: upload device A history, restore preferences on device B, and receive the same counts and timestamps.
- Base: restore a pre-feature snapshot without `cliArgsHistory`; device B keeps its local history.
- Bad: add remote and local counts together on every restore, causing repeated restores to inflate usage.

### 6. Tests Required

- Unit: `SETTING_BACKUP_POLICY.cliArgsHistory` is `preferences` and `pickSyncableSettings` includes the field.
- Unit: malformed and duplicate persisted entries normalize deterministically.
- Type check: the exhaustive policy still covers every `Settings` key.

### 7. Wrong vs Correct

```ts
// Wrong: history never reaches preference snapshots.
cliArgsHistory: "excluded"

// Correct: history follows the existing whole-field preference snapshot semantics.
cliArgsHistory: "preferences"
```
