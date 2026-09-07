# Built-in Live Server Implementation Plan

## 1. Pre-edit Gates

- [x] Confirm `master` is clean and synchronized with `origin/master` (`0 ahead / 0 behind`).
- [x] Create Trellis task after user consent.
- [x] Classify as a complex cross-layer feature.
- [x] Enumerate the project scenario matrix.
- [x] Produce a grep/contracts discovery list because GitNexus MCP/CLI is unavailable.
- [x] Confirm the contribution scope and current changelog section.
- [x] Create `feat/built-in-live-server` and record it in `task.json`.
- [x] Run the required symbol impact checks through the documented fallback report before editing.

## 2. Backend

- [x] Add `mime_guess` and `percent-encoding` direct dependencies.
- [x] Implement pure root/relative/request-path validation and URL encoding helpers.
- [x] Implement loopback static-file routing, headers, Host/method checks, HTML injection, and version endpoint.
- [x] Implement debounced relevant-file watching.
- [x] Implement `LiveServerManager` start/reuse/status/stop/shutdown lifecycle.
- [x] Add thin Tauri commands and register managed state, IPC handlers, and exit shutdown.
- [x] Add focused Rust tests for validation, containment, encoding, injection, reuse, HTTP routing, reload version changes, and shutdown.

## 3. Frontend

- [x] Add typed IPC/opener client.
- [x] Add an injected-client Zustand store with immutable project-state updates and narrow selectors.
- [x] Add reusable HTML/root context-menu items.
- [x] Insert menu items in ordinary file rows, filename search rows, content search rows, and root context menu.
- [x] Add Simplified Chinese and English labels/toasts.
- [x] Confirm SSH/WSL/non-HTML eligibility remains explicit and consistent.

## 4. Documentation

- [x] Add a Live Server section to the backend project-file contract.
- [x] Update `CHANGELOG.md` under the current release section.
- [x] Update `docs/功能清单.md` in the file-browser section.
- [x] Record implementation and verification evidence in the Trellis task.

## 5. Verification

- [x] `cargo fmt --all -- --check`
- [x] Focused Rust tests with a hard 60-second execution timeout.
- [x] Project-local `tsc --noEmit`.
- [x] `npm run build`
- [x] `cargo check`
- [x] `npm run tauri:build:local`.
- [x] Grep for all context-menu and i18n sibling instances.
- [x] Review the diff and run the GitNexus-required `detect_changes` fallback report against `master`.
- [x] Manually inspect packaged artifacts without launching the Tauri UI.

## 6. Contribution Readiness

- [x] Apply the feature onto the latest upstream `master`.
- [x] Exclude machine-specific deployment records and generated binaries.
- [x] Verify the public diff contains only source, tests, and project documentation.

## Rollback Points

1. Backend-only checkpoint before IPC registration.
2. Frontend integration checkpoint before docs/package build.
3. Release-build checkpoint before contribution cleanup.
