# 1.3.10 Web terminal parity

## Mobile project tree correction

Follow-up approved: consolidate phone arrows into one toggle with floating cross-shaped pad, keep Enter at far right and other keys horizontally scrollable. Preserve input focus and IME guard, close on outside tap/viewport change/inactive or disconnected terminal. Cases: narrow/landscape, keyboard visible, multi-session, repeated arrows, offline, bilingual. Touchpoints: MobileTerminalInput/styles/i18n and browser smoke; WebTerminal passes active/running guard, protocol/desktop/WSL/hook unaffected. Memory inbound lookup missed JSX caller; source confirms WebTerminal dependency. Reuse release binaries with tauri bundle, no backend build; commit before packaging.

Mobile space follow-up approved: remove the redundant phone-only project/cwd block now that the persistent project tree entry exists. Allow the auxiliary toolbar to collapse into one bottom-right floating icon, persist the choice in browser storage, keep controls disabled while offline, and refit terminal height. Cover initial/persisted state, storage unavailable, narrow/landscape, soft keyboard, direction/fallback open then collapse, multiple terminals and scroll-to-bottom collision. Desktop Web status remains.

Approved: phone header folder button opens the existing project/Worktree tree in a dismissible drawer. Available with zero terminals. Select context then launch, dismiss when a new terminal runs or when selecting an existing terminal. Retain desktop sidebar at >=768px. Browse cached projects offline, disable launch while disconnected, refresh empty snapshots, disable mobile tree dragging to allow scrolling. Build Web frontend assets now; installer embedding deferred by user. Paths and cursor keys remain.

Root cause: below768px the sidebar is hidden with no alternate project entry. Touchpoints: Workbench drawer and launch callbacks, ProjectSidebar reuse, styles and existing bilingual keys. ProjectTree/start API/desktop runtime unchanged. Validate narrow/wide, empty/nonempty, project/Worktree, offline, close/reopen and launch completion. Focus/tray/split/WSL/hooks use unchanged launch chain.

GitNexus unavailable; refreshed codebase-memory and inbound traces, source and Web contract review used instead. ProjectSidebar inbound Workbench labelled CRITICAL (direct caller); JSX Workbench caller confirmed in App.tsx. Scope remains frontend presentation.
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

Additional approved scope before final packaging: shared parent/subagent workspace at 50/50 on wide screens; stacked 50/50 with collapsible child on narrow screens. Mobile visible viewport follows visualViewport/innerHeight and optional keyboard geometry. Explicit keyboard focus and IME-safe fallback draft input plus terminal key buttons. No automatic phone keyboard popup on session switch. Cover expanded/collapsed, parent tab switching, portrait/landscape, keyboard open/close, absent viewport API, pinch zoom, offline/ended input gating, Chinese/English. Floating keyboards without geometry cannot be reliably detected; fallback text input remains available. Keep runtime unchanged. Prior partial bundle is not the final deliverable.

Final identification follow-up: display the active terminal tab's project name and full project/worktree cwd in the status card, including wrapping/selectable mobile paths and bilingual labels. Cwd is retained only in authenticated workspace responses after user/device ownership validation; it is never added to public or pairing responses. Cover project/worktree, tab switching, long paths, missing legacy cwd and authorization boundary. Rebuild affected Web/server/desktop bridge binaries and package1.3.10.

Mobile refinement approved before packaging: hide the verbose session/control/browser status card on phone/coarse-pointer layouts, while retaining project/cwd as a compact line below terminal tabs. Add visible left/up/down/right auxiliary buttons that send standard ANSI cursor sequences through the existing guarded terminal input channel. Desktop status card remains unchanged; disconnected terminals keep all auxiliary keys disabled.

User approved adding to this task: browser-only manual font8–36px, plus/minus and Ctrl+wheel; fit-width (can enlarge), contain (existing default), viewport width/height30–100% sliders, overflow scrolling and reset. This supersedes the no-user-magnification constraint above; default remains contain. Browser-local preference shared across tabs, no desktop preference or protocol change. Rebuild only Web assets and rebundle existing1.3.10 executables; commit before bundling.

Scope: WebTerminal, browser i18n/views/styles, display normalization and smoke tests. Existing byte/replay/query/subagent pipelines preserved. Desktop/server/IPC unchanged this follow-up. Cases: desktop/Web owner, wide/narrow/short/split viewport, hidden->active, Ctrl-wheel, mouse input/selection, overflow last row, storage blocked/corrupt/remount, bilingual labels. Hooks/WSL/Worktrees use unchanged byte transport, no special new paths.
