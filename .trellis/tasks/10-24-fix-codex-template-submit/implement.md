# Execution Plan

- [x] Read branch state, fix triage, terminal input contracts and both template callers.
- [x] Confirm root cause with a non-model `/quit` reproduction in an isolated PTY.
- [x] Record design, discovery list, risk and scenario matrix.
- [x] Register exact-session input targets; implement mode-aware template submission.
- [x] Migrate template panel and command palette without changing physical Enter.
- [x] Add byte/lifecycle/error regression tests and xterm-reference comparisons.
- [x] Run targeted terminal-input tests, desktop/Web/Tap type checks and strict architecture.
- [x] Update versioned changelog, feature inventory and terminal submission contract.
- [x] Rebuild local macOS app and verify ad-hoc signature without stopping live sessions.
- [x] Record results, review final diff and leave changes uncommitted for user acceptance.

## Validation

Run new submission tests first, then codexManualInput, terminalProcessManager,
terminalIme, startupCommandMultiline and related input-lifecycle tests as relevant.
Run `npx tsc --noEmit`, Web/Tap type checks and
`npm run check:architecture -- --strict` independently.
Build with `npm run tauri:build:local -- --bundles app -- --locked`.
Ad-hoc sign the generated app and verify with strict deep codesign validation.

## Review / Authorization

The user requested implementation and rebuilding in addition to approving task
creation. Scope is the two template execution paths and their terminal submission
boundary; no new release version, commit, push or app restart is requested.

## Results (2026-10-24)

- 55 tests passed: submission, manual Codex Enter, process manager, IME
  key guard/dedup/composition and multiline startup commands.
- 44 tests passed: local build wrapper, newline shortcuts, IME anchor,
  WSL image paste and file explorer path actions.
- Desktop, Web and Tap TypeScript checks passed.
- Strict architecture: 1408 source files, no over-limit files or new violations.
- Actual fixed API emitted `/quit` input into a separate Codex 0.164.0 PTY:
  exited on the first submission, with no additional Enter or model prompt.
- Desktop/classic Web/Tap production assets and the Rust release/app bundle built.
  Existing Rust unused-code/import warnings remain; no Rust source changed.
- Generated app: `src-tauri/target/local/release/bundle/macos/CLI-Manager.app`.
  App version stays 1.4.4. Ad-hoc signing and strict deep signature verification passed.
- Build log: `<tmp-log>`.
- Final diff/whitespace reviewed; no dependency, lockfile or user-session changes.
  Current GUI and daemon processes were intentionally left running.
- Both new message dictionaries validated by tests and type checks. Manual
  zh-CN/en-US GUI switching and real template-button acceptance remain for the
  rebuilt application's next launch. Native Windows/WSL/SSH acceptance is not
  claimed; their mode/framing behavior is covered by protocol-level tests only.

## User-Requested Launch

- Rebuilt again on 2026-10-24; build log:
  `<tmp-log>`.
- Copied the generated bundle to
  `src-tauri/target/local/release/bundle/macos/CLI-Manager 修复测试版.app`;
  changed only that generated copy's display/bundle name and re-signed it.
  Strict deep signature verification passed. Source product name/version unchanged.
- Opened this exact app path and verified its running process and native app menu
  identify it as `CLI-Manager 修复测试版`. Finder also revealed the labeled bundle.
- The old `target/release` bundle is 1.3.5; the labeled fix bundle is 1.4.4.
  No old bundle or daemon was deleted or terminated.
- The app reached the restore-last-sessions dialog. Left restore/discard to the
  user rather than launching their retained sessions automatically.

## Upstream Submission Gate

The user authorized a commit and upstream PR after addressing the non-Windows
review items. They observed the original bug on both Windows and macOS; this
environment is macOS, so Windows native acceptance cannot be performed here.

- [x] Replace duplicated paste framing with native `terminal.paste()` / `input()`;
  capture synchronous onData only for the programmatic operation and preserve
  the existing single acknowledged write and ordinary keyboard path.
- [x] Cover native paste, disabled stdin, missing onData and ordinary input isolation.
- [x] Re-run focused tests, cross-client type checks, strict architecture and build.
- [x] Verify zh-CN/en-US by switching the running application, then restore language.
- [x] Record exact macOS evidence and the unverified Windows boundary.
- [ ] Review/stage only this task, commit on a `codex/` branch, push to the fork
  and open/attach an upstream PR. Do not claim Windows native regression coverage.
