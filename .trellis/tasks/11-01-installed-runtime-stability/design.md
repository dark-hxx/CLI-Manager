# Design

## Status and Root-Cause Statements

Implementation approved on 2026-11-01. Scoped implementation and regression
verification are in progress; installed-app replacement remains out of scope.

- Exit safety: the app-to-backup and terminal-snapshot boundaries wait for
  dependencies without complete deadlines; fixes belong at the operation
  owners, not at the close button with an unconditional forced exit.
- Thread responsiveness: diagnostic IPC synchronously persists files on the
  GUI thread, while several async terminal commands call blocking daemon
  methods; those calls must cross an explicit blocking-worker boundary.
- OOM evidence: the native WebView exception bypasses JS reporters, and RAM
  utilization alone cannot diagnose commit exhaustion. Native sampling must
  survive a nonresponsive frontend and remain numeric, bounded and private.
- Historical GUI hang: its exact blocked thread is still unknown. These
  source defects are falsifiable repair targets, not proof of historical cause.

## Ordered Scope

### 1. Bounded Exit Operations

Use a small app-owned exit-stage module instead of increasing App.tsx beyond
its architectural budget. It owns stage identifiers, elapsed/outcome logging,
and the close-attempt lifetime. Existing UI wiring remains in App.tsx.

Include settings loading in the existing 8-second close-sync budget. If the
load completes late, it must not initiate a new backup for the expired attempt.
Preserve existing outbox persistence and queued-upload semantics; do not treat
Promise.race as cancellation of a backup already in progress.

In sessionSnapshotPersistence, add bounded per-source write/serialize and
checkpoint waits with an attempt lifetime separate from source disposal.
Timeout must release the flight, mark the source dirty, preserve the last good
data, and reject stale continuations. A source must remain usable for a later
attempt. Preserve the force-pass coalescing and source-identity checks.

Use an overall exit-stage budget in addition to per-source limits so many
stalled terminals cannot multiply into minutes of serial waiting. Snapshot
operations use 3 seconds each and a 10-second pass; the outer exit snapshot
budget is 25 seconds (covering a periodic pass followed by a forced pass),
required terminal cleanup 30 seconds and discard-store work 8 seconds.
Do not race a non-cancellable disk save and then run overlapping stale saves;
store writes remain ordered, and an unconfirmed save keeps the window open.

PTY cleanup timeout is a failure, not successful shutdown. Do not destroy the
window, clear persisted sessions, or infer that a pending close operation was
cancelled. Retry and failure UI must respect an existing in-flight cleanup;
avoid creating duplicate destructive actions. Background routes skip closing.

Log static stage, elapsed milliseconds, outcome and numeric counts. Timeout
or failure wording uses existing domain-local locale resources. Keep the
progress state recoverable for a user retry/cancel after an actual failure.

### 2. Blocking Work Isolation

Keep diagnostic IPC names, argument shape and error handling stable. Dispatch
normal marker/crash writes onto bounded or single-flight blocking work; do not
spawn an unbounded worker on every breadcrumb. Preserve immediate panic and
emergency writes, marker freshness, source bounds and process-role separation.

For the affected terminal commands, obtain an owned client before executing
blocking operations on spawn_blocking. Never hold a bridge/recovery lock across
network waits. Retain finite request timeouts and October 24 disconnected-client
invalidation. Merely adding async to a function is not sufficient.

Prefer the existing bridge and worker mechanisms. Explicitly check reconcile,
status, session listing, shutdown and force-shutdown callers before touching
them. Unrelated providers/SSH/history requests are discovery entries, not an
automatic expansion of this task into a full daemon rewrite.

### 3. Native Memory Evidence

Use the existing crash heartbeat for sampling, not a new frontend polling loop.
Add a small infrastructure diagnostics module, with Windows-only implementation
and a safe unsupported result elsewhere. Bound record size and frequency.

Use the existing windows-sys crate for GetPerformanceInfo and, if necessary,
GetProcessMemoryInfo. Its Win32_System_ProcessStatus feature may need enabling:
this adds bindings to an existing dependency, not a new package or schema.
Prefer true system commit total/limit and available bytes over labelling a
MEMORYSTATUSEX process constraint as physical RAM or global capacity.

Record timestamp, sample availability, commit bytes/limit bytes and current
process metrics. Correlate already-identifiable app/daemon/WebView processes
only if their parent identity can be established without command-line reads.
Do not add a global top-process dump. Limit the process count and handle PID
exit/reuse; otherwise report identity unavailable rather than guess ownership.

Persist the bounded sample in native runtime/crash context, including the next
launch's unclean-exit evidence. A failed sampler is best-effort and cannot block
PTY traffic, exit or panic reporting. The sampler does not cure OOM and does not
automatically disable rendering or modify pagefile settings.

## Discovery List

| Touchpoint | Disposition |
| --- | --- |
| src/app/App.tsx close sync, runExitCleanup, tray/window guards | Modify wiring; preserve task guards |
| src/features/sync/api/syncStore.ts load/outbox/close backup | Inspect delayed effects; preserve persistence semantics |
| src/features/terminal/api/sessionSnapshotPersistence.ts | Modify cancellation/deadline ownership and diagnostics |
| src/features/terminal/hooks/useXTermController.ts | Verify write barrier, registration, checkpoint, disposal |
| src/features/terminal/api/terminalExitCleanup.ts | Bound required cleanup and preserve truthful result |
| src/features/terminal/api/sessionStore.ts | Inspect save ordering; do not change store schema |
| src/features/terminal/transport/PtyHostSocket.ts | Verify existing timeout/reconnect and late-frame isolation |
| src-tauri/src/features/terminal/commands.rs | Isolate affected blocking command work |
| src-tauri/src/infrastructure/daemon/client.rs | Existing reconnect baseline; verify rather than duplicate |
| src-tauri/src/infrastructure/diagnostics/crash_reporter.rs | Isolate normal I/O and integrate bounded native samples |
| src-tauri/src/infrastructure/diagnostics/log_rotation.rs | Reuse rolling writer and privacy/retention rules |
| src-tauri/src/features/system/resources.rs | Physical-RAM UI is not commit evidence; no broad rewrite |
| src/shared/platform/logger.ts, resourceDiagnosticsLog.ts | Preserve payload bounds and existing IPC contracts |
| src/shared/i18n/messages app/terminal domains | Add only required bilingual failure/progress text |
| PTY process spawning, raw input, SSH agent wire protocol | Confirm unrelated; no automatic replay or spawn-flag changes |
| package/version, installer and updater configuration | No version bump/install replacement in this task |
| CHANGELOG.md, docs/功能清单.md | Update for actual delivered code with TEMP |

## Scenario Matrix

- Window close/confirmation/tray exit; repeated close during cleanup.
- Ask/background/minimize/discard; running/finished/unknown daemon tasks.
- Normal/minimized/tray and focused/unfocused windows; deep split panes.
- Single/many terminals, Workspan switches, source replacement/disposal.
- PowerShell/CMD/Pwsh, WSL and SSH; hook installed/absent/partially installed.
- Main/linked/missing Worktree; recovery data must remain intact on failure.
- Healthy/stalled/disconnected daemon; WebView callback never runs or is late.
- Slow settings/store/checkpoint, failed disk writes and low commit capacity.
- Release/dev coexistence, app/daemon marker separation, non-Windows builds.

## Validation and Rollback

Use synthetic dependencies and fake clocks, never real OOM pressure or user
process termination. Required checks are in implement.md. Full GUI-hang
reproduction and installed-app smoke remain separate acceptance evidence.

Each code batch is independently reversible through a reviewed diff; do not
revert unrelated user work. No migration or data cleanup is part of rollback.
Build/install replacement remains an explicit follow-up approval boundary.
