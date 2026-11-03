# Development startup feedback, 2026-11-01

## Triage and root boundary

Root-cause repair: startup ordering and child-process lifecycle cross asynchronous process/pipe boundaries. The launcher must prepare cold helper builds before Tauri's finite frontend readiness wait and use child exit, not inherited-pipe closure, as its process-liveness boundary.

User symptom: helper compilation finishes after about 14 minutes, Vite prints `http://127.0.0.1:1420/`, but no desktop startup follows. The original Tauri exit status was not preserved; a historical readiness timeout is plausible, not proven.

## Evidence and hypotheses

Ranked predictions used to distinguish the boundaries:

1. Tauri exits during helper compilation: Vite eventually listens while no Tauri/Cargo/GUI development process remains. Moving helper compilation ahead of Tauri removes that timing dependency.
2. The wrapper waits for inherited output pipes rather than the live CLI: an exited synthetic child with open stdout/stderr never resolves in the original runner. This was reproduced before repair.
3. Vite remains unavailable or port-conflicted: a direct homepage probe should fail or return another application. Current evidence rules this out for the observed live server.

Read-only observations (same processes reconfirmed before documentation):

- Existing outer npm PID 49752 and launcher PID 45572 started at 18:14:22; the actual Tauri child is absent.
- Existing Vite PID 51948 started at 18:19:21 and listens on `127.0.0.1:1420`; the homepage returned HTTP 200, 731 bytes, in 374 ms.
- No development GUI or Cargo/rustc compiler is running. Installed GUI PID 36912 and daemon PID 16512 still run from the installed application path and were not touched.
- Vite's original process chain is `51948 -> 53068 -> 23584 -> 50596 -> 18696`; PID 18696 is absent. Intermediate npm/shell processes can retain the server after the Tauri process departs.
- A mixed PowerShell table initially hid port fields; the earlier absent-listener interpretation was corrected after separate port/process output.

## Discovery and impact

GitNexus tool discovery exposes no GitNexus tools. CodeGraph exploration and direct entry/caller inspection are the fallback; no high-risk runtime protocol changes are involved.

| Touchpoint | Status and impact |
| --- | --- |
| `scripts/tauri-cli.mjs`: `main`/`runTauri` | Modified: startup helper preflight, bounded output tail, child exit/pipe-close distinction. Affects development launch and shared build error handling. |
| `buildWindowsDevProxy` | Inspected, unchanged: main/proxy build remains first with existing feature/config/target/profile fingerprint inputs and locked-binary recovery. |
| `prepare-helper-binaries.mjs`: helper builder/root | Inspected, implementation unchanged: reused by launcher; existing dev-server/bundle callers retain behavior. |
| `scripts/dev-server.mjs` | Inspected, unchanged: standalone Vite still builds helpers; the Tauri path reuses Cargo cache. Existing server reuse/watch behavior remains. |
| `tauri.dev.conf.json`/`tauri.conf.json` | Inspected, unchanged: no wait override, new environment configuration or dependency. |
| `tauriCliDevProxy.test.mjs` | Updated: production CLI ordering and helper-failure regression; all Cargo work is synthetic, isolated under a named temporary root. |
| `tauriChildLifecycle.test.mjs` | Added: extracts the actual production runner initializer via TypeScript AST, not a duplicate implementation. |
| `tauri-build-local.test.mjs` | Existing shared-build regression selected for compatibility checks. |
| Installed application/daemon and current Vite | Confirmed outside modification scope; no stop/restart or binary replacement. |

## Scenario matrix

| Scenario | Required behavior |
| --- | --- |
| Windows dev, cold helpers | Main/proxy and debug helpers finish before Tauri starts its readiness wait. |
| Windows dev, cached helpers | Cargo verifies/reuses artifacts; no clean or forced rebuild. |
| Helper prebuild failure | Explain failure and do not spawn Tauri. |
| Standalone `npm run dev` or reused Vite | Preserve existing build checks/reuse; do not stop an existing server. |
| Normal CLI close | Drain final stderr, settle promptly and preserve locked-binary recovery. |
| CLI exit, inherited descendant pipes | Report failure code/signal; allow 250 ms drain, destroy only wrapper-owned streams, settle without waiting forever. |
| Long-lived healthy dev child | No startup timer while the child lives; forward full console output, retain only a 64 Ki-character diagnostic tail. |
| Build/non-Windows invocation | No Windows debug helper preflight; shared lifecycle runner keeps completion/error semantics. |
| Installed GUI/daemon already running | No task-created process termination or installation mutation. |

Window focus, split panes, WSL/SSH sessions, worktrees and hook installation do not affect this pre-GUI launcher boundary; runtime behavior is unchanged.

## Regression-first evidence

- The inherited-pipe test failed against the original production `runTauri`: child exit did not settle before its 1200 ms deadline. It passes after the lifecycle repair.
- The launcher ordering assertion failed before helper preflight was added. It now requires main/proxy build -> helper build -> Tauri and passes.
- Four lifecycle tests cover inherited pipes, final stderr for locked-binary recovery, signal failure and bounded diagnostic output; the existing proxy test also covers prebuild failure, config/target/profile forwarding and lock recovery.
- The Windows CLI mock preloads a temporary hook replacing only synchronous `cargo` spawning, uses synthetic helper binaries and temporary `CARGO_TARGET_DIR`, and verifies its named absolute cleanup root. No actual compiler or repository binary writes occur in these regressions.

## Documentation and acceptance limits

Context7 source references confirm `beforeDevCommand` defaults to background execution (`wait: false`) and Tauri's frontend readiness phase:

- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/dev.rs
- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/config.rs

Local CLI package is 2.10.1. The exact-version numeric readiness timeout was not verified; do not treat an earlier approximately 180-second statement as measured evidence. The repair removes cold helper compilation from this wait instead of changing timeout settings.

Final script checks are recorded in `verification.md`. No new desktop window was launched; the existing launcher has already loaded the old script and cannot hot-reload this repair. The user must stop the original development command with Ctrl+C and rerun `npm run tauri dev`. Existing installed GUI/daemon and user-owned Vite remain untouched. No installation, release, dependency, schema or persistent environment change is part of this slice.
