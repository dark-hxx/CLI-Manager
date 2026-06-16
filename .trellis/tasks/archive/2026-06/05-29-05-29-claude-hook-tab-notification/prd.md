# Claude Hook Tab Notification

## Goal

Make Claude Code hook notifications visible inside CLI-Manager terminal tabs so users can quickly identify which internal terminal needs attention when multiple Claude Code sessions are open.

## Requirements

- Reuse the existing small dot in terminal tabs for Claude hook notification state instead of PTY process status.
- Preserve existing PTY status tracking for lifecycle/logging, but stop using it to drive the tab dot UI.
- Inject CLI-Manager hook bridge environment variables into PTY sessions created by CLI-Manager:
  - `CLI_MANAGER_TAB_ID`
  - `CLI_MANAGER_NOTIFY_PORT`
  - `CLI_MANAGER_NOTIFY_TOKEN`
- Add a local-only hook receiver in CLI-Manager that accepts hook events from a new independent hook script.
- Map hook events to tab notification state:
  - `Notification` -> attention state.
  - `Stop` -> done state.
  - `StopFailure` -> failed state.
- Clicking/activating a tab clears only attention state for that tab.

## Acceptance Criteria

- [ ] Terminal tab dot no longer changes because a PTY is running/exited/error.
- [ ] A hook `Notification` event marks the matching tab as needing attention.
- [ ] A hook `Stop` event marks the matching tab as completed.
- [ ] A hook `StopFailure` event marks the matching tab as failed.
- [ ] Activating a tab clears its attention state.
- [ ] Existing terminal creation, close, split, restore, and PTY output behavior still works.
- [ ] Existing `C:\Users\1\.claude\hooks\notify.ps1` remains untouched.

## Definition of Done

- TypeScript typecheck passes with `npx tsc --noEmit`.
- Rust backend passes `cd src-tauri && cargo check`.
- No new third-party dependency is added.
- Security boundary is local-only and token-protected.

## Technical Approach

- Add a minimal Rust localhost HTTP receiver bound to `127.0.0.1` on a random port at app startup.
- Generate a per-app-run token and expose port/token only to child PTY processes through environment variables.
- The PowerShell hook script posts hook JSON to the local receiver when the environment variables exist; otherwise it exits successfully.
- The Rust receiver validates method/path/token/body size/event shape, then emits a Tauri event to the frontend.
- `terminalStore` owns transient tab notification state in memory.
- `TerminalTabs` renders the existing dot from hook notification state instead of `sessionStatuses`.

## Decision (ADR-lite)

**Context**: Windows notifications identify that Claude Code needs attention but do not tell the user which CLI-Manager tab owns the event.

**Decision**: Use environment variables plus a token-protected localhost receiver and transient frontend state. Keep the old Windows notification script separate.

**Consequences**: The feature is precise and low-coupling. Notification state is intentionally not persisted across app restart. The Rust receiver adds a small local boundary that must stay localhost-only and token-checked.

## Out of Scope

- Modifying the existing `notify.ps1` script.
- Editing Claude Code `settings.json` hook configuration automatically.
- Persisting notifications in SQLite or settings.
- Windows notification click-to-focus behavior.
- Full notification center UI.

## Technical Notes

- `src/components/TerminalTabs.tsx` currently renders the tab dot from `sessionStatuses` with `STATUS_COLORS`.
- `src/stores/terminalStore.ts` owns PTY session state and listens to `pty-status-{sessionId}` events.
- `src-tauri/src/commands/terminal.rs` creates session IDs before spawning PTY and can inject env vars safely.
- `src-tauri/src/pty/manager.rs` already accepts `env_vars` and passes them to `portable_pty::CommandBuilder`.
- Relevant specs:
  - `.trellis/spec/frontend/state-management.md`
  - `.trellis/spec/frontend/component-guidelines.md`
  - `.trellis/spec/frontend/type-safety.md`
  - `.trellis/spec/backend/index.md`
  - `.trellis/spec/guides/cross-layer-thinking-guide.md`
