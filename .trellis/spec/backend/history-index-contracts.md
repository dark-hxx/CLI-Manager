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
