# Implementation Plan

- [x] Update task manifests/spec context and inspect existing clipboard, PTY and CLI capability code.
- [x] Add Rust clipboard file conversion command, image features, registration, tests and stable result type.
- [x] Add frontend capability registry, Alt+V bridge, WSL path formatting and localized feedback.
- [x] Update Claude session context detection and all required specification/changelog entries.
- [x] Run focused tests, `npx tsc --noEmit`, `cargo check`, production build, GitNexus `detect_changes`, and task quality checks.

## Verification

- `node --test scripts/wslImagePaste.test.mjs`: 3 passed.
- `npx tsc --noEmit`: passed.
- `cargo test commands::fs::tests --lib`: 24 passed.
- `cargo check`: passed (MSVC emitted a transient `R6016` diagnostic while compiling dependencies, but Cargo completed successfully).
- `npm run build`: passed.
- `git diff --check`: passed apart from repository line-ending notices.
- `cargo fmt -- --check`: changed task file is formatted; the repository-wide check remains blocked by a pre-existing formatting difference in `src-tauri/src/provider/database.rs`, which was not modified.
