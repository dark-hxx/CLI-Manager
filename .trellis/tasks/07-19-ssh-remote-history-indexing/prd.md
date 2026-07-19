# SSH remote history indexing

## Goal

Remote adapters, incremental shared index, source-instance registration, catalog cache, and search/detail RPC.

## Requirements

- Parse remote Claude/Codex history incrementally from the configured root.
- Use shared single-writer remote indexes and existing local `history-catalog.db` v2 summary/cache storage.
- Preserve `(sourceId, sourceInstanceId, sourceSessionId)` identity and never pass remote paths to local file/history APIs.
- Support list, search, detail, diff, usage facts, freshness, stale/offline, cursors, rotation, and tombstones.

## Acceptance Criteria

- [ ] Multiple Host/user/root instances coexist without deactivating local/WSL sources.
- [ ] Incremental append, rotate, truncate, lock lease, writer crash, and cache migration tests pass.
- [ ] Offline list/summary/stats work while full detail/search clearly requires online data when uncached.
- [ ] Repeated UI requests reuse one bridge and do not create SSH connection storms.

## Notes

- Depends on `07-19-ssh-agent-bridge-runtime`.
