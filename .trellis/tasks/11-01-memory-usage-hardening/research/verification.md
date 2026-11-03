# Verification evidence

## Development startup feedback, 2026-11-01

- Read-only branch recheck: `master` at 13df26a2, upstream difference 0/0. Existing hardening changes preserved. Current launcher/Vite and installed application processes are user-owned; none was stopped or restarted.
- The original production runner failed its inherited-pipe/child-exit regression; launcher ordering also failed before helper preflight. Root boundaries, discovery and scenarios are in `dev-startup.md`; historical Tauri timeout remains inferred because the original exit status was not preserved.
- Final `node --check scripts/tauri-cli.mjs` passed. `node --test scripts/tauriChildLifecycle.test.mjs scripts/tauri-build-local.test.mjs` passed all 10 tests; `npm run test:tauri-dev-proxy` passed all existing/new assertions. The combined command exited 0 in 9.28 seconds, using synthetic Cargo/helper fixtures rather than a real build.
- Independent `npm run check:architecture` passed (session 78864 exited 0); `npm run check:architecture -- --strict` passed and exited 0. Both report 1481 source files, zero files above 2000 lines and zero violations. The architecture PID 51852 was confirmed absent afterward.
- The comment verifier now includes modified `.mjs` scripts and reports all existing comments retained in 47 tracked source/test files. `git diff --check` passed. Existing LF/CRLF conversion warnings were not repaired by a whole-repository formatting change.
- No Rust/frontend source changed in this feedback slice, so no additional long compiler/production build was started. The earlier 149 Node/83 Rust and production-build evidence belongs to the earlier source batch, not these new launcher tests.
- No desktop window startup was verified. The current user-owned launcher already loaded the old source; Ctrl+C in the original terminal followed by `npm run tauri dev` is required to exercise the repaired launch path. No installer, dependency, schema, persistent environment or Tauri config changes.
- Background inventory: current slice created no GUI, Vite/server, monitor or agent; all tool sessions exited, including 78864. Earlier process/CodeGraph/test sessions 87419, 24846 and 38136 also exited. The pre-existing native evidence agent is completed. No task-created background worker remains; installed PIDs 36912/16512 and user-owned dev PIDs 49752/45572/51948 were left unchanged.

## Continued implementation, 2026-11-01

- Source implementation now includes protected terminal WebGL residency (30s default/10s low memory), hidden editor model-preserving release, root/host-isolated model LRU (8 MiB/12), and reloadable clean file contents (32 MiB/64). Active/dirty/undo/redo/save contents remain protected. Current workspace mirrors share authoritative arrays instead of retaining closed/pre-edit payloads outside accounting; failed/deferred hydration preserves retry and selection ownership.
- Indexed history browsing now uses 160-message SQL pages with page-local parts and deferred tool/diff/detail payloads. Complete adapters protect search/descending/analysis, snapshots, smart titles and remote/legacy sources. Identity/revision/offset checks and generation guards preserve original line/message anchors. The shared v2 reader uses a read transaction to avoid mixed catalog revisions.
- Local snapshot serialization directly limits scrollback to 2000 rows; full checkpoints remain separate, 30-second debt tracked, and forced on handoff/exit. A reproduced race receiving output during serialization was red before output-revision repair and green afterward.
- Snapshot passes freeze their source list and rotate attempted owners, preventing stalled sources from starving healthy terminals across passes. Root/file URI collisions were reproduced through real Monaco URI parsing and fixed with double-encoded root identity. WSL case-distinct location and late public-store hydration regressions failed before the shared root comparer repair and pass afterward; Windows drive roots and SSH semantics are covered.
- Sparse spool seek hints are bounded/coarsened and included in memory accounting; file length/mtime/ordering invalidate hints safely. A standalone production-module test reproduced the block-boundary rescan and passed after seeking the first pending sampled frame. The rebuilt daemon suite passes all 42 tests, including appended/compacted indexed-vs-sequential byte equality, ACK gaps and original lifecycle regressions.
- Final Node command covers 19 scripts / 149 regressions, all passed (`research/final-node-regressions.log`), including the 12 hardening scripts and affected file batch/selection/path/project/WSL/remote consumers. The old batch fixture now loads the real content-residency module instead of failing at a missing test dependency.
- Final production `npm run build` after the WSL comparer change exited 0 (session 18082); TypeScript and Vite completed, the Vite stage took 3m 9s (`research/final-frontend-build.log`). Existing WorktreeFinishDialog mixed-import and oversized App-chunk warnings remain, not suppressed.
- Final Rust regression rerun passes 83 tests: 42 daemon, 34 history catalog, 1 bounded reader, 1 managed patch and 5 resources (`research/final-rust-regressions.log`). The latest all-target `cargo check --all-targets --jobs 1` previously exited 0; no Rust source changes followed it. Final combined scope: 149 Node + 83 Rust, 232 passed; no full-suite claim.
- Ordinary and strict architecture checks passed on 1480 source files, zero above 2000 lines and zero new violations. Comment preservation passed for 41 modified tracked source/test files; `git diff --check` passed. An initial comment-check false positive came from treating regex bodies as comments; the verifier now uses AST regex locations to rescan slash tokens, without changing any existing source comments.
- Initial continuation compiler errors: missing Tauri command macro through re-export (fixed owner-qualified registry); pre-existing `web_listener` fixture missing `trusted_network` (added safe false default). These are not installed crash-clearance evidence.
- The original first-batch evidence below is retained chronologically. Its cold-residency/pagination pending statements are superseded by this source phase. All planned source slices and cross-layer checks are complete; remaining acceptance is installed GUI/language/long-run behavior, not unimplemented source repairs.

### Continued runtime limits

No installation replacement, new GUI, source transcript/body/secret/dump reads, real OOM/disk-full, dependency/schema change, commit, push, release or new agent. Cache budgets do not cap protected drafts/undo/terminal buffers or every native/temporary allocation. Indexed page count is not a byte cap on one message; loaded pages are not evicted until selection changes, and explicit complete/legacy/remote operations retain whole-detail semantics. Spool uses a sparse index, not a segmented format; attach still returns bounded complete replay. Installed crash clearance, language switching and measured long-run memory reduction remain unverified.

Baseline: master 13df26a2, upstream difference 0/0. Existing untracked docs/analysis preserved. No new GUI, install replacement, migration, dependency, commit, release or sub-agent.

## Regression loop

- Replay public store: thirty-session retention failed before cache ownership repair; eager sixteen-file hydration failed before metadata-only mapping; delayed old session selection failed before generation ownership. All eleven replay/shared inventory/capability Node regressions pass, including byte/LRU budgets, two-reader single-flight, visible rejection/retry and last-good inventory.
- First Rust attempt failed to compile because a function re-export did not expose the Tauri command macro. Registry now addresses the actual public module; the next run compiled and the spool-unavailable regression failed on the original unlimited RAM path.
- Repaired daemon service regression: 39 passed, 0 failed (1581 unrelated tests filtered), including bounded spool fault/recovery, amortized compaction/sequence, shared checkpoint quota, ACK gap, attach barrier and control-plane ownership.
- Same freshly compiled Rust test executable: bounded actual reader 1 passed; managed two-MiB patch/root/extension/oversize reader 1 passed; existing resource options/cache helpers 5 passed.
- TypeScript direct local compiler exited 0; independent ordinary and strict architecture checks exited 0, zero files above 2000 lines.
- Rust all-target `cargo check --jobs 1`: exited 0; the first check exposed one test-only constant import warning. After `cfg(test)` import scoping, the final check exited 0 without warnings (21.33 seconds). Final behavior regressions total 57 (46 Rust, 11 Node); no full-suite claim.
- Existing comments retained in all 18 modified source files (TypeScript scanner and Rust comment-line subsequence check); `git diff --check` and inline task context validation passed. Final frontend changes after type checking were indentation only.

## Scope and limits

- Patch/event/capability budgets count retained data conservatively, not total WebView heap. Ring/checkpoint quotas do not include every native transport/base64/temporary allocation.
- Spool now uses hysteresis and sequence-filtered bounded payload reads; it still scans headers and attach still builds a full bounded replay. Segmented storage/indexing is not claimed complete.
- No measured installed-version memory reduction or crash clearance. No real OOM/disk-full, user history/body/terminal content reads, heap/dump inspection, GUI language switching or long-run acceptance.
- Sampling off-thread/bounded permit has compile/source evidence and existing options/cache tests, not an installed UI stall comparison or cancellation fault test.
- Cold xterm/editor residency and large history detail pagination are separate planning children. Local synchronous full-checkpoint serialization remains pending. The parent must stay in_progress.

## Background lifecycle

Continuation sessions 40882 (previous build), 18082 (final build), and 24076 (architecture pass followed by comment-verifier false positive) all exited. The comment/diff recheck and 149 Node / 83 Rust runs completed synchronously. No GUI, development server, monitor, service or sub-agent was created in this continuation. Final read-only process inventory confirms tracked build PIDs 22140/31880/38792 are absent; the existing native evidence agent is completed. No task-created background work remains; unknown/user-owned processes were not terminated.

Completed/failed sessions: 30363 (type check pass), 6270 (registry compile failure), 65269 (intentional red spool test), 26358 (daemon regressions pass), 50309 (final type check pass), 33759 (ordinary/strict architecture pass), 20762 (compile pass with import warning), 77324 (warning-free compile pass). All exited. No persistent dev server or monitor created; final process/agent inventory confirms no task-created worker remains.
