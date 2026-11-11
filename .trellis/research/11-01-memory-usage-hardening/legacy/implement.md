# Implementation plan

- [x] Preserve baseline/report; branch synchronized at 13df26a2; user approved full implementation.
- [x] Read triage, workflow and owning entry points; design/discovery/scenarios recorded.
- [x] Replay public store regressions, bounded event/cache ownership, lazy safe patch read and action errors.
- [x] Resource sampling worker and shared last-good background inventory.
- [x] Daemon storage fault regression, bounded fallback, checkpoint accounting and amortized spool compaction/cursor payload reads.
- [x] Lazy emoji, scoped capability cache and actual text read limit regressions.
- [x] Protected terminal renderer/editor/model/content residency and indexed history pagination with complete-operation/navigation adapters.
- [x] Performance setting discoverability (General -> Performance and Memory).
- [x] Local snapshots directly serialize the 2000-line tail; full daemon checkpoints keep complete state with independent 30-second debt tracking and forced handoff/exit. Output revisions protect serialization races.
- [x] Final scoped tests: 149 Node + 83 Rust passed; production tsc/Vite build, cargo check --all-targets --jobs 1 and ordinary/strict architecture passed. Windows/WSL/SSH location, URI, snapshot debt/fairness and shared history read-transaction boundaries included.
- [x] npm run check:architecture; npm run check:architecture -- --strict.
- [x] Update contracts, CHANGELOG.md TEMP, docs/功能清单.md and verification evidence.
- [ ] Installed application, language switching and controlled long-run acceptance (not source checks).

## Development startup feedback

- [x] Recheck branch, process ownership, port 1420 and startup entry points without reading user command/body data.
- [x] Reproduce child-exit/inherited-pipe wait and incorrect helper/Tauri ordering through production launcher regressions before repair.
- [x] Move Windows debug helper preflight before Tauri; preserve standalone Vite behavior and cached checks.
- [x] Bound diagnostic tail and settle exited children after final-error drain while preserving ordinary close/locked-binary recovery.
- [x] Update TEMP changelog and the development-build feature section; record evidence and limits.
- [x] Finish targeted launcher/local-build, comment, diff and ordinary/strict architecture checks (10 Node tests plus CLI proxy assertions; 1481 source files, zero architecture violations; 47 tracked source/test files retain comments).
- [ ] User restarts the existing development terminal; desktop window startup remains runtime acceptance, not a source-test claim.

Test boundaries: useReplayStore public actions with synthetic DB/IPC, actual bounded-reader API, SessionBuffer sequence/replay API and sampling command scheduler. Reuse existing repository Node/Rust regression seams, one failing behavior then repair per slice. Do not start the full Rust suite or another GUI.
