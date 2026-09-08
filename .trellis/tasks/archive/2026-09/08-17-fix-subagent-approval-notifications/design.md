# Design: sub-agent approval arbitration

## Root-Cause Statement

The bug lives at the shared Hook-consumption boundary: normalized child identity reaches the daemon, but every `PermissionRequest` is immediately fanned out as authoritative parent-session attention before its interactive nature is established; the fix therefore belongs before the shared sink fan-out rather than in desktop-pet presentation code.

## Design Invariant

If CLI-Manager cannot prove that a child approval was automatically resolved, it eventually alerts. Filtering is allowed only while a provisional event is retained and only positive correlated evidence may resolve it.

## Event Classification

Classify accepted Hook payloads before status and notification fan-out:

1. `PermissionRequest` without `agentId`: confirmed approval, deliver immediately.
2. Child `PermissionRequest` with a non-empty user-facing `message`: confirmed approval, deliver immediately.
3. Child `PermissionRequest` without explicit evidence: provisional approval, retain without delivery.
4. All other events: normal delivery plus provisional-resolution evaluation.

Missing `message` is not treated as proof that no approval exists. It only selects the provisional path.

## Provisional Identity

Each record contains:

- parent `tabId`;
- CLI `sessionId` when available;
- child `agentId`;
- `toolUseId` when available;
- normalized `toolName` when available;
- `remoteEventId` as the unique event identity;
- received timestamp and deadline;
- the original full payload for conservative escalation.

Exact `toolUseId` is preferred. When Codex omits it, matching falls back to the same parent/session + child + tool name. An unrelated child or parent event cannot resolve the record.

## State Machine

```text
ambiguous child PermissionRequest
  -> provisional (not fanned out)
  -> resolved: matching ToolStart/ToolStop, later matching child progress,
               or SubagentStop/session completion
  -> confirmed: explicit approval evidence arrives
  -> escalated: grace deadline expires without positive resolution
```

The grace period is a small internal constant, not a setting. It must be long enough for an automatically approved tool to emit correlated progress but bounded so an ambiguous real approval is still surfaced promptly. Tests use an injected clock/deadline rather than sleeping for production time.

When a later distinct permission for the same child/tool arrives, the older provisional record may be resolved only if event ordering proves the child progressed past it; otherwise both records remain independently identifiable and the conservative timeout applies.

## Shared Boundary

Introduce a stateful approval arbiter between `spawn_hook_listener`/remote SSH Hook admission and the existing daemon sink closure. The arbiter owns provisional state and invokes the existing delivery closure only for normal, confirmed, or conservatively escalated payloads.

This placement keeps one decision for:

- daemon task status;
- frontend broadcast and desktop-pet status;
- application toast, taskbar attention, and system notification;
- third-party notification dispatcher;
- remote-handoff notifier;
- background application activation.

The existing frontend status mapper remains a consumer of already-admitted approval events. It should not implement a second independent heuristic.

## Positive Resolution Rules

- For local Codex events, the Hook client records the rollout file size before it returns control to Codex. Growth beyond that baseline is authoritative evidence that the blocked tool completed or the session otherwise progressed, so the matching provisional record is resolved.
- Matching `ToolStart` or `ToolStop` resolves the exact request identity.
- `SubagentStop` resolves all provisional records for that parent/session + child.
- Parent `Stop` or `StopFailure` resolves all provisional records for that parent/session.
- A new parent `UserPromptSubmit` resolves prior provisional records for that parent/session because a new turn has authoritatively started.
- Events from another child do not resolve anything.
- Missing/ambiguous correlation, queue failure, or unavailable evidence leaves the record pending until conservative escalation.

The rollout check uses file metadata only. It does not parse prompts, compare localized strings, or read transcript content. Remote/WSL paths that are not locally readable simply lose this optimization and follow correlated Hook events plus conservative escalation.

## Concurrency And Bounds

- Store provisional records behind a mutex owned by the arbiter worker.
- Use a bounded channel and bounded pending map/deque.
- On queue saturation or worker failure, deliver the approval immediately; never drop it.
- Expired records are delivered once and removed.
- Remote event deduplication continues before arbitration, so one Hook invocation cannot create duplicate provisional records.

## Compatibility

- No persisted settings or database schema changes.
- No IPC rename; one optional rollout-baseline byte count is added to the serialized Hook payload, so older SSH agents and Hook clients remain backward compatible.
- Local, WSL, and SSH events enter the same arbiter after current source/binding validation.
- Sub-agent transcript events continue to reach the frontend normally.
- Existing explicit permission-mode suppression (`dontAsk`/`bypassPermissions`) remains at the hook client because those modes are authoritative protocol evidence.

## Scenario Matrix

| Scenario | Expected behavior |
|---|---|
| Main agent, app focused/unfocused | Immediate approval; current taskbar/toast preferences still apply. |
| Child agent, explicit prompt | Immediate approval in foreground, tray, or background-daemon mode. |
| Child agent, ambiguous then progress | No approval fan-out; parent and pet remain on the real task state. |
| Child agent, ambiguous and stalled | Escalate after bounded grace period. |
| Multiple child agents | Independent provisional keys and resolution. |
| Split pane / Workspan | Existing exact/bound tab routing remains authoritative. |
| Local PowerShell/CMD/Pwsh, WSL, SSH | Same classification after source admission; no environment-specific silent drop. |
| Hook not installed | No behavior change; no synthetic state. |
| App disconnected, daemon active | Same arbitration before background activation and notification delivery. |
| Remote handoff active | Same confirmed/escalated event reaches the current platform notifier. |

## Discovery List

- [x] `src-tauri/hook-schema/src/lib.rs`: normalization retains child/request identity; likely unchanged unless stronger identity extraction is required.
- [x] `src-tauri/src/hook_client.rs`: raw Hook normalization and authoritative permission-mode suppression; preserve existing behavior and add classification fixtures if needed.
- [x] `src-tauri/src/claude_hook.rs`: shared payload, admission, dedupe, and appropriate home for reusable arbitration primitives.
- [x] `src-tauri/src/daemon/server.rs`: shared local/SSH Hook sink, background activation, status update, frontend broadcast, third-party dispatch, and remote-handoff fan-out; primary integration point.
- [x] `src/stores/terminalStore.ts`: currently maps every delivered permission to `attention`; expected to remain simple after upstream arbitration, with regression coverage if helpers are extracted.
- [x] `src/App.tsx`: sends taskbar/toast/system notifications for every delivered permission; expected to consume the corrected stream without an independent filter.
- [x] `src-tauri/src/third_party_notification/*`: downstream notification formatting; confirmed unrelated to classification if arbitration precedes enqueue.
- [x] `src-tauri/src/commands/cc_connect/handoff_notification.rs`: downstream remote notification scheduler; confirmed unrelated if arbitration precedes enqueue.
- [x] `src/lib/desktopPet.ts` and pet CSS/rendering: confirmed unrelated; they should continue deriving mood from corrected terminal state.
- [x] replay recording: receives only delivered/escalated approval events; false provisional events should not become user-visible replay alerts.

## Risks And Mitigations

- Risk: protocol variants omit `message` for a real approval. Mitigation: bounded conservative escalation.
- Risk: imprecise fallback matching clears another request. Mitigation: prefer exact IDs; scope fallback by parent/session + child + tool and never cross child boundaries.
- Risk: delayed worker fails. Mitigation: fail open by immediately delivering the approval.
- Risk: existing dirty Hook-adjacent files are overwritten. Mitigation: inspect per-file diffs before every edit and patch only targeted hunks.

## Rollback

Remove the arbiter wrapper and route accepted payloads directly to the existing delivery closure. No migration or persisted-state rollback is required.
