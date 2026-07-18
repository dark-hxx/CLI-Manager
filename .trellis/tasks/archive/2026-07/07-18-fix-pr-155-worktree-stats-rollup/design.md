# Design

## Root Cause

The frontend performs one stats query for the parent path and one for every Worktree path, then sums them. Backend path matching includes descendants, so overlapping parent/child paths can match the same history session multiple times. The panel also incorrectly uses `latestSession` as a gate for project-level data.

## Data Flow

1. `TerminalStatsPanel` derives the parent project path plus active Worktree paths.
2. `historyStore.fetchTodayProjectStatsMerged` sends the normalized path list as `projectPaths` in one `history_get_stats` invocation.
3. Rust combines legacy `project_path` and new `project_paths`, normalizes/sorts/deduplicates them, and filters each `HistoryIndexEntry` with an any-path predicate.
4. Each index entry enters aggregation at most once, regardless of how many paths match.
5. Cache keys include the canonical multi-path filter key.

## Compatibility

- Existing callers that send only `projectPath` continue to work.
- Missing `projectPaths` deserializes to `None`.
- Raw `projectKey` behavior is unchanged and remains conjunctive when combined with path filters.
- Session-level realtime detail continues to use the active checkout path and `cliSessionId`.

## Trade-offs

- Adding an optional backend argument touches the command contract but avoids repeated scans and incomplete client-side aggregation.
- The backend owns overlap handling because it has the authoritative session identity and path matching rules, including WSL/UNC variants.
