# Implementation Plan

## Gates

- [x] User approved creation of a Trellis task.
- [x] Read-only branch/upstream check: master/local origin/master 0 ahead, 0 behind.
- [x] Read owning contracts and review current source/evidence.
- [x] Record root-cause statements, discovery list and scenario matrix.
- [x] Create prd.md, design.md, implement.md and research/evidence.md.
- [x] Baseline scoped frontend regression tests: 23 passing tests.
- [x] User reviews the plan and approves implementation (2026-11-01).
- [x] Run task.py start for this task only after that review.

Project Codex mode is inline; no implement/research/check sub-agent dispatch is
authorized by the current project configuration. Trellis brainstorm skill was
not found locally; workflow.md and the owning contracts are the planning source.
GitNexus tools are not exposed; CodeGraph exploration and contracts were used.
Before source edits, attempt required symbol impact analysis and document the
available upstream callers/risk using the project's fallback if unavailable.

## Batch 1: Regression-First Exit Safety

- [x] Find all source/close/snapshot/store callers before editing symbols.
- [x] Add fake-clock regressions that fail on current behavior: settings load
      never completes; load resolves after close timeout; write callback never
      runs; checkpoint never settles; old callback arrives after timeout.
- [x] Include multiple sources, concurrent force requests, dirty output during
      a flush, disposal/replacement, and persisted-store failure cases.
- [x] Add an app-owned exit-stage helper and bounded operation ownership.
- [x] Include settings loading inside the close-sync deadline without losing
      existing outbox persistence or launching delayed backup work.
- [x] Implement snapshot per-attempt cancellation/deadlines, release the flight
      and retain last successful data; do not overlap ordered store writes.
- [x] Bound cleanup with truthful pending/failure results; preserve tasks and
      require confirmation before window destruction/session deletion.
- [x] Add bounded stage logs and bilingual failure/progress text.
- [x] Run targeted tests, then tsc; inspect diff for comment preservation.

## Batch 2: Blocking Boundaries and Daemon Regression

- [x] Recheck current daemon command ownership and affected callers.
- [x] Add deterministic tests for timeout invalidation, async responsiveness
      and shutdown failure without running the user's installed daemon.
- [x] Review reuse of existing serial recovery and command injection; real
      reconnect/process-identity acceptance remains unverified.
- [x] Move affected blocking daemon calls off async workers using owned clients;
      preserve October 24 reconnect/process-identity behavior.
- [x] Isolate normal diagnostic file I/O with bounded/single-flight work.
- [x] Verify panic emergency writes and graceful marker removal independently.
- [x] Add tests for active persistence gates, coalesced context updates, stop,
      legacy markers, release/dev naming and recovered role metadata; do not
      create late markers. Full GUI callback/FS-stall acceptance is separate.
- [x] Run focused Rust tests/check and exit/recovery frontend regressions.

## Batch 3: Native Commit-Memory Evidence

- [x] Confirm API units and Windows binding feature requirements against
      official Windows documentation before implementing the sampler.
- [x] Enable only the explained feature on existing windows-sys if required.
- [x] Add bounded Windows commit/current-process sampling to existing native
      heartbeat; unsupported/error results must not fabricate zero values.
- [x] Preserve typed field limits, log retention and privacy. No command-line,
      environment, terminal, file-content or dump-memory inspection.
- [x] Test numeric conversion, capacity edge cases, unavailable record shape,
      role metadata and legacy marker recovery with synthetic data. Native API
      failure injection and non-Windows target compilation remain unverified.
- [x] Prove diagnostics do not depend on the resource panel or JS polling.

## Final Checks and Delivery

- [x] Run node --test for affected exit, snapshot, task-selection, resource-log
      and remount regression scripts; add new scoped scripts as needed.
- [x] Run npx tsc --noEmit (direct local TypeScript entrypoint).
- [x] Run cargo check --manifest-path src-tauri/Cargo.toml --jobs 1.
- [x] Run focused cargo test filters for diagnostics and daemon control.
      Reassess the historical unrelated Rust test blocker; do not present old
      verification notes as current results.
- [x] Run npm run check:architecture independently.
- [x] Run npm run check:architecture -- --strict.
- [x] Update CHANGELOG.md with a TEMP/2026-11-01 entry and update the correct
      sections of docs/功能清单.md for delivered changes only.
- [x] Review changes, validate task artifacts, and record evidence/limits.
- [x] Assess UI acceptance safety: bilingual/24-hour-time and installed GUI
      smoke are explicitly unverified; do not stop/replace the user's app or
      add another native GUI process during low commit headroom.
- [x] Confirm all created test/background processes have exited. Do not leave
      dev servers running or terminate processes of unknown/user origin.
- [x] No commit/push/release/install replacement. Do not archive or mark this
      task completed while required acceptance remains outstanding.

## Implementation Notes

- Node regression-first evidence covers callback/checkpoint deadlines, late
  callbacks, force-pass coalescing, snapshot suspension and FIFO discard order.
- TCP timeout regression failed with Windows read timeout 10060 before the
  shutdown handle fix, then passed with EOF; a busy writer lock cannot prevent
  disconnection. No installed GUI/daemon was touched by these synthetic tests.
- Source review found that endpoint recovery alone misses a control-only
  failure while output WebSocket stays healthy. Read-only commands now reuse
  ensure_daemon; startup list still waits for initial readiness. No request
  replay or PTY creation is added, and idle shutdown never creates a daemon.
- Architecture/spec updates include exit budgets, persistence FIFO, bounded
  diagnostics, TCP lifetime and native numeric evidence.
- Final command outcomes and acceptance limits belong in
  research/verification.md; do not infer an installed-runtime acceptance from
  unit tests or cargo check.

## Baseline Command Already Run

```powershell
node --test scripts/terminalExitCleanup.test.mjs scripts/terminalSnapshotPersistence.test.mjs scripts/resourceDiagnosticsLog.test.mjs
```

Result: 23 passed, 0 failed; process exited normally. This covers existing
behavior only, not a reproduction of the reported installed-app hang or OOM.
