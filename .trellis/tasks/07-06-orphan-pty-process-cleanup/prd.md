# Orphan PTY Process Cleanup

## Changelog Target

[TEMP]

## Goal

Add a conservative orphan PTY cleanup mechanism so CLI-Manager can remove backend-owned terminal process trees that no longer have a matching xterm tab, without killing unrelated user processes by name.

## Requirements

* Clean only PTY sessions owned by `PtyManager`.
* Match backend PTY sessions to frontend terminal tabs by session id.
* Never scan or kill by process name such as `node.exe`, `bash.exe`, `cmd.exe`, `codex.exe`, or `wsl.exe`.
* Add a frontend heartbeat that periodically reports active terminal session ids to the backend.
* Backend must treat missing sessions conservatively:
  * ignore empty frontend active lists;
  * protect newly-created PTYs for a short period;
  * mark a session missing before killing it;
  * kill only after the missing state exceeds the grace period.
* Reuse the existing Windows scoped process-tree cleanup for the PTY root PID.
* Keep normal close paths unchanged: tab close uses `pty_close`; app exit uses `pty_close_all`.
* Log candidate, skipped, and cleaned sessions with enough context to diagnose mistakes.

## Acceptance Criteria

* [ ] Frontend periodically sends active terminal session ids to Rust.
* [ ] Backend does not clean anything when the active list is empty.
* [ ] Backend does not clean newly-created sessions inside the startup protection window.
* [ ] Backend cleans only sessions that remain absent from the active list past the grace period.
* [ ] Windows cleanup remains scoped to owned PTY root process trees.
* [ ] `npx tsc --noEmit` passes.
* [ ] `cd src-tauri && cargo check` passes.

## Definition of Done

* Tests or static checks cover the touched frontend and backend code.
* Changelog is updated under `[TEMP]`.
* Product functionality notes are updated if the feature inventory exists.
* No unrelated refactor or dependency change is introduced.

## Technical Approach

Use backend-owned state as the source of truth for process cleanup. Frontend reports the current terminal tab ids on an interval. `PtyManager` records each session's creation time and first missing time. The reconcile method refreshes live sessions, marks absent sessions as missing, and closes only those absent longer than the grace period.

## Decision (ADR-lite)

**Context**: Task Manager shows many `node.exe`, `bash.exe`, and `cmd.exe` descendants under `cli-manager.exe`. Some are valid active xterm sessions and their child tools. Process names cannot distinguish valid work from leaked PTYs.

**Decision**: Implement a session-id based backend reconciliation path. It will clean only `PtyManager` sessions that are absent from the frontend tab list for a sustained period.

**Consequences**: Cleanup is intentionally delayed, so leaks may survive briefly. This is acceptable because avoiding accidental process-tree kills is more important than immediate cleanup.

## Out of Scope

* Killing arbitrary process-name matches.
* Inspecting Linux child processes inside WSL.
* Replacing normal tab close or app exit cleanup.
* Adding user-facing settings for cleanup intervals in this task.

## Technical Notes

* Current `cli-manager.exe(52204)` had 144 descendant processes during investigation.
* Existing cleanup contract is documented in `.trellis/spec/backend/terminal-runtime-monitoring-contracts.md`.
* Main backend files: `src-tauri/src/pty/manager.rs`, `src-tauri/src/commands/terminal.rs`, `src-tauri/src/lib.rs`.
* Main frontend file: `src/stores/terminalStore.ts`.
