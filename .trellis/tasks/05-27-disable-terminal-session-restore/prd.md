# Disable Terminal Session Restore

## Goal

Prevent CLI-Manager from recreating persisted terminal sessions on startup, because restored sessions can rerun project startup commands and spawn many Windows child processes, especially node.exe processes from npm/npx/vite/Claude/MCP workflows.

## What I already know

* User observed 259 child processes under CLI-Manager on Windows, with many node.js processes.
* User confirmed terminal restore is optional and asked to optimize for best effect.
* `src/App.tsx` currently calls `useTerminalStore.getState().restoreSessions(...)` during app initialization.
* `src/stores/terminalStore.ts` restores every persisted session by invoking `pty_create`.
* Restored sessions with `startupCmd` call `pty_write` after 500ms, which reruns commands like npm/npx/vite.
* Persisted splits are also restored and create additional PTY sessions.

## Requirements

* Do not automatically restore terminal PTY sessions on app startup.
* Do not rerun persisted terminal `startupCmd` on app startup.
* Clear stale persisted terminal session metadata during startup so old sessions do not accumulate across launches.
* Keep manual project opening behavior unchanged: opening a project can still create a terminal and run its configured startup command.
* Keep app initialization for settings, sync config, project list, and update check unchanged.

## Acceptance Criteria

* [ ] App startup does not call `pty_create` for persisted terminal sessions.
* [ ] App startup does not write persisted `startupCmd` into a restored PTY.
* [ ] Previously persisted sessions/splits/active terminal id are cleared during startup.
* [ ] Manually opening a project still creates a terminal normally.
* [ ] Typecheck passes.

## Definition of Done

* Minimal code change, no dependency change.
* Static checks pass.
* Behavior impact is explained clearly.

## Technical Approach

Remove terminal session restoration from the startup path in `src/App.tsx` and clear persisted terminal session metadata after project list loading. Keep `restoreSessions` available unless it becomes unused by typecheck/lint constraints; avoid broader refactor.

## Decision (ADR-lite)

**Context**: Restoring terminal sessions is convenient but unsafe for process count because it recreates PTYs and reruns startup commands.
**Decision**: Disable startup restoration entirely for now and clear stale persisted session data.
**Consequences**: Users will need to reopen terminals/projects after launching the app, but startup becomes predictable and avoids accidental node process storms.

## Out of Scope

* Implementing a full restore-policy settings UI.
* Adding Windows process-tree cleanup.
* Changing external terminal behavior.
* Refactoring terminal store architecture.

## Technical Notes

* Relevant files: `src/App.tsx`, `src/stores/terminalStore.ts`, `src/stores/sessionStore.ts`, `src-tauri/src/pty/manager.rs`.
* Root cause evidence: `restoreSessions` loops persisted sessions and calls `pty_create`; if `startupCmd` exists it later calls `pty_write`.
