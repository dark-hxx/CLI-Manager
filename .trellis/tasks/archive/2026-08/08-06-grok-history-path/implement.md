# Grok History Path Implementation Plan

1. [x] Update the task artifacts with the confirmed path contract and `[TEMP]`
   changelog target.
2. [x] Run GitNexus impact if available; otherwise use the provider/history
   contracts and symbol search as the documented fallback.
3. [x] Patch `src-tauri/src/commands/history.rs` so all Grok readers consume a
   session-root path directly.
4. [x] Add/adjust Rust regression tests for explicit and implicit Grok roots and
   exact lookup.
5. [x] Update `CHANGELOG.md`, `docs/功能清单.md`, and the relevant backend contract.
6. [x] Run formatting, affected Rust tests, `cargo check`, TypeScript type-check and
   `git diff --check`.
7. [x] Leave all implementation and documentation changes uncommitted for user
   review; do not run `git commit`.

## Verification Evidence

- `cargo test commands::history::tests --lib`: 90 passed.
- `cargo test commands::history::catalog --lib`: 29 passed.
- `cargo check`: passed.
- `cargo fmt --all -- --check`: passed.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- Read-only filesystem probe found 13 `updates.jsonl` files under the real
  `C:\Users\1\.grok\sessions`; the fixed scanner now targets that root.
