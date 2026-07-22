# App Data Persistence Contracts

## Scenario: Stable user data survives update

### 1. Scope / Trigger

- Trigger: changing CLI-Manager app data paths, store files, startup legacy migration, or SQLite recovery behavior.
- Goal: app updates, repair installs, and quick relaunches must not reset user projects, settings, sessions, or sync configuration.

### 2. Signatures

- Backend data path command: `app_get_data_paths() -> Result<CliManagerDataPaths, String>`.
- Backend startup migration: `migrate_legacy_app_files(app: &AppHandle<R>) -> Result<(), String>`.
- Backend DB repair command: `db_repair_known_migration_drift(app: AppHandle) -> Result<DbMigrationRepairResult, String>`.
- Stable data directory: `<home>/.cli-manager`.
- Stable store files: `settings.json`, production `sessions.json`, development `sessions.dev.json`, `sync-config.json`, `external-session-sync.json`.
- Stable SQLite DB: `cli-manager.db`.
- Stable machine identity: `machine-id`; installed Web profile: `web-device.json`; development Web profile: `web-device.dev.json`.
- History index cache: production `history-cache`, development `history-cache-dev`.

### 3. Contracts

- All durable CLI-Manager user data must resolve under `.cli-manager`, not versioned or identifier-dependent Tauri data folders.
- `app_get_data_paths().sessionsStorePath` must use `sessions.dev.json` under Tauri `cfg(dev)` and `sessions.json` otherwise. Other stores remain shared unless another contract explicitly isolates them.
- History index caches must use `history-cache-dev` under Tauri `cfg(dev)` and `history-cache` otherwise, so installed and development apps can run concurrently without competing over catalog activation/index runs.
- Installed and development Web bridges must use separate profile files and software `clientId` values. They share only `machine-id`, so both builds can run concurrently without replacing each other's WebSocket generation, pairing token, or workspace snapshot.
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
