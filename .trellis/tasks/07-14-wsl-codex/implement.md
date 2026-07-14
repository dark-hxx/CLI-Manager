# Implementation Plan

1. Update `src-tauri/src/commands/history.rs` session validation and Codex runtime path/state registration behavior.
2. Add focused Rust regression tests for project-key reconciliation, WSL runtime path conversion, and WSL state registration skip.
3. Extend `.trellis/spec/backend/wsl-path-contracts.md` with the executable WSL Codex contracts and test requirements.
4. Append a `[TEMP]` changelog entry without modifying the existing Hook bridge entry.
5. Run `cargo test history --lib`, `cargo check`, and `npx tsc --noEmit`.
6. Run GitNexus change detection and review the final diff for unrelated changes.
