# 1.3.10 Web terminal parity
User authorized task creation and implementation, including subagent display parity.
- Desktop-owned terminal: preserve PTY grid, contain width and height, no automatic magnification. Input row stays visible when subagent splits narrow the parent.
- Web-owned terminal: normal font and fit to browser; retain historical replay grids.
- Prevent replay/multiple-viewer protocol responses from contaminating live input; preserve keyboard, IME, paste and shortcuts.
- Show actual desktop subagent transcripts/lifecycle in a separate read-only Web panel linked to parent; responsive wide/narrow presentation.
- Version 1.3.10, bilingual labels, changelog and feature inventory.
- Verify viewport geometry and last row, split/unsplit, live/replay query replies, multi-viewer, transcript updates/end/removal/reconnect.
No Git synchronization or unrelated dirty-file cleanup. Record actual installed-environment checks separately from isolated harness results.
User confirmed narrow/short browser preference: prioritize full desktop grid, shrink font to contain both dimensions rather than introduce viewport panning. Wide mirrors never magnify beyond normal font size.

## Approved display controls follow-up

User approved adding to this task: browser-only manual font8–36px, plus/minus and Ctrl+wheel; fit-width (can enlarge), contain (existing default), viewport width/height30–100% sliders, overflow scrolling and reset. This supersedes the no-user-magnification constraint above; default remains contain. Browser-local preference shared across tabs, no desktop preference or protocol change. Rebuild only Web assets and rebundle existing1.3.10 executables; commit before bundling.

Scope: WebTerminal, browser i18n/views/styles, display normalization and smoke tests. Existing byte/replay/query/subagent pipelines preserved. Desktop/server/IPC unchanged this follow-up. Cases: desktop/Web owner, wide/narrow/short/split viewport, hidden->active, Ctrl-wheel, mouse input/selection, overflow last row, storage blocked/corrupt/remount, bilingual labels. Hooks/WSL/Worktrees use unchanged byte transport, no special new paths.
