# Large history detail demand loading

Child of 11-01-memory-usage-hardening; not implemented in the first repair batch.

- Avoid full-message fetch_all and full-detail IPC for very large sessions.
- Load tool bodies/diffs on demand and page messages while preserving search result jumps, edit operations, favorites and CLI resume.
- Preserve local/WSL/SSH sources and stable identifiers; errors must not become empty successful history.
- Acceptance: synthetic large-history paging/anchor regressions and installed GUI search/edit/resume checks, with documented IPC compatibility.
