# Fix sub-agent approval notification accuracy

## Goal

Prevent ambiguous Codex sub-agent Hook events from immediately creating false approval alerts while preserving every real approval request from either the main agent or a child agent.

## Problem Statement

Codex can emit `PermissionRequest` for a child agent before a tool such as `apply_patch` even when no user-visible approval is actually required. CLI-Manager currently treats every such event as authoritative parent-session attention, so the desktop pet, tab state, taskbar, application/system notifications, daemon state, third-party notifications, and remote handoff notifications can all report a nonexistent approval.

Observed evidence:

- Parent CLI session: `019ff9b6-4223-7792-86cb-050f4e66c740`.
- Child agent: `01a00e3d-ffd6-7f63-abf3-dd177ce5ade4`.
- False candidates used `event=PermissionRequest`, `toolName=apply_patch`, a child `agentId`, and no `message`.
- A real child Bash approval in the same session carried the same event and child identity but included an explicit approval message.

## Requirements

- Main-agent approval requests remain immediate and unchanged.
- A child approval with explicit user-facing evidence remains immediate.
- A child `PermissionRequest` that lacks enough evidence to prove a visible prompt must be retained provisionally and must not immediately change the parent tab or desktop-pet status.
- Provisional events must be correlated by parent tab/session, child agent, and the strongest available request identity (`toolUseId`, tool name, and event identity).
- Positive evidence that the child continued or completed must clear only the matching provisional state.
- If a provisional event remains unresolved, evidence is missing, or the process is background-only, it must be escalated after a short bounded grace period. Uncertainty must never result in permanent suppression.
- Main-agent and concurrent child-agent states must not clear or overwrite one another.
- One classification decision must govern daemon task state, desktop-pet state, application toast, taskbar attention, system notification, third-party notification, and remote handoff notification.
- Existing local, WSL, SSH, split-pane, background-daemon, and remote-handoff Hook routing and binding behavior must remain compatible.
- Do not modify cc-connect source or desktop-pet rendering/CSS for this fix.
- Preserve all unrelated uncommitted work already present in the working tree.

## Acceptance Criteria

- [ ] An ambiguous child `PermissionRequest` followed by positively correlated progress/completion produces no approval alert and leaves no stale parent `attention` state.
- [ ] An explicit child approval is delivered immediately to all enabled notification/status sinks.
- [ ] An ambiguous child approval with no resolution is delivered after the bounded grace period rather than being dropped.
- [ ] A main-agent `PermissionRequest` remains immediate.
- [ ] Two concurrent child agents do not clear or contaminate each other's provisional approvals.
- [ ] `SubagentStop`, matching tool progress, and terminal session completion clear only applicable provisional records.
- [ ] Daemon/background operation follows the same decision as the foreground application.
- [ ] Existing Hook retry/deduplication, source admission, transcript routing, and remote-handoff notification tests remain green.
- [ ] Targeted Rust tests, targeted frontend tests where frontend behavior changes, TypeScript type checking, `cargo check`, and NSIS packaging succeed.
- [ ] `CHANGELOG.md` records the fix under `TEMP`, `docs/功能清单.md` is updated in the Hook/desktop-pet status area, and the Hook contract documents the new invariant.

## Out of Scope

- Changing Codex's native permission protocol.
- Suppressing all child-agent approvals based only on `agentId`, missing `message`, or tool name.
- New user-facing settings for the grace period.
- Changes to cc-connect itself.
