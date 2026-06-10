# Optimize main stats panel load performance

## Goal

Optimize the main Analytics/Stats panel so it opens quickly on repeated use instead of rescanning or recomputing history every time. Keep behavior and displayed statistics unchanged unless explicitly approved.

## What I already know

* User reports: the main page stats panel is slow every time it is opened.
* The stats panel is opened from `App.handleOpenStats` and rendered by `src/components/stats/StatsPanel.tsx`.
* `StatsPanel` calls `historyStore.loadStats` whenever it opens or when project/range/source changes.
* `historyStore.loadStats` has a frontend LRU cache, but the TTL is only 15 seconds.
* The Rust command `history_get_stats` builds stats from the history index and returns totals, project ranking, model distribution, heatmap, daily series, source distribution, efficiency, and hourly activity.
* The backend history index has a 5-second TTL; after that it may rescan session files and verify fingerprints for all history files.
* `App.handleOpenStats` also calls `history.loadSessions()` when no sessions are loaded, so opening the stats panel can trigger session list loading and stats loading together.
* Project uses React 19, Zustand, Tauri 2, TypeScript 5.8, Rust 2021. No new dependency appears necessary.

## Assumptions (temporary)

* The slow path is repeated history scanning / index rebuilding, not chart rendering alone.
* Users prefer stale-while-revalidate behavior: show cached stats immediately, refresh in the background when needed.
* Existing stats content and filters should remain unchanged.

## Open Questions

* None.

## Requirements

* Keep stats panel UI and data semantics unchanged.
* Optimize both frontend open/cache behavior and backend history stats/index caching.
* Allow changing stats query conditions, including time range and project filter.
* Default stats panel opening to the natural current week (Monday 00:00 to now) and the first project in the project dropdown instead of all projects / last 30 days.
* Replace fixed day-count presets with a user-controlled start/end date range picker.
* Date range picker is date-level: start date and end date are inclusive whole-day bounds.
* Avoid recomputing stats on every open when the same source/project/manual date range/history paths are selected.
* Show already available stats immediately when reopening the panel, then refresh only when data is stale or explicitly requested.
* Keep manual refresh as an explicit force refresh.
* Avoid adding new dependencies.

## Acceptance Criteria

* [x] Reopening the stats panel with the same filters uses already loaded stats immediately.
* [x] Manual refresh still bypasses frontend and backend cache.
* [x] Changing project/source/manual date range loads matching stats.
* [x] Opening the panel defaults to the natural current-week date range.
* [x] Time range control lets the user manually select inclusive start and end dates instead of choosing fixed day counts.
* [x] Opening the panel defaults to the first selectable project when project options exist; falls back to all projects when no project option exists.
* [x] Backend avoids rebuilding or re-aggregating stats unnecessarily when history files have not changed.
* [x] Stats panel no longer starts unnecessary work beyond what is required to resolve default project options and stats.
* [x] No new dependency is added.
* [x] TypeScript check and relevant Rust check scope are reported if run.

## Technical Approach

* Frontend: replace numeric-only `rangeDays` state with explicit `startAt` / `endAt` query bounds driven by date-level start/end inputs.
* Frontend: default the manual date range to the natural current week and initialize the project filter to the first project option once options are available.
* Frontend: make `loadStats` return cached/active stats immediately for the same source/project/date-bound key, use stale-while-revalidate semantics, and keep `force: true` for manual refresh.
* Frontend: reduce stats-panel open side work that triggers history session loading unless project filter options actually require it.
* Backend: extend `history_get_stats` to accept explicit `start_at` / `end_at` query bounds while keeping relative range support for existing callers.
* Backend: cache `history_get_stats` aggregation by roots/source/project/time bounds plus history index generation, so unchanged history returns without re-aggregating.
* Backend: keep fingerprint-based invalidation; do not change statistic semantics.

## Decision (ADR-lite)

**Context**: Reopening the stats panel currently calls `loadStats` and can trigger both frontend stats loading and backend history index refresh.
**Decision**: Optimize both frontend and backend caching without redesigning the UI or changing data sources.
**Consequences**: Better repeated-open latency with low semantic risk; backend cache invalidation must stay tied to history index generation/fingerprints.

## Definition of Done (team quality bar)

* Tests added/updated where appropriate.
* Lint / typecheck / CI green if requested or run.
* Docs/notes updated if behavior changes.
* Rollout/rollback considered if risky.

## Out of Scope (explicit)

* Redesigning the stats panel UI.
* Changing chart types or adding new metrics.
* Migrating historical JSONL data into SQLite.
* Introducing a new caching dependency.

## Technical Notes

* Frontend files inspected: `src/App.tsx`, `src/components/stats/StatsPanel.tsx`, `src/stores/historyStore.ts`.
* Backend file inspected: `src-tauri/src/commands/history.rs`.
* Likely minimal fix area: `historyStore.loadStats` cache policy and `StatsPanel` open effect behavior.
* Possible backend fix area: `HISTORY_SESSION_INDEX_TTL_MS`, `SESSION_FILES_TTL_MS`, and stats response caching around `history_get_stats`.
