# Fix Realtime Stats Current Model Context

## Goal

Fix the realtime terminal stats "Model and Context" card so it reflects the latest model and context values after a model switch inside the same CLI session.

## Changelog Target

[TEMP]

## Requirements

- In one session, after the CLI switches model, realtime stats must display the latest model instead of the session dominant model.
- Context limit, current context, remaining space, and percentage must be calculated from the latest model/context data.
- Reasoning effort must prefer the latest hook/session value instead of stale historical usage when available.
- Token trend must stay as one continuous line but distinguish model segments by color.
- Token trend hover tooltip must show the model name for the hovered point.
- Preserve existing historical stats semantics for `dominant_model`.

## Acceptance Criteria

- [ ] Backend session scan exposes latest/current model separately from dominant model.
- [ ] Frontend normalizes and uses the current model in realtime stats.
- [ ] Existing history stats model distribution/dominant model behavior is unchanged.
- [ ] A regression test covers same-session model switching.
- [ ] Token trend points carry model attribution and the realtime chart renders model-specific colors/tooltips.
- [ ] TypeScript and relevant Rust checks pass.

## Definition of Done

- Tests/checks run where practical.
- `CHANGELOG.md` updated under `[TEMP]`.
- `docs/功能清单.md` updated only if the existing feature inventory mentions the affected realtime stats behavior.

## Technical Approach

Add a `current_model` field to history usage scan output, update TypeScript usage types/normalization, and make the realtime model/context card prefer `current_model` while keeping `dominant_model` for aggregate statistics.

Extend `token_trend` points with optional model attribution. The frontend keeps one sparkline and colors each segment by the model of the point it leads into; tooltip shows the hovered point model.

## Decision

Keep `dominant_model` unchanged because it is used by historical summaries and model ranking. Add a new latest-model field for realtime display.

## Out of Scope

- Changing model pricing logic.
- Changing history aggregation semantics.
- Adding new UI labels.

## Technical Notes

- Relevant files inspected:
  - `src-tauri/src/commands/history.rs`
  - `src/stores/historyStore.ts`
  - `src/lib/types.ts`
  - `src/components/terminal/TerminalStatsPanel.tsx`
  - `src/components/stats/termStatsCards.tsx`
- GitNexus impact:
  - `scan_session_inner`: CRITICAL because it feeds history list/detail/stats; changes must be additive.
  - `fetchLatestProjectSessionDetail`, `normalizeSessionUsage`, `ModelContextCard`: LOW.
