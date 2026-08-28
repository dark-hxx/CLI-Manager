# Implementation Plan

1. Reconfirm dirty-worktree boundaries and run GitNexus impact for every symbol to be edited.
2. Add catalog fingerprint freshness helpers and guard V2 detail reads; make local list/detail reads consume a dirty refresh before returning cached data.
3. Review and minimally adjust history selection rendering/state so session and message batch-selection controls remain available in supported local editable contexts; add source-level regression assertions.
4. Add Rust and frontend tests for edit/delete round trips, stale catalog rows, deleted files, selection controls, and successful selection cleanup.
5. Update `CHANGELOG.md` under `TEMP` and the history section of `docs/功能清单.md`; run focused tests, `npx tsc --noEmit`, `cargo test history --lib`, `cargo fmt -- --check`, and `cargo check`.
6. Run `gitnexus_detect_changes(scope: "unstaged")`, review affected symbols, and report unrelated pre-existing files left untouched.
