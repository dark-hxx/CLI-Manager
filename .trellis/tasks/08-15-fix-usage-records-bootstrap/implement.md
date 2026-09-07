# Implementation Steps

1. Inspect all direct SQLx main-database entry points and confirm exact connection ownership.
2. Add a shared idempotent usage schema bootstrap in `src-tauri/src/usage.rs`, reusing existing migration SQL constants and serializing first-time ensure.
3. Invoke bootstrap before route usage write/read and before history/request-log direct queries or sync operations.
4. Add regression tests for empty database, legacy `request_logs`, repeat initialization, view availability, and route/history access ordering.
5. Update V1.3.6 `CHANGELOG.md` and `docs/功能清单.md` without changing unrelated entries.
6. Run `cargo fmt --check`, focused Rust tests, `cargo check`, `npx tsc --noEmit`, and inspect the final diff. Run `gitnexus_detect_changes` before delivery; do not commit.

## Review gates

- Do not add a frontend-only `getDb()` pre-call as the primary fix.
- Do not swallow `no such table` in history stats.
- Do not alter existing data or migration version/checksum definitions unless a test proves a formal migration correction is required.
- Keep edits tight and preserve unrelated uncommitted work.
