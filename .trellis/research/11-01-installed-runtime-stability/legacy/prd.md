# Installed Runtime Stability

## Goal

Prevent confirmed unbounded exit waits and avoid blocking UI/runtime threads
with diagnostic or daemon I/O. Obtain bounded native memory evidence when a
WebView failure bypasses frontend error handlers. Preserve active tasks,
session recovery and existing daemon reconnect behavior.

## Requirements

1. Exit preparation must settle within documented budgets, including settings
   loading, terminal write barriers, checkpoint acknowledgments and cleanup.
   An unresponsive dependency must not leave the progress overlay indefinitely.
2. Distinguish completed, failed and timed-out exit stages. Do not report
   success, clear recovery data, or destroy the window when required task
   cleanup remains unconfirmed. Preserve the last successful snapshots.
3. Background continuation and tray minimization must never close live PTYs.
   Unknown daemon status must not be interpreted as an empty session list.
4. Diagnostic disk writes and synchronous daemon control waits must not run
   directly on the GUI thread or occupy an async worker for their duration.
5. Native diagnostics must record bounded numeric Windows commit-memory
   evidence and distinguish app/daemon roles even if JavaScript stops running.
6. Keep historical unclean-exit records distinct from confirmed crashes.
   Do not claim the historical GUI hang has been reproduced, or that memory
   leakage has been identified, without matching evidence.
7. Reuse the October 24 daemon recovery implementation; validate it rather
   than duplicating reconnect or process-management logic.
8. Keep user-facing failures actionable and localized in zh-CN/en-US, using
   existing language and 24-hour time conventions.

## Constraints

- Changelog version: TEMP, because no release version was supplied.
- No new dependency package, database migration, PTY wire change, automatic
  dependency upgrade, global formatting, or deletion of existing comments.
- Any required additional Windows feature on the existing windows-sys crate
  must be explained in the reviewed design before editing Cargo.toml.
- No automatic GPU disabling or scrollback reduction as an assumed OOM fix.
- No secrets, user input, terminal/file contents, command lines or dump memory
  in diagnostics. Use typed numeric fields and bounded process identity.
- Do not terminate the user's running GUI/daemon or replace the installation.
- No commit, push, release or production deployment without explicit approval.

## Acceptance Criteria

- [ ] Controlled stalled settings loading does not escape the close-sync
      deadline or start a backup after that close attempt has timed out.
- [ ] A write callback or checkpoint that never resolves cannot block other
      sources or leave flushInFlight permanently occupied.
- [ ] A late callback from a timed-out/replaced source cannot overwrite newer
      snapshots, publish a false success, or create an unhandled rejection.
- [ ] Existing 2000-line persisted tails, keyboard/mouse state prefixes,
      complete daemon checkpoints and single-flight semantics remain intact.
- [ ] Required PTY cleanup timeout/failure keeps recovery data and a usable
      window; background/minimize routes retain tasks without forced shutdown.
- [ ] Exit logs identify stage, elapsed time and outcome without payload data.
- [ ] Diagnostic and daemon blocking work is isolated from GUI/async workers;
      panic emergency writing and graceful marker removal still work.
- [ ] Native Windows commit samples include units, timestamp and availability;
      sampling failure and non-Windows builds do not fabricate zero readings.
- [ ] Targeted regression tests and required cross-layer checks pass; real
      installed-app acceptance is reported separately if not performed.
- [ ] Code delivery updates CHANGELOG.md and the relevant sections of
      docs/功能清单.md, without changing release metadata to TEMP.

## Evidence Boundary

See research/evidence.md. The confirmed WebView OOM, Windows hang reports,
old installed build and source-level waiting defects are separate findings.
Fixing the latter does not prove that all historical OOM/hang causes are gone.
