# SSH Agent Integration Phase Progress

This is the single execution tracker for the task. Research, product requirements, design, scenario coverage, implementation order, and test strategy remain in this same task directory. A phase advances only after its focused checks pass; dependent phases run broader regression checks again.

| Order | Phase | Status | Focused verification |
|---|---|---|---|
| S01 | Config roots and launch injection | completed | migration, TS type-check, SSH launch Rust tests |
| S02 | Shared transport and Agent probe | completed | transport parity, probe/error classification, protocol tests |
| S03 | Agent install supply chain | completed | signature/hash/target/install/rollback tests |
| S04 | Remote Hook lifecycle | completed | adapter merge, ownership, atomicity, spool tests |
| S05 | Reusable Agent bridge runtime | completed | one-bridge invariant, reconnect, cancellation, shutdown tests |
| S06 | Remote history indexing and cache | completed | parser/index/catalog/cursor/offline tests |
| S07 | Remote session resume | completed | preflight/ownership/cwd/config-root routing tests |
| S08 | Read-only remote file panel | completed | confinement/read limits/provider routing tests |
| S09 | Read-only remote Git panel | completed | porcelain/diff/repo identity/read-only boundary tests |
| S10 | Stats, docs, security and release verification | completed | stats/performance/security/i18n/docs/full regression |

## Phase Checklists

### S01 Config roots and launch injection

- [x] Add migration and types for Host preferences, project override, installations, and per-root integrations.
- [x] Add per-Host Claude/Codex config-root UI and optional SSH project override.
- [x] Resolve project override -> Host preference -> native default for every common SSH launch path.
- [x] Validate and safely expand absolute POSIX, `~`, and `~/...` roots at the Rust boundary.
- [x] Preserve remote integration identity when a Host is locally deleted.
- [x] Pass TypeScript, focused SSH launch tests, migration test, and full Rust library regression.
- [x] Update SSH contract, `[TEMP]` changelog, and feature inventory for delivered behavior.

### S02 Shared transport and Agent probe

- [x] Extract shared `SshTransportSpec` for interactive PTY and non-interactive one-shot launches.
- [x] Preserve SSH Config, Agent, identity-file, credential-reference, ProxyJump, proxy, AskPass, timeout, and Host Key parameters.
- [x] Add explicit per-Host Agent probe with bounded banner/stdout/stderr parsing and stable error classes.
- [x] Persist sanitized version/protocol/target/path/status metadata without credentials or remote output.
- [x] Add bilingual probe status and diagnostics without automatic connection on page open.
- [x] Add focused transport, probe parser, banner limit, path, protocol mismatch, and Agent target tests.
- [x] Pass full TypeScript and Rust regression after task consolidation.
- [x] Update executable SSH Agent contract and delivered-behavior documentation.
- [x] Complete repeated review/fix cycles until the final review has no findings.
- [x] Commit S02 independently (`feat(ssh): add agent transport and probe`).

#### S02 Review Log

1. Review 1 found truncated frame headers treated as clean EOF and an optional bridge protocol. Fixed strict partial-header errors and required `--protocol`; Agent tests passed.
2. Review 2 found a dead `target()` wrapper after transport extraction. Removed it and restored warning-free `cargo check`.
3. Review 3 found `doctor` could exit before reporting `unsupported_target` when HOME was unavailable. Made status/doctor always structured and prevented failed doctor diagnostics from being marked usable.
4. Review 4 found no further issues. Final evidence: `npx tsc --noEmit`; desktop `cargo check`; desktop library tests `551 passed, 1 ignored`; Agent tests `10 passed`; CLI doctor smoke returned structured JSON.

### S03 Agent install supply chain

- [x] Add explicit per-Host preview, SSH stdin upload install/upgrade, rollback, uninstall, custom root, discovery metadata, and bilingual diagnostics.
- [x] Add Agent-owned install locking, staged self-check, version directories, atomic `current/previous` and launcher switching, corrupt-record recovery, downgrade protection, rollback, and transactional uninstall.
- [x] Add one signed manifest for desktop and POSIX script installation, reuse the Tauri updater Minisign trust root, and enforce HTTPS/default plus explicit signed HTTP mirror policy.
- [x] Add Linux x64/aarch64 release artifacts, size/SHA-256/target/protocol verification, manifest generation, release upload, and path-scoped Ubuntu Agent CI.
- [x] Add HTTP(S) installer dry-run/custom-root/downgrade/uninstall options without modifying Hook configuration.
- [x] Pass TypeScript, desktop Rust, Agent host tests, Linux x64/aarch64 all-target checks, POSIX installer smoke, manifest smoke, migration tests, and diff checks.
- [x] Update README, `[TEMP]` changelog, feature inventory, and executable SSH Agent contract.
- [x] Complete repeated review/fix cycles until the final review has no findings.

#### S03 Review Log

1. Review 1 found custom-root upgrades did not automatically reuse the discovery record, corrupt records permanently blocked repair, missing records could bypass downgrade checks, signed URLs accepted query/fragment ambiguity, and the script lacked strict download bounds. Fixed the shared install and URL-policy roots.
2. Review 2 found remote operation JSON was parsed but not contract-validated, and uninstall could leave partial state after a mid-operation failure. Added strict marker/action/identity/version/protocol/path/source/hash validation and a quarantine/restore uninstall transaction.
3. Review 3 found successful script installation bypassed temporary cleanup via `exec`, staged self-check omitted `doctor --self`, same-version reinstall produced false previous metadata, and public keys could drift across updater/desktop/script. Fixed cleanup and version semantics, added POSIX smoke coverage, centralized the public key, and made release generation verify all trust-root copies.
4. Review 4 found no further S03 issues. Final evidence: `npx tsc --noEmit`; desktop `cargo check`; desktop library tests `561 passed, 1 ignored` after one unrelated AskPass socket flake passed three focused reruns and the full rerun; Agent host tests `14 passed`; Linux x64/aarch64 `cargo check --all-targets`; POSIX installer smoke; manifest/key-consistency smoke; `git diff --check`.

### S04 Remote Hook lifecycle

- [x] Implement Claude/Codex discovery, preview, install, upgrade, uninstall, and conflict diagnostics.
- [x] Preserve third-party configuration and remove only CLI-Manager-owned entries.
- [x] Implement bounded one-shot Hook IPC/spool behavior and lifecycle tests.

#### S04 Root-Cause And Discovery Record

- GitNexus was unavailable in this session. Discovery used the SSH Agent/Hook/terminal contracts plus `rg` call-site tracing before edits.
- Agent touchpoints checked: shared Hook schema, Claude/Codex structural adapters, root/symlink resolution, ownership matching, lock/journal transaction, installation records, one-shot runtime, spool namespace/limits/ACK, and bridge protocol.
- Desktop touchpoints checked: strict Hook report validation, SSH launch binding, daemon session ownership, bridge lifecycle, Hook payload routing, notification redaction, Replay routing, integration persistence, settings UI, and i18n.
- Confirmed unrelated/local-only: local/WSL Hook transport remains on the loopback path; remote cwd/transcript refs do not enter local history, transcript, filesystem, Git, snapshot, or provider APIs; SSH provider launch parameters remain discarded in both frontend and Rust.
- Root cause 1: spool/socket identity omitted `hostId` while bridge ownership was per SSH Host, so duplicate Host profiles for one Agent installation collided. The namespace now binds Host/client/installation on both Hook and hello paths.
- Root cause 2: canonical-root status mirroring copied one row's configured root into sibling Host/project rows, making the sibling UI state disappear. Mirrored reports now preserve each row's own configured root.
- Root cause 3: PTY launch treated Agent installation as sufficient for Hook delivery, creating an unnecessary SSH bridge before Hook installation. Bridge identity is now injected only for an effective root with validated `installed` Hook state and matching Agent/machine identity.
- Root cause 4: strict desktop validation accepted a duplicate Codex installation-record file in place of the second required file. Record file identity is now unique and must equal the complete report file set.
- Crash recovery remains fail-safe: a process crash can leave a stale Agent-owned installation record that blocks Agent removal, but it cannot overwrite user config; explicit Hook uninstall removes the stale record. Generic bounded preamble/hello timeout, heartbeat, cancellation, and idle lifecycle remain explicitly owned by S05.

#### S04 Review Log

1. Review 1 found retained-root symlink cleanup could follow a retargeted configured path, Hook spool gap bytes were outside quota accounting, SSH provider arguments survived at one backend boundary, and remote Hook Replay could call local Git snapshot logic. Added canonical identity cleanup, hard byte accounting, Rust provider isolation, and remote-path refusal.
2. Review 2 found config-root TOCTOU gaps, stale retained-root actions, bridge identity missing KeepAlive settings, stale bilingual delivery text, and incomplete HTTP(S)/explicit-Hook documentation. Fixed the shared boundaries and reran focused tests.
3. Review 3 found duplicate SSH Host profiles collided on one Agent socket/spool namespace, sibling integration rows overwrote configured roots, duplicate installation-record files passed strict validation, and Agent-only terminals created unnecessary Hook bridges. Fixed all four root causes and added focused regressions where a runnable harness exists.
4. Review 4 found no further S04 correctness, security, provider-isolation, remote-path, ownership, or documentation issues. S05 retains the generic reusable bridge timeout/heartbeat/cancellation work by design.

Final evidence: Agent `cargo fmt --check`; Agent tests `29 passed`; Agent Clippy with `-D warnings`; Linux x64/aarch64 Agent `cargo check --all-targets`; touched desktop Rust `rustfmt --check --config skip_children=true`; desktop `cargo check`; desktop tests `570 passed, 1 ignored`; `npx tsc --noEmit`; `git diff --check`. A repo-wide desktop Clippy attempt remains non-green with 75 accumulated crate-wide style warnings, including unrelated modules and Tauri command argument-count lints, so it is not used as the S04 gate.

### S05 Reusable Agent bridge runtime

- [x] Maintain at most one reusable bridge per Host/client while PTYs remain independent.
- [x] Implement framing, capabilities, bounded preamble/hello handshake timeout, heartbeat, cancellation, backpressure, reconnect, and shutdown.
- [x] Verify connection counts, multi-window ownership, banner contamination, and authentication-required behavior.

#### S05 Root-Cause And Discovery Record

- GitNexus remained unavailable. Contract + `rg` tracing confirmed `SshAgentBridgeManager` is owned only by the daemon session create/close path, while Agent `run_bridge/handle_frame` is owned only by `bridge --stdio` and protocol tests.
- Root cause 1: bridge stdout was read synchronously without a deadline, so a stuck preamble/hello could hold one of the two global connect permits indefinitely. A bounded reader thread and 32-frame sync queue now give preamble, hello, Hook drain, ACK, and heartbeat explicit receive deadlines.
- Root cause 2: only concurrent connection attempts were limited; established bridges were unbounded. A lifetime permit now caps active/waiting bridge processes at four while the existing reconnect gate remains two.
- Root cause 3: `bridge_already_active` was treated as permanent, so a replacement bridge could lose takeover during the old socket cleanup window. It now follows bounded jittered retry; permanent identity/protocol/authentication/Host Key failures still stop.
- Root cause 4: bridge replacement and release killed/waited for SSH children while holding the global Host registry lock. Registration/removal is now atomic, then child shutdown happens after the map lock is released.
- Root cause 5: bridge stderr was discarded, making `Permission denied`, passphrase/MFA, and Host Key failures indistinguishable from transient disconnects. The daemon drains all stderr, keeps at most 8 KiB in memory for classification, and logs only stable codes.
- Root cause 6: spool drain and ACK loaded the complete file into memory for every batch. Both paths now stream bounded records; malformed/oversized records fail closed and ACK cleanup removes temporary files without replacing the original spool.
- Boundary confirmation: protocol 1.1 adds only heartbeat/cancellation/backpressure and Hook delivery guards. No history/file/Git/provider RPC or remote path routing was introduced in S05; PTY processes remain independent and last-session release stops only the Host bridge.

#### S05 Review Log

1. Review 1 added the bounded reader, hard handshake/response timeouts, heartbeat, global bridge/connect permits, stable-period retry reset, +/-20% Host jitter, bounded cancellation registry, and last-session process reaping.
2. Review 2 found transient socket takeover was incorrectly permanent and consumed cancellation IDs remained in eviction order. Fixed both and added regressions.
3. Review 3 found malformed remote error/batch/ACK data could inflate logs or advance the cursor, and spool replay still allocated the full backlog. Added strict short-code, monotonic sequence/latest/ACK validation and streaming spool I/O.
4. Review 4 found child shutdown under the registry lock, a spawn/stop race, and discarded authentication/Host Key stderr. Moved process waits outside the map lock, closed the race, added bounded sanitized classification, and found no further S05 issues.

Final evidence: Agent protocol minor `1.1`; Agent `cargo fmt --check`; Agent tests `33 passed`; Agent Clippy with `-D warnings`; Linux x64/aarch64 Agent `cargo check --all-targets`; touched desktop Rust `rustfmt --check --config skip_children=true`; desktop `cargo check`; focused bridge tests `11 passed`; focused Agent probe tests `6 passed`; desktop full tests `584 passed, 1 ignored`; `npx tsc --noEmit`; `git diff --check`.

### S06 Remote history indexing and cache

- [x] Implement incremental Claude/Codex adapters and the shared single-writer remote index.
- [x] Register scoped remote source instances in the existing history catalog.
- [x] Implement list/search/detail/diff/usage, freshness, stale/offline, cursor, rotate, and tombstone behavior.

#### S06 Root-Cause And Discovery Record

- GitNexus remained unavailable. Contract + `rg` tracing covered Agent history adapters/index ownership, bridge request/chunk framing, desktop identity validation, catalog materialization, frontend list/search/detail routing, and local/WSL isolation.
- Root cause 1: the Agent included its replaceable installation ID in `sourceInstanceId`, so reinstalling the same machine/user/source/config root could fork one logical source. Stable identity now contains only machine, SSH user, source, and canonical config-root hash.
- Root cause 2: writer-lock directory creation and owner initialization were not one transaction. Permission or owner-file failure now removes the incomplete lock before returning the stable error.
- Root cause 3: a JSONL record larger than the 8 MiB read window made no cursor progress. The index now records an oversized-line skip state, advances in bounded windows, and resumes parsing after the next newline.
- Root cause 4: remote open/list/load-more/search/detail requests could commit after the user switched SSH projects. Request generations and consumer identity now invalidate stale results without allowing old `finally` blocks to clear current loading state.
- Confirmed unrelated: local/WSL source discovery and parsing remain on their existing paths; remote paths stay opaque and never enter local file, Git, provider, edit, or delete commands.

#### S06 Review Log

1. Review 1 hardened remote identity reuse, numeric conversion, summary-only catalog cleanup, continuation identity, detail chunk ordering/size/deadline, pagination, and LRU ownership.
2. Review 2 corrected stable source identity and transactional writer-lock cleanup, then added focused regressions.
3. Review 3 found non-progressing oversized JSONL records and duplicate catalog fixtures. Added bounded skip progress and consolidated coverage without reducing assertions.
4. Review 4 found cross-project async state races in remote open, pagination, search, and detail. Added generation/consumer guards; final review found no further S06 correctness, isolation, pagination, or cache-lifetime issues.

Final evidence: history-core tests `4 passed`; Agent tests `48 passed`; Agent Clippy with `-D warnings`; focused bridge tests `15 passed`; focused catalog tests `21 passed`; desktop `cargo check`; desktop library tests `619 passed, 1 ignored`; `npx tsc --noEmit`; `git diff --check`; GitNexus change detection completed with the expected cross-layer S06 scope.

### S07 Remote session resume

- [x] Implement same-machine/user/source/config-root preflight and session ownership checks.
- [x] Route Claude/Codex native resume into a new interactive SSH PTY.
- [x] Support original remote location when the project is missing but Host identity is valid.

#### S07 Root-Cause And Discovery Record

- GitNexus impact was available for the existing history-store entry points but the index did not yet contain the new resume symbols; contract + `rg` tracing covered History resume UI, terminal launch resolution, daemon Agent requests, Agent history lookup, session persistence, and PTY exit/close cleanup.
- Root cause 1: the local resume flow constructs `cwd + command` for local/WSL sessions and cannot prove remote machine/user/config-root identity. SSH resume now has a dedicated Agent preflight and a Rust-generated POSIX-quoted command.
- Root cause 2: project selection previously used local `project.path` and could show local/WSL or a different remote config root. SSH candidates now require the same Host, source, and effective config-root scope and compare `remote_path` to the verified cwd.
- Root cause 3: a late or duplicate resume could create concurrent tabs for one remote source session. Current-client tabs jump by Host/source-instance/session identity; daemon ownership claims block a different consumer until the resumed PTY exits or closes.
- Root cause 4: resume ownership metadata was initially present only on the new Tab. It is now persisted through daemon attach/recreate and released on exit, error, or explicit close.
- Confirmed unrelated: local/WSL resume command construction, provider args, Worktree selection, and terminal restore behavior remain unchanged; Hook installation is not required for remote resume.

#### S07 Review Log

1. Review 1 added Agent preflight, protocol 1.4 capability negotiation, structured resume args, Rust quoting, same-Host project routing, and original-remote-location launch.
2. Review 2 found SSH Config hosts with an implicit username were falsely rejected and project candidates could override the preflight config root. Made username validation conditional and constrained candidates to the same root scope.
3. Review 3 found cached summaries could outlive deleted JSONL and ownership metadata could be lost across daemon attach. Added source-file readability checks and persisted/released resume identity across terminal lifecycle.
4. Review 4 found no further S07 identity, cwd, source-file, config-root, command quoting, duplicate-tab, ownership, or local/WSL isolation issues.

Final evidence: Agent tests `51 passed`; Agent Clippy with `-D warnings`; focused bridge tests `16 passed`; desktop library tests `620 passed, 1 ignored`; `npx tsc --noEmit`.

### S08 Read-only remote file panel

- [x] Implement Agent-confined lazy tree, bounded filename/content search, UTF-8 text and data-URL image preview, remote path copy, and existing file-editor navigation.
- [x] Hard-reject writes at the store boundary; hide drag, local Explorer/Finder, Git, and write menus for SSH projects.

#### S08 Root-Cause And Discovery Record

- Root cause: the existing file explorer assumed every project path was local and routed tree, preview, search, watcher, Git, and mutation actions directly to local Tauri commands. SSH paths must remain opaque and use an Agent-owned root confinement boundary.
- Discovery: `fileExplorerStore` open/refresh/expand/search/preview and mutation methods; `FileExplorerSidebar` tree/context menus/watcher/external opener; project capability resolution; Agent protocol/bridge allowlist; Tauri SSH file commands; Agent path and size limits.
- Scenario coverage: online/offline bridge errors, project switching during async open/search, POSIX/Windows absolute root validation, traversal/NUL/CRLF/backslash rejection, symlink escape, binary and oversized files, image data URLs, 500-entry directory and 200-result search caps, local/WSL routing unchanged, SSH writes and local external operations rejected.

#### S08 Review Log

1. Review 1 added remote context routing and store-level read-only guards, then fixed search traversal to count visited files independently from matched results and bumped capability negotiation to protocol `1.5`.
2. Review 2 added Agent security/limit tests and hid SSH watcher, drag, write, Git, and local Explorer actions in the shared file UI.
3. Final evidence: Agent tests `56 passed`; Agent Clippy with `-D warnings`; desktop library tests `620 passed, 1 ignored`; `npx tsc --noEmit`; `git diff --check`.

### S09 Read-only remote Git panel

- [x] Implement protocol 1.6 repository discovery, NUL status, bounded diff, branches, upstream, ahead/behind, and `asOf` snapshots through the Agent bridge.
- [x] Use stable relative repo IDs; fixed Git allowlist disables optional locks, fsmonitor, external diff, textconv, network, credentials, Worktree, and all store/UI mutations.

#### S09 Review Log

1. Added Agent Git RPCs with root/repository confinement, NUL status parsing, bounded diff, branch/upstream data, and timestamped snapshots.
2. Added remote Git bridge commands, provider routing, a read-only Git panel with repository selector and diff viewer, and store-level mutation guards.
3. Final focused evidence: Agent tests `58 passed`; Agent Clippy with `-D warnings`; desktop tests `620 passed, 1 ignored`; `npx tsc --noEmit`; `git diff --check`.

### S10 Stats, docs, security and release verification

- [x] Integrate realtime SSH Tab session stats through a reused Agent history context and remote detail RPC; historical usage reuses the shared remote catalog stats path with stale/offline fallback.
- [x] Verify provider isolation, connection/resource targets, security matrix, and zh-CN/en-US UI paths; SSH stats no longer call local Git or Explorer APIs.
- [x] Update README, `[TEMP]` changelog, feature inventory, Agent contracts, and test evidence.
- [x] Run final change-scope audit and commit/archive the single task.

#### S10 Root-Cause And Discovery Record

- Root cause: terminal statistics used local history, local Git branch, and local Explorer assumptions even when the active session cwd was remote. The fix routes SSH session detail through one reusable Agent history context, keeps catalog stats as the offline source, and disables local-only branch/folder operations.
- Discovery: TerminalStatsPanel session/detail/today-usage/branch hooks; historyStore remote sync/detail/catalog stats; Git store/provider capability routing; shared file/Git panels; protocol version/capability negotiation; bilingual i18n and release docs.
- Review: confirmed remote path values remain opaque references, stats refreshes reuse the same bridge consumer, stale detail preserves the last snapshot on failure, and local/WSL code paths remain unchanged.

## Validation Gates

1. Focused gate: tests closest to the changed module plus formatting for touched Rust files.
2. Boundary gate: frontend-to-Rust payload validation, remote/local routing, credential and path confinement review.
3. Regression gate: `npx tsc --noEmit`, relevant Rust crate tests, and existing SSH tests.
4. Integration gate: dependent shard scenarios, connection-count checks, stale/offline behavior, and bilingual UI review.
5. Release gate: full allowed quality commands, change-scope audit, README/feature inventory/`[TEMP]` changelog review.
