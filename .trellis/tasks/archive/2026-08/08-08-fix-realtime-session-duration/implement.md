# Implementation Plan

1. Add optional earliest/latest timestamp fields to the internal session scan result.
2. Capture direct and nested transcript timestamps in the generic JSONL scanner and derive bounds for JSON/message-based scanners.
3. Prefer scan bounds in `build_session_computation`, retaining filesystem fallback and source-specific enrichment.
4. Add Rust regression tests for Codex timestamps and timestamp-less fallback.
5. Update `[TEMP]` changelog and feature inventory.
6. Run focused Rust tests, `cargo check`, `npx tsc --noEmit`, GitNexus change detection, then commit.
