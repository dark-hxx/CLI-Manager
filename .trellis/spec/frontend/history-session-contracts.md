# History Session Contracts

## Scenario: Favorite Session Snapshots

### 1. Scope / Trigger

- Trigger: changing history session favorites, session metadata storage, or behavior when original Claude/Codex history JSONL files are missing.

### 2. Signatures

- SQLite table: `session_meta`
  - `session_key TEXT PRIMARY KEY`
  - `starred INTEGER NOT NULL DEFAULT 0`
  - `alias TEXT NOT NULL DEFAULT ''`
  - `tags_json TEXT NOT NULL DEFAULT '[]'`
- SQLite table: `session_favorite_snapshots`
  - `session_key TEXT PRIMARY KEY`
  - `source TEXT NOT NULL`
  - `session_id TEXT NOT NULL`
  - `project_key TEXT NOT NULL`
  - `file_path TEXT NOT NULL`
  - `detail_json TEXT NOT NULL`
- Store action: `historyStore.updateMeta(sessionKey, { starred })`
- Backend detail command still remains the source-of-truth read path while the JSONL exists: `history_get_session`.

### 3. Contracts

- `session_meta.starred` is the favorite flag used for sorting and UI state.
- `session_favorite_snapshots.detail_json` stores a normalized `HistorySessionDetail` snapshot taken when the user favorites a session.
- Favoriting a session must save both the metadata flag and the snapshot.
- Unfavoriting a session must remove the snapshot.
- The history list should prefer live scanned JSONL sessions, then add favorite snapshots only for sessions missing from the scanned result.
- Opening a session should prefer `history_get_session`; if that fails and a favorite snapshot exists, the UI may show the snapshot as read-only historical content.

### 4. Validation & Error Matrix

- Source JSONL exists -> load via backend and ignore snapshot for freshness.
- Source JSONL missing + favorite snapshot exists -> show snapshot.
- Source JSONL missing + no snapshot -> keep existing backend error behavior.
- Snapshot JSON is malformed -> log a warning and do not show that snapshot.
- Project/source filter is active -> include only snapshots matching the same source and project filter.

### 5. Good/Base/Bad Cases

- Good: user favorites a session, deletes the original JSONL, reopens history, and can still open the saved transcript.
- Base: source JSONL still exists; live backend parsing is used and the snapshot is only a fallback.
- Bad: favorite stores only `session_meta.starred`, because deleted JSONL files make the favorite invisible.
- Bad: snapshot rows are shown without checking `session_meta.starred`, because canceled favorites would come back.

### 6. Tests Required

- Run `npx tsc --noEmit` after frontend store/type changes.
- Run `cd src-tauri && cargo check` after adding or changing migrations.
- Manual desktop check:
  - Favorite one Claude or Codex history session.
  - Confirm it remains listed after the original history JSONL is moved away.
  - Open it and verify the saved transcript appears.
  - Cancel favorite and verify the snapshot item disappears.

### 7. Wrong vs Correct

#### Wrong

```typescript
await db.execute("UPDATE session_meta SET starred = 1 WHERE session_key = $1", [sessionKey]);
```

#### Correct

```typescript
await updateMeta(sessionKey, { starred: true });
// updateMeta writes session_meta and session_favorite_snapshots together.
```
