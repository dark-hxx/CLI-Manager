# Fix Legacy History Catalog Schema Upgrade

## Goal

Eliminate the SQLite locking and legacy-schema failures reported during history refresh, WebDAV restore, SSH persistence, and SSH remote-history synchronization while preserving atomic rollback, concurrency, and existing user data.

## Changelog Target

`V1.3.1`

## Background

- `ensure_v2_schema` creates `idx_history_source_instances_active_scope` before its compatibility loop adds `scope_kind` and `scope_key` to an existing `history_source_instances` table.
- SQLite rejects that index statement on an old table, so schema initialization exits before `ensure_column` can repair the table.
- The catalog is derived cache data under `.cli-manager/history-cache`; source Claude/Codex transcripts are not damaged.
- Every history catalog connection runs schema initialization independently; concurrent first opens can race the check-then-`ALTER TABLE` compatibility flow.
- WebDAV restore currently sends `BEGIN IMMEDIATE`, each mutation, and `COMMIT` as separate tauri-plugin-sql IPC calls. The plugin executes against a SQLx pool, so those calls are not guaranteed to use the same SQLite connection and can lock against their own open transaction.

## Root-Cause Statement

- History: the bug lives in the catalog open/schema-upgrade boundary because concurrent connections execute non-atomic compatibility DDL and dependent indexes before columns exist; schema initialization must be serialized and ordered at that boundary.
- WebDAV: the bug lives at the frontend/plugin transaction boundary because transaction control and statements cross pooled IPC calls without connection affinity; database-domain restore must execute on one backend connection and transaction.
- SSH persistence: host import/delete, group delete, preferences, and Hook integration writes repeat the same pooled-IPC transaction mistake or perform dependent statements without a transaction.
- SSH remote history: polling, history refresh, and pagination can overlap for one source; catalog apply accepts older generation/cursor responses and can regress source state after a newer response commits.

## Requirements

- Create the scoped unique index only after all required legacy columns have been ensured.
- Preserve fresh-database behavior and the existing scoped uniqueness contract.
- Preserve existing catalog rows during a compatible legacy upgrade; do not delete the catalog or source transcripts.
- Add a regression test that starts from the pre-scope `history_source_instances` schema and verifies automatic upgrade.
- Serialize history schema initialization across all catalog opens.
- Advance history `user_version` only after metadata writes succeed.
- Execute workspace/model-price restore through one Rust-owned SQLite transaction with a busy timeout.
- Restrict restore statements to the five owned database tables and supported `DELETE`/`INSERT` operations.
- Keep safety rollback, local import, legacy cloud import, explicit undo, and selected-domain behavior unchanged.
- Add backend tests for successful database restore, invalid statement rejection, and atomic rollback.
- Keep Tauri command signatures and frontend behavior unchanged.
- Move SSH combination writes to explicit Rust commands using one connection and short transactions; do not add a global CRUD mutex.
- Serialize only the first SSH group schema compatibility repair and keep subsequent checks on a fast path.
- Coalesce identical remote-history requests and reject lower generation or same-generation lower cursor responses at the catalog transaction boundary.
- Keep different hosts, sources, pagination requests, and all catalog readers independent.

## Discovery List

- `src-tauri/src/commands/history/catalog.rs::ensure_v2_schema`: root cause and repair location.
- `src-tauri/src/commands/history/catalog.rs::ensure_column`: existing idempotent column-upgrade mechanism, reused unchanged.
- `src-tauri/src/commands/history/catalog.rs::ensure_schema`: schema entry point that delegates V2 upgrades to `ensure_v2_schema`.
- `src-tauri/src/commands/history/catalog.rs::open_catalog_once`: sole production caller of `ensure_schema`; all catalog operations benefit from the repair.
- History refresh/list/search callers: affected transitively through catalog open; no signature or call-site changes required.
- `src-tauri/src/lib.rs` application SQLite migrations: confirmed unrelated; `scope_kind` failure is in derived `history-catalog.db`, not `cli-manager.db`.
- Frontend refresh button/store: confirmed unrelated; it only surfaces the backend schema error.
- `src/stores/syncStore.ts::applySnapshot`: WebDAV/local/legacy/undo restore entry point and pooled transaction misuse.
- `src/lib/db.ts::batchInsert`: only used by `syncStore`; statement construction can be reused without changing other stores.
- `src-tauri/src/commands/sync.rs`: existing backup command boundary; owns the new single-connection database restore transaction.
- `src-tauri/src/lib.rs`: additive Tauri command registration only.
- `src/stores/sshHostStore.ts` and `src/stores/sshAgentIntegrationStore.ts`: pooled transaction misuse and non-atomic group deletion.
- `src-tauri/src/commands/ssh_db.rs`: explicit single-connection SSH schema and mutation boundary.
- `src/stores/historyStore.ts::syncRemoteHistoryContext`: identical remote request coalescing and stale-result context guard.
- `src-tauri/src/commands/history/catalog.rs::apply_remote_sync_with_conn`: transactional generation/cursor monotonicity boundary.

## Acceptance Criteria

- [x] A fresh in-memory catalog initializes successfully with schema version 3.
- [x] A catalog containing the legacy `history_source_instances` table upgrades without error.
- [x] Upgraded rows receive compatible defaults for the newly required columns.
- [x] `idx_history_source_instances_active_scope` exists after upgrade and enforces active-scope uniqueness.
- [x] Re-running schema initialization is idempotent.
- [x] Focused Rust history tests and `cargo check` pass.
- [x] `CHANGELOG.md` documents the fix under `V1.3.1`.
- [x] Two concurrent first opens of one legacy history catalog both complete successfully.
- [x] History `user_version` advances only after schema metadata succeeds.
- [x] WebDAV database domains restore atomically on one backend connection.
- [x] A failed restore statement rolls back all database-domain mutations.
- [x] Restore no longer issues frontend `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` calls.
- [x] SSH Stores no longer issue frontend transaction control statements.
- [x] SSH host/group/preferences/Hook combination writes roll back atomically on failure.
- [x] SSH schema compatibility repair is single-flight without serializing normal CRUD.
- [x] Identical SSH remote-history requests share one in-flight request and metadata write.
- [x] Older remote generation/cursor responses cannot overwrite newer catalog or frontend context.

## Out Of Scope

- Adding a manual reset-index button or automatic destructive catalog deletion.
- Changing history source discovery, parsing, or search semantics.
- Modifying the primary `cli-manager.db` schema.
- Adding a process-wide mutex around ordinary SSH or history operations.
