# Implementation Plan

1. Add legacy Grok session discovery and safe recursive staging copy helpers.
2. Add durable backup + real Home restore orchestration.
3. Call it from release and GC before `remove_dir_all`.
4. Add tempdir regression tests for success, idempotence, conflicts and failure preservation.
5. Update provider contract and `[TEMP]` release notes.
6. Run provider tests, `cargo check`, format/diff checks and detect-changes fallback.
