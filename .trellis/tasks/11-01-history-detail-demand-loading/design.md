# Design gate

Discovery: history/catalog/session_detail.rs, history command API, SessionDetailPane, replay progress model, search navigation/edit/favorites/resume consumers and remote history adapters. Read owning history contracts and run upstream impact before changing the response shape.

Separate session metadata, message pages/anchors and heavy tool/diff payloads. Cursor/anchor identities must survive page eviction and refresh; do not use a visible-page array index as a persisted message ID. Keep legacy callers on a deliberate adapter until every consumer is migrated.

Scenarios: deep search result before first page load, deleted/edited message, source refresh, favorites/resume, remote/WSL source, concurrent selection and canceled loading. Transport bytes and retained DOM/data require separate budgets.

## Implemented compatible contract

- New page IPC for indexed normal local/WSL selection, at most 160 messages with only their parts. Source fingerprint validation remains mandatory. Revision includes catalog identity/fingerprint/update time; continuation cannot use a fresh live fallback and splice changed anchors.
- Existing complete IPC remains unchanged. Session search, descending and analysis views, favorites, smart titles and deep global hits request it explicitly. Remote/unindexed/old snapshots retain complete compatibility; edits/resume preserve their original source/session/line identities.
- Frontend keeps a contiguous loaded prefix; visible indices remain global transcript positions. Continuations are single-flight, revision/offset/identity checked, failure-retry safe and selection-generation gated. Heavy model references clear on selection change. Protected full consumers are not replaced with misleading partial statistics.
- This stage does not introduce sparse arrays, an arbitrary cutoff, or evict earlier loaded pages; doing so would invalidate existing edit/search/selection consumers. Large individual messages and explicit complete operations retain existing byte semantics. The normal indexed read avoids whole-session payload/materialization.
- Discovery verified openSession/openSearchHit, snapshot persistence, title generation, message edit adapters, process/context views, source fingerprint/catalog parts queries, remote adapters and the Tauri macro registry. No schema migration or persisted favorite-format change.
