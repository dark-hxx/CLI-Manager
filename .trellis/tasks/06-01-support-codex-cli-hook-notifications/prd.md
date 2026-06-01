# Support Codex CLI Hook Notifications

## Goal

Add Codex CLI hook notification support to CLI-Manager so Codex terminal tabs can show task-complete and needs-attention notifications like existing Claude Code tabs.

## Requirements

* Reuse the existing local HTTP hook bridge and terminal-tab notification flow.
* Keep existing Claude Code hook behavior compatible.
* Add Codex CLI hook install/status/uninstall support for user-level `~/.codex/hooks.json`.
* Map Codex `Stop` to task completion.
* Map Codex `PermissionRequest` to needs-attention / paused-for-user-action.
* Do not invent a Codex failure state because Codex does not expose a `StopFailure` event.
* Do not modify project `.codex/hooks.json`; it already belongs to Trellis/project hooks.
* Do not add dependencies.

## Acceptance Criteria

* [ ] Settings page shows Claude Code and Codex CLI hook cards independently.
* [ ] Claude install/uninstall/status still works.
* [ ] Codex install writes CLI-Manager scripts under `~/.codex/hooks/` and registers commands in `~/.codex/hooks.json`.
* [ ] Codex uninstall removes only CLI-Manager scripts/commands.
* [ ] Codex `Stop` event marks the matching tab done and shows a toast.
* [ ] Codex `PermissionRequest` marks the matching tab attention and shows a toast.
* [ ] Invalid hook payloads are rejected at the Rust bridge boundary.
* [ ] TypeScript and Rust checks pass.

## Definition of Done

* `npx tsc --noEmit` passes.
* `cd src-tauri && cargo check` passes.
* No new dependency added.
* Existing Claude hook behavior is not broken.

## Technical Approach

Generalize current Claude-specific hook payload/event naming to CLI hook naming while keeping command names stable where practical. Extend backend hook settings commands to manage both Claude and Codex install targets. Frontend renders one settings page with separate cards and uses one notification handler for both sources.

## Decision (ADR-lite)

**Context**: Codex CLI hook events differ from Claude Code events.

**Decision**: Support Codex `Stop` and `PermissionRequest` only; keep Claude `Notification`, `Stop`, `StopFailure` unchanged.

**Consequences**: MVP covers completion and attention/pause. Codex failure notification remains out of scope until Codex exposes a reliable failure event.

## Out of Scope

* Automatically editing `~/.codex/config.toml` feature flags.
* Auto-approving Codex `/hooks` review.
* Codex failure-state detection.
* Project-scoped `.codex/hooks.json` modification.

## Technical Notes

* Existing bridge: `src-tauri/src/claude_hook.rs`.
* Existing settings command: `src-tauri/src/commands/hook_settings.rs`.
* Existing frontend settings page: `src/components/settings/pages/HookSettingsPage.tsx`.
* Existing frontend notification handling: `src/App.tsx`, `src/stores/terminalStore.ts`, `src/components/TerminalTabs.tsx`.
* Codex hooks require user-level `[features].hooks = true` and Codex 0.129+ `/hooks` approval.
