# History List and Search Index Contracts

## Scenario: Cached history list and full-text search

### 1. Scope / Trigger

- Trigger: changing history list loading, global search, history root discovery, or JSONL cache invalidation.
- Goal: list/search requests must not synchronously parse every Claude/Codex transcript.

### 2. Signatures

- Existing commands remain compatible: `history_list_sessions(...) -> Vec<HistorySessionSummary>` and `history_search(...) -> Vec<HistorySearchResult>`.
- Index commands: `history_get_index_status(...) -> HistoryIndexStatus` and `history_refresh_index(..., wait) -> HistoryIndexStatus`.
- Event: `history-index-status` with `rootsKey`, `phase`, `indexedFiles`, `totalFiles`, `generation`, `partial`, `lastCompletedAt`, and `error`.
- Derived cache: installed `.cli-manager/history-cache/history-catalog.db`; Tauri dev `.cli-manager/history-cache-dev/history-catalog.db`.

### 3. Contracts

- The catalog DB is derived and rebuildable; never store it in `cli-manager.db` or treat it as user-authored data.
- List requests query cached summaries first and schedule fingerprint-based background refresh.
- A realtime lookup scoped to `source=grok`, an exact UUID session ID, `limit=1`, and `offset=0` may bypass a catalog miss by checking only `<grok-root>/sessions/<workspace>/<session-id>/updates.jsonl`; it must validate the UUID before joining paths and still honor the optional project path.
- Realtime forced refresh uses `history_refresh_index(..., wait=false)`. A large derived catalog rebuild must never hold the panel's single-flight polling request; later polls consume the direct Grok result or refreshed catalog.
- Opening history must schedule the same TTL-governed refresh even when the frontend reuses its in-memory list.
- Search requires at least three Unicode characters and uses FTS5 trigram literal matching; user text must be quoted/escaped before `MATCH`.
- First indexing is recent-first and partial results remain usable. A ready generation change reloads the list and current search.
- Project filtering uses indexed normalized `cwd` plus Claude encoded project keys; it must not reopen every JSONL in the request path.
- Editing/deleting/converting history marks the catalog dirty. Refresh replaces only changed files and removes missing files.
- WSL history inventory continues to use `wsl.exe` discovery rather than native recursive UNC enumeration.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Query has fewer than 3 characters | Return no global hits; frontend shows the minimum-length hint. |
| Catalog is empty but legacy JSON cache exists | Seed summary rows, return the cached list, then build message FTS in background. |
| File fingerprint is unchanged | Reuse catalog rows without parsing the transcript. |
| File changed or parser version changed | Atomically replace that file's summary/message/FTS rows. |
| File disappeared | Delete its message and summary rows. |
| Catalog refresh fails | Keep previous rows and emit `phase=error`; never delete source JSONL. |
| Catalog DB is malformed | Recreate only the derived catalog and rebuild. |
| Exact Grok UUID is absent from catalog but exists on disk | Return that session directly without scanning every transcript or falling back to the project's latest session. |

### 5. Good/Base/Bad Cases

- Good: opening history with thousands of files returns cached rows before the background scan completes.
- Good: typing a three-character code fragment queries FTS without reading transcript files.
- Base: the first install has no legacy cache, so progress and partial results appear until indexing completes.
- Bad: calling `refresh_history_index()` or `iter_session_messages_filtered()` for every keystroke.
- Bad: storing the FTS cache in the main user database or clearing usable rows after a transient scan error.

### 6. Tests Required

- Rust: FTS schema/triggers support Chinese and ASCII trigram matches; literal quoting handles embedded quotes.
- Rust: unchanged fingerprints skip parsing; changed and deleted files update only their own rows.
- Rust: project/source filters and pagination preserve existing command behavior.
- Rust: exact Grok UUID lookup finds the matching workspace session, rejects a different project path, and rejects non-UUID traversal input.
- Frontend: stale searches cannot overwrite the newest query; one/two-character input does not invoke search.
- Run `cargo test history --lib`, `cargo check`, and `npx tsc --noEmit`.

### 7. Wrong vs Correct

#### Wrong

```rust
for entry in refresh_history_index(&roots) {
    iter_session_messages_filtered(&entry.file_ref.path, &query, collect_hit)?;
}
```

#### Correct

```rust
let hits = catalog::search_sessions(&roots, &query, source, project_path, limit).await?;
catalog::ensure_refresh(app, roots, false, false).await?;
```

## Scenario: Catalog Schema Compatibility Upgrade

### 1. Scope / Trigger

- Trigger: adding columns, indexes, triggers, or constraints to the rebuildable `history-catalog.db` schema.
- Goal: installed catalogs must upgrade in place without requiring users to delete cache files.

### 2. Signatures

- Schema entry point: `ensure_schema(conn: &mut SqliteConnection) -> Result<(), String>`.
- V2 schema upgrade: `ensure_v2_schema(conn: &mut SqliteConnection) -> Result<(), String>`.
- Compatibility helper: `ensure_column(conn, table, column, definition) -> Result<(), String>`.
- `PRAGMA user_version` is written only after all table, column, index, and metadata updates succeed.

### 3. Contracts

- Compatibility columns must be ensured before creating any index, trigger, constraint, or query that references them.
- Fresh database creation and legacy upgrade must converge on the same final schema and indexes.
- Compatible upgrades preserve catalog rows. Destructive recreation remains limited to malformed or non-database files.
- Schema initialization is idempotent; reopening an upgraded catalog must not rewrite or reject its schema.
- Catalog opens must serialize schema initialization inside the process so compatibility `PRAGMA table_info` and `ALTER TABLE` steps cannot race across connections.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Catalog file does not exist | Create the complete current schema. |
| Older table lacks a newly required column | Add the column with its compatibility default before dependent DDL runs. |
| Older index conflicts with the replacement index | Drop the obsolete index after columns exist, then create the replacement. |
| Catalog already has the current `user_version` | Return through the fast path without schema writes. |
| Compatible upgrade statement fails | Return the error and do not advance `user_version`. |
| Two connections first-open the same legacy catalog | Both opens succeed; only one compatibility upgrade runs at a time. |

### 5. Good/Base/Bad Cases

- Good: an existing active source row gains `scope_kind=configured` and `scope_key=desktop`, then participates in the scoped unique index.
- Base: a fresh catalog creates the new columns with the table and later creates the same index idempotently.
- Bad: place `CREATE INDEX ... scope_kind` in the initial statement list before `ensure_column(..., "scope_kind", ...)`.

### 6. Tests Required

- Build the previous-version source table and obsolete index in memory, set the old `user_version`, insert an active row, then call `ensure_schema`.
- Assert the existing row survives with compatibility defaults, the replacement index exists and enforces uniqueness, and a second `ensure_schema` call succeeds.
- Open one legacy catalog concurrently through two connections and assert both opens complete with the current schema version.
- Force a metadata write failure and assert `user_version` remains at the previous version.
- Keep fresh-schema tests and the focused `cargo test history --lib` suite passing.

### 7. Wrong vs Correct

#### Wrong

```rust
create_scoped_index(conn).await?;
ensure_column(conn, "history_source_instances", "scope_kind", definition).await?;
```

#### Correct

```rust
ensure_column(conn, "history_source_instances", "scope_kind", definition).await?;
create_scoped_index(conn).await?;
```

## Scenario: Scoped SSH Remote History

### 1. Scope / Trigger

- Trigger: changing SSH Agent history discovery/parsing, remote bridge history RPCs, catalog sync, or remote list/search/detail routing.
- Goal: expose project-scoped remote Claude/Codex history without copying the remote history tree or treating POSIX paths as desktop-local paths.

### 2. Signatures

- `history_remote_sync(...) -> Result<Value, String>` returns the Agent sync payload plus `applied: boolean`.
- `catalog::apply_remote_sync(host_id, result) -> Result<bool, String>` returns `false` only when persisted generation/cursor state is newer.
- Frontend `requestRemoteHistorySync(context, options) -> Promise<SshRemoteHistorySyncResult>` owns keyed in-flight request reuse and integration metadata persistence.

### 3. Contracts

- Remote `sourceInstanceId` is stable for `(remoteMachineId, sshUser, source, canonicalConfigRootHash)` and does not include `hostId`, project ID, client ID, or replaceable Agent installation ID.
- The Agent owns one rebuildable index per `(source, configRootHash)`. Writers use an Agent-side cross-process lock whose directory, permissions, and owner record are acquired transactionally; readers reuse the published generation.
- JSONL indexing is append-aware and handles truncate, same-size rewrite, rotation, partial tails, tombstones, and project-scope expansion. A record larger than the 8 MiB read window is skipped with bounded cursor progress until its newline.
- Agent cursors are `generation:offset`. A generation mismatch resets pagination to offset zero; desktop fetches 21 summaries to display 20 and requests the next Agent page only from load-more.
- Desktop callers with identical host/source/root/project/cursor/limit inputs share one in-flight sync request, including the local integration metadata write. Different sources and cursor pages remain independent.
- Catalog apply obtains SQLite's short writer lease inside the transaction, then compares the persisted source generation and cursor offset. Lower generations and lower offsets in the same generation are ignored and reported as not applied; they must not replace session rows, source state, cursor, or frontend context.
- Remote catalog coordination must not reuse the full local refresh mutex or add a process-wide SSH synchronization mutex. WAL reads remain concurrent; SQLite serializes only the actual write transaction.
- The existing `history-catalog.db` stores remote summaries, usage facts, freshness, cursor, and identity. Summary materialization must remove persisted messages, tool events, file changes, and corresponding FTS rows.
- Full remote detail is online-only and lives in a bounded in-memory LRU. Offline behavior guarantees cached list/summary/usage only, with explicit stale/disconnected state.
- Protocol minor 3 advertises `historyDetailChunks`: payload chunks are at most 256 KiB inside the existing 1 MiB frame, aggregate detail is at most 64 MiB, and desktop validates request ID, order, total, size, and one end-to-end deadline.
- Remote history is read-only. Remote refs and paths never enter local/WSL file, Git, provider, edit, delete, snapshot, or resume APIs.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Cursor is not `generation:offset` or its generation differs from the result | `history_remote_cursor_invalid`; no catalog write |
| Incoming generation is lower than persisted generation | return `applied=false`; preserve catalog and frontend context |
| Incoming generation is equal and cursor offset is lower | return `applied=false`; preserve catalog and frontend context |
| Incoming generation is newer or same-generation offset advances | apply the complete summary transaction and return `applied=true` |
| Two callers use identical request inputs | share one remote RPC and one integration metadata write |

### 5. Good / Base / Bad Cases

- Good: a stats poll and history refresh request the same first page concurrently and share one Promise.
- Good: page offset 20 commits before an older offset 10 response; offset 10 is ignored without blocking readers or another source.
- Base: equal generation and equal cursor replay is idempotent and may reapply safely.
- Bad: guard all remote sources with `CATALOG_REFRESH_LOCK` or let an old response update `sync_cursor_json` after a new response.

### 6. Tests Required

- Agent: append/partial/truncate/rewrite, project scope, tombstones, stable identity, lock cleanup/recovery, oversized-record progress, cursor reset, and full history suite.
- Desktop: strict remote identity/continuation validation, numeric overflow, summary-only cleanup, pagination, stale generation/cursor rejection, detail chunk validation/deadline, LRU eviction, bridge consumer lifetime, and catalog tests.
- Frontend: TypeScript check plus manual rapid project/filter switching to confirm stale list/search/detail requests cannot replace the current SSH context.

### 7. Wrong vs Correct

#### Wrong

```rust
sync_cursor_json = excluded.sync_cursor_json;
generation = excluded.generation;
```

#### Correct

Obtain SQLite's writer lease, compare persisted generation/cursor inside that transaction, and return `applied=false` before any source/session mutation when the response is stale.
