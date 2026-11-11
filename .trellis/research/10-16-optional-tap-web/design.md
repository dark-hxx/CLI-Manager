# Optional Tap Web design

## Approved direction

The previous session established an independent optional Tap-style client and the user then said to implement. Preserve Tap-Code's quiet light workspace, dark native terminal, folder-grouped sessions, bottom composer and two-row keys. This is a port of an established interaction world, not a visual concept exploration.

## Ownership and flow

`apps/web-tap` owns presentation, local preferences, drafts and session selection. Shared browser HTTP, WebSocket DTOs and terminal stream live under `src/shared` with explicit classic compatibility exports. Neither client imports the other's UI or app model.

The authoritative flow remains Cookie -> devices/history workspace -> registered project.start operation -> native terminal ID -> terminal attach/input/resize. Native bridge resolves registered project/worktree/source and CLI session identity. Read-only terminal transcript is an operation result; the UI never supplies a host path. Existing output frames and rendered cursors remain unchanged.

Build the new client to `apps/web/dist/tap` after the classic build, then explicitly mount a scoped `/tap` static service with its own index. This reuses the existing configured web_dist and embedded resource root. Add the nested artifact to Tauri resources, portable packaging and release builds.

## Interactions

Only an active, visible native terminal participates in size negotiation. Desktop-owned terminal geometry is preserved. Keep the last few viewed sessions mounted with bounded output buffers and detach evicted sessions. Phone text input stays in a textarea; key presses preserve focus. Clear/stop input repeat on pointer cancel, unmount, disconnect and session switch. Sending a draft requires a live connection; retain it on dispatch failure, explain uncertain delivery and never retry automatically.

Read-only chat does not synthesize assistant messages or permission cards. Native menus remain accessible in the terminal. Older messages load explicitly and preserve the reading anchor; live changes scroll only when the user was at the bottom. Heavy details remain lazy and view-scoped.

## Scenario matrix and impact

Cover authenticated/expired/device-scoped sessions; online/offline devices; local/WSL projects and worktrees; unsupported SSH; visible/hidden desktop viewport; browser visible/background/network wake; phone portrait/keyboard and desktop; multiple terminal switches; command/user message/tool history; CLI session binding missing/changed; pre/post operation-response events.

Impact: shared primitive extraction affects classic imports/tests but not wire behavior; server static mounting affects only /tap; native read operation adds only a validated capability; build scripts add the second artifact. No migrations or CLI configuration changes. GitNexus tools are unavailable, so this impact map is derived from owning Web contracts and symbol references per the repository fallback rule.
