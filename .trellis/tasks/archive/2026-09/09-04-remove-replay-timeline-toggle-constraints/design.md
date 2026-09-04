# Technical Design

## Scope and boundary

This is a frontend-only state-behavior change in `src/components/terminal/SessionReplayPanel.tsx`. `ProgressView` owns the transient expansion state for the progress timeline. Replay event parsing, history loading, terminal panel visibility, backend commands, IPC payloads, persistence, and i18n are not involved.

## State model

- Replace the single `expandedTurnId: string | null` value with a `Set<string>` containing every currently expanded turn ID.
- Preserve the existing initial presentation by seeding the first available turn as expanded on the initial model; if the component initially renders an empty model while data loads, seed the first later-arriving turn once.
- Toggle only the clicked turn: remove its ID when it is expanded, otherwise add it to the set. Do not clear other IDs.
- When `model.turns` changes, intersect the set with the IDs currently present in the model. If no IDs remain, keep the empty set; after the one-time initial seed, later data refreshes never auto-expand the first turn.
- Return the previous set from the cleanup updater when no invalid IDs were found, avoiding unnecessary rerenders during live progress updates.

## Behavior contract

| User action/state | Result |
| --- | --- |
| First render with turns | First turn remains expanded for compatibility. |
| Click an expanded turn | That turn collapses and may leave all turns collapsed. |
| Click a collapsed turn | That turn expands while other expanded turns remain open. |
| Switch or refresh to a model without an open turn ID | Stale IDs are removed; no turn is forced open. |
| Progress data updates while open IDs still exist | Open/closed choices are preserved. |

Nested `ConversationDetail` and `ProgressStepRow` disclosure behavior remains unchanged; the requested independent control applies to timeline turns.

## Compatibility and rollback

The `ProgressView` key already scopes the component to the selected replay session, so the transient set is reset when the selected session changes. The change does not alter the `ReplayProgressModel` shape or any external component props. Rollback is limited to restoring the previous local state/effect implementation in the same component.

## Risk

GitNexus file-level upstream impact is LOW. Direct import consumers are `TerminalTabs.tsx` and `TerminalSidePanel.tsx`; no execution-flow or backend contract is affected. The main regression risk is accidentally reintroducing accordion behavior or auto-opening a turn during live model updates, covered by source review and manual checks.
