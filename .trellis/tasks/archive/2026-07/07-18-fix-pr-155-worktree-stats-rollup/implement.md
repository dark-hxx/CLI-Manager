# Implementation Plan

1. Refresh GitNexus and run upstream impact analysis for `history_get_stats`, `build_history_stats_daily_index`, `fetchTodayProjectStatsMerged`, and `TerminalStatsPanel`.
2. Add canonical multi-path normalization and any-path matching in `history.rs`.
3. Include canonical path sets in daily-index and aggregation cache keys.
4. Change the frontend stats helper to issue one multi-path request and remove client-side summation.
5. Remove the `latestSession` gate for project-level today usage while preserving session-card gating.
6. Add focused Rust and frontend tests.
7. Update the history stats contract, V1.2.9 changelog, and feature inventory.
8. Run formatting, focused tests, `npx tsc --noEmit`, `cargo check`, GitNexus detect-changes, commit with `Refs #137`, and push to the original PR branch.
