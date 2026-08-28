# Technical Design

## Boundaries and data flow

`HistoryListPane` / `SessionDetailPane` → `HistoryWorkspace` callbacks → `historyStore` → Tauri history commands → source JSONL and rebuildable V2 catalog. The source JSONL remains authoritative; catalog rows are only a cache.

## Freshness design

* Add a catalog freshness guard for local V2 detail reads: compare the indexed file-stat fingerprint with the current primary file before rehydrating messages. A mismatch or missing primary file must skip the stale V2 row and use the existing validated live path (or surface the existing missing-file error).
* Ensure dirty catalog state is synchronously consumed by the next local list/detail request, while retaining the existing TTL fast path for clean reads. The refresh must continue to emit the normal generation event and remove rows for deleted files.
* Keep command payloads source-compatible; `AppHandle` may be injected by Tauri for refresh orchestration and is not a frontend argument.

## Selection design

* Preserve the existing session-list selection mode and parent→child selection behavior.
* Preserve the existing message selection mode and ensure its toolbar remains reachable for local editable details. Transcript remains the authoritative selection surface; Conversation actions may switch to Transcript but must not introduce a second mutation path.
* Clear selected keys/indices after successful batch deletion or session deletion, and never expose mutation controls for SSH/snapshot/read-only details.

## Failure and compatibility

* Fingerprint parsing is strict; malformed catalog metadata is treated as stale and falls back to live parsing rather than trusting old content.
* Existing line-index/role/text and source-running guards remain unchanged. Conflicts still reload the detail and propagate the localized error.
* No changes to remote history mutation or source-specific deletion protocols.

## Test strategy

* Rust unit tests for fingerprint freshness (matching, changed, malformed, deleted file) and catalog read fallback behavior.
* Node source regression tests asserting both selection entry points/guards and refresh-after-mutation paths.
* Existing history parser/edit tests plus TypeScript and Rust quality gates.
