# Fix Realtime Stats Latest Change Black Screen

## Goal

Opening the realtime stats side panel and clicking the latest-change diff action must show the change details without blanking the application.

## Confirmed Facts

- The user reports a black screen when opening realtime stats and clicking "最新变更" change details.
- The realtime stats latest-changes card is rendered by `TerminalStatsPanel` and `LatestChangesCard`.
- `TerminalStatsPanel` opens `DiffModal` with structured `fileChanges`.
- The history workspace uses the same `DiffModal` with an explicit relative container. The realtime stats path currently does not provide one.
- Follow-up error: the realtime stats path does not pass `messages`, and `DiffModal` defaulted `messages` to a fresh inline `[]`, so its parsing effect repeatedly saw changed dependencies and called `setBlocks`, producing React's "Maximum update depth exceeded" error.
- The bug is frontend-only unless further inspection shows malformed history data.

## Requirements

- Clicking the latest-change diff action from realtime stats must render a visible diff modal instead of a black screen.
- The modal close action must restore the realtime stats panel without requiring a full refresh.
- Existing history-session diff behavior must remain unchanged.
- No new user-facing text should be introduced unless it is wired through i18n.

## Acceptance Criteria

- `npx tsc --noEmit` passes.
- Realtime stats latest-change diff opens with visible content when `fileChanges` include patch or old/new text data.
- Closing the diff returns to the previous realtime stats side panel state.
- History workspace diff modal still receives its own container and behavior is not regressed.

## Out Of Scope

- Redesigning the latest-changes card.
- Changing backend history parsing unless frontend inspection proves the data contract is invalid.
- Changing unrelated realtime stats cards.

## Open Questions

- None blocking. The bug report is specific enough to proceed with the minimal fix.
