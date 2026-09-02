# App Data Persistence Contracts

## Scenario: Windows portable and configurable data root

### 1. Scope / Trigger

- Trigger: changing `app_paths`, startup data-root selection, data-directory settings IPC, directory migration, Hook/daemon paths, or Windows portable packaging.
- Goal: every CLI-Manager-owned file that previously lived under `%USERPROFILE%\\.cli-manager` follows one startup-resolved root without affecting `.claude`, `.codex`, WSL, SSH hosts, or project files.

### 2. Signatures

```rust
app_get_data_paths() -> Result<CliManagerDataPaths, String>
app_get_data_storage_status() -> Result<DataStorageStatus, String>
app_inspect_data_dir(target_dir: String) -> Result<DataStorageInspection, String>
app_prepare_data_dir_switch(
    target_mode: String,
    target_dir: Option<String>,
    migrate: bool,
) -> Result<String, String>
```

- `DataStorageStatus`: `supported`, `distribution`, `mode`, `currentDataDir`, `defaultDataDir`, `bootstrapPath`, `lastError`.
- `DataStorageInspection`: `targetDir`, `exists`, `empty`, `writable`, `sameAsCurrent`.
- `targetMode`: `custom | default`; `targetDir` is required only for `custom`.

### 3. Contracts

- Distribution priority is `CLI_MANAGER_DISTRIBUTION=aur` -> Windows executable-adjacent `portable.flag` -> `standalone`.
- Windows defaults:
  - standalone: `%USERPROFILE%\\.cli-manager`;
  - portable: `<exe-dir>\\data`.
- Bootstrap pointers never live inside the redirected data root:
  - standalone: `%LOCALAPPDATA%\\com.cli-manager.app\\data-root.json`;
  - portable: `<exe-dir>\\data-root.json`.
- A custom directory is the data root itself; never append `.cli-manager` or `data`.
- `app_get_data_paths` keeps its existing response fields and dev/install file-name isolation. All consumers obtain the selected root through `cli_manager_data_dir()`.
- A prepared switch is pending until the next normal GUI startup. Hook, statusline, and daemon helper entrypoints read only the active root and never execute migration.
- Automatic migration copies the complete source tree into a target-sibling temporary directory, rejects links/reparse points, and activates it with rename only after the copy succeeds. The source is retained for recovery.
- Automatic migration is allowed only when the target is empty. Direct use may select an existing non-empty directory but never merges or overwrites it.
- Windows path canonicalization may produce a `\\?\\` verbatim prefix; normalize it back to a regular drive or UNC path before serializing `dbUrl`, otherwise SQLx treats `?` as the start of query parameters.
- Hook diagnostics use `app_paths::logs_dir()`. Managed desktop-pet assets are scoped dynamically to `<data-root>/pets`; `$HOME/.codex/pets` remains external and unchanged.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Relative path, `..`, or drive/share root | Reject before writing Bootstrap state. |
| Target is a file, symlink, or Windows reparse point | Reject explicitly. |
| Source and target are equal or one contains the other | Reject with `data_storage_target_is_current` / `data_storage_source_target_overlap`. |
| Target or nearest existing parent is not writable | Reject with `data_storage_target_not_writable`. |
| `migrate=true` and target is non-empty | Reject with `data_storage_target_not_empty`; do not merge. |
| Copy or activation fails | Keep the previous `customDataDir`, clear pending state, and persist `lastError`. |
| Explicit active custom root is unavailable at GUI startup | Stop before logs/SQLite/Store initialization and show a startup error; never silently fall back. |
| Alive daemon session exists | Reject switch with `data_storage_tasks_active`; never terminate it automatically. |

### 5. Good/Base/Bad Cases

- Good: copying the portable folder with `data/` to another drive resolves the new executable-adjacent data directory and keeps all app state.
- Good: migrating to an empty custom directory copies `cli-manager.db`, WAL/SHM, Store files, logs, cache, attachments, backups, providers, pets, and unknown future subdirectories.
- Base: an installed build without Bootstrap configuration still resolves `%USERPROFILE%\\.cli-manager`.
- Bad: storing the selected root in `settings.json`; that file cannot locate itself before the root is known.
- Bad: copying directly into the final target or merging a non-empty directory.

### 6. Tests Required

- Rust tests for distribution precedence and portable/standalone default paths.
- Rust tests for Bootstrap path placement and previous-root retention after pending-switch failure.
- Rust tests for complete-tree migration, non-empty target rejection, and parent/child overlap rejection.
- Windows tests must cover verbatim drive/UNC prefix stripping and parsing the resulting absolute path as a SQLite URL.
- `cargo test --manifest-path src-tauri/Cargo.toml app_paths --lib` and `cargo check` after backend changes.
- `npx tsc --noEmit` after changing storage IPC/UI types.
- Portable ZIP inspection must assert `cli-manager.exe`, `cli-manager-codex-proxy.exe`, `portable.flag`, and `resources/` exist under the archive root.

### 7. Wrong vs Correct

#### Wrong

```rust
pub fn cli_manager_data_dir() -> PathBuf {
    home_dir().join(".cli-manager")
}
```

#### Correct

```rust
pub fn cli_manager_data_dir() -> Result<PathBuf, String> {
    DATA_ROOT.get_or_init(resolve_active_data_dir).clone()
}
```

## Scenario: Stable user data survives update

### 1. Scope / Trigger

- Trigger: changing CLI-Manager app data paths, store files, startup legacy migration, or SQLite recovery behavior.
- Goal: app updates, repair installs, and quick relaunches must not reset user projects, settings, sessions, or sync configuration.

### 2. Signatures

- Backend data path command: `app_get_data_paths() -> Result<CliManagerDataPaths, String>`.
- Backend startup migration: `migrate_legacy_app_files(app: &AppHandle<R>) -> Result<(), String>`.
- Backend DB repair command: `db_repair_known_migration_drift(app: AppHandle) -> Result<DbMigrationRepairResult, String>`.
- Default installed data directory: `<home>/.cli-manager`; Windows portable default: `<exe-dir>/data`; an explicit custom root replaces either default.
- Stable store files: `settings.json`, production `sessions.json`, development `sessions.dev.json`, `sync-config.json`, `external-session-sync.json`.
- Stable SQLite DB: `cli-manager.db`.
- History index cache: production `history-cache`, development `history-cache-dev`.

### 3. Contracts

- All durable CLI-Manager user data must resolve under the startup-selected data root, not versioned or identifier-dependent Tauri data folders.
- `app_get_data_paths().sessionsStorePath` must use `sessions.dev.json` under Tauri `cfg(dev)` and `sessions.json` otherwise. Other stores remain shared unless another contract explicitly isolates them.
- History index caches must use `history-cache-dev` under Tauri `cfg(dev)` and `history-cache` otherwise, so installed and development apps can run concurrently without competing over catalog activation/index runs.
- Legacy store migration continues to migrate `sessions.json` as production user data. It must not copy production or legacy sessions into `sessions.dev.json`.
- Store migration from legacy Tauri app data must be non-destructive:
  - copy the legacy store file when the target file is missing;
  - merge only missing top-level JSON object keys when the target file already exists;
  - never overwrite an existing target key;
  - backup the target file before writing a merged target.
- Sync store migration must ignore removed legacy keys `webdavPassword` and `hasPassword` both when copying and merging, because WebDAV passwords now live in the OS credential store. These keys must not cause repeated `sync-config.json.backup-*` creation on every startup.
- Legacy SQLite DB recovery may copy the legacy DB family only when the legacy DB has user rows and the current DB has no user rows.
- SQLite DB family operations must include `cli-manager.db`, `cli-manager.db-wal`, and `cli-manager.db-shm`.
- Current DB user data always wins over legacy DB user data.
- `db_repair_known_migration_drift` runs before the frontend SQL plugin opens the database. For
  known additive columns such as `ssh_hosts.attachment_root`, it repairs the physical column and
  the `_sqlx_migrations` marker independently, so either side may be missing without causing a
  later `no such column` or duplicate-`ADD COLUMN` failure.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Legacy store missing | No-op. |
| Target store missing | Copy legacy store to `.cli-manager`. |
| `cfg(dev)` runtime | Return `.cli-manager/sessions.dev.json`; do not read or modify production `sessions.json`. |
| `cfg(dev)` and installed runtimes run together | Use separate history catalog directories; neither runtime may activate/deactivate the other's source instances. |
| Installed runtime | Return `.cli-manager/sessions.json`; ignore `sessions.dev.json`. |
| Both stores are JSON objects | Add only keys missing from target. |
| Legacy `sync-config.json` only has removed password keys missing from target | No-op; do not backup target. |
| Either store is non-object or invalid JSON | Skip merge; do not corrupt target. |
| Target store has existing key | Keep target value. |
| Legacy DB has rows and current DB has none | Backup current DB family, copy legacy DB family. |
| Current DB has any user rows | Do not copy legacy DB. |
| Recovery fails | Log warning and continue normal migration repair. |
| `ssh_hosts.attachment_root` is missing while migration 37 is registered | Add the column before `Database.load`; do not insert a duplicate marker. |
| `ssh_hosts.attachment_root` exists while migration 37 is missing | Register migration 37 with the exact SQL checksum; do not replay `ALTER TABLE`. |
| Both the column and migration 37 are missing | Add the column and register migration 37 in one short transaction; rollback both on failure. |

### 5. Good/Base/Bad Cases

- Good: after update, a customized `settings.json` keeps existing values and receives only newly missing legacy keys.
- Good: running `tauri dev` creates/loads `sessions.dev.json` while an installed app continues using `sessions.json`.
- Base: clean install has no legacy files and starts with normal defaults.
- Bad: using `debug_assertions` or a frontend-only check as the environment boundary; Tauri `cfg(dev)` is the authoritative dev/install distinction.
- Bad: copying a whole legacy `settings.json` over a newer target file.
- Bad: replacing a current DB that already contains user projects or templates.

### 6. Tests Required

- Rust unit tests for missing-store copy, JSON object merge, and unchanged target when legacy has no new keys.
- Rust unit test for development/installed session store file-name selection.
- Rust unit test for development/installed history cache directory selection.
- Rust unit tests for legacy DB recovery when current DB has no user rows and rejection when current DB has user rows.
- Rust unit tests for additive-column drift with the column missing, the marker missing, both missing,
  and a second idempotent repair; the assertion must inspect both `PRAGMA table_info` and
  `_sqlx_migrations`.
- `cargo check` after backend path or DB repair changes.
- `cargo test --lib` or focused `cargo test app_paths db_repair --lib` after persistence migration changes.
- `npx tsc --noEmit` after changing frontend path payloads or store consumers.

### 7. Wrong vs Correct

#### Wrong

```rust
copy_if_missing(&old_store_dir.join("settings.json"), &data_dir.join("settings.json"))?;
```

This misses new legacy keys when an empty target file already exists, and a full overwrite would be unsafe.

#### Correct

```rust
migrate_store_file(&old_store_dir.join("settings.json"), &data_dir.join("settings.json"))?;
```

The migration copies missing files and otherwise merges only missing JSON object keys.

## Scenario: Terminal clipboard image attachments

### 1. Scope / Trigger

- Trigger: changing terminal clipboard-image persistence, attachment cleanup, or the `file_attach_data` IPC contract.
- Goal: all local terminal sessions use one app-managed attachment directory without writing `.cli-manager` folders into user projects.

### 2. Signatures

```rust
file_attach_data(file_name: String, data_base64: String) -> Result<String, String>
file_cleanup_expired_attachments() -> Result<u64, String>
```

- Stable attachment directory: `<home>/.cli-manager/attachments`.
- `file_attach_data` returns the generated file's absolute native path.

### 3. Contracts

- Resolve the attachment root through `app_paths::cli_manager_data_dir()`; do not accept a project path or terminal cwd from the WebView.
- Keep attachment file-name sanitization, collision suffixes, the 5 MiB decoded-data limit, and the 2-day retention period in Rust.
- The frontend passes only `fileName` and `dataBase64`, then applies the existing shell-specific quoting to the returned absolute path.
- Attachment cleanup targets the same global directory and runs at most once per frontend process unless a cleanup attempt fails.
- Existing project-scoped `.cli-manager/attachments` directories are not migrated or deleted automatically.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Home directory cannot be resolved | Return `home_dir_unavailable`. |
| Base64 is invalid | Return `decode_failed: ...`. |
| Decoded data is empty | Return `attachment_empty`. |
| Decoded data exceeds 5 MiB | Return `attachment_too_large`. |
| Data or attachment directory is a symlink/reparse point or not a directory | Return `path_is_symlink` / `path_not_directory`. |
| Sanitized name already exists | Add a numeric suffix without overwriting the existing file. |
| Attachment directory does not exist during cleanup | Return `0`. |

### 5. Good/Base/Bad Cases

- Good: pasting an image in any project writes `<home>/.cli-manager/attachments/clipboard-*.png` and returns that absolute path.
- Base: a terminal without a project or cwd can still paste a clipboard image.
- Good: cleanup skips directories, symlinks, and files newer than 2 days.
- Bad: accepting `rootPath` from the frontend and recreating `<project>/.cli-manager/attachments`.
- Bad: returning a project-relative path that the frontend must join with project or session state.

### 6. Tests Required

- Rust unit test asserts the attachment directory is exactly `<data_dir>/attachments`, with no nested `.cli-manager` segment.
- Rust tests preserve attachment name sanitization, collision handling, decoded-size limits, and cleanup retention behavior when those helpers change.
- Run `cargo check` after changing the Rust IPC contract.
- Run `npx tsc --noEmit` after changing the frontend invoke payload or returned-path handling.

### 7. Wrong vs Correct

#### Wrong

```typescript
await invoke("file_attach_data", { rootPath: project.path, fileName, dataBase64 });
```

This leaks project/session state into an app-owned persistence decision and creates metadata folders in user projects.

#### Correct

```typescript
const absolutePath = await invoke<string>("file_attach_data", { fileName, dataBase64 });
```

Rust owns the stable app-data path and returns the complete path required by the terminal.
