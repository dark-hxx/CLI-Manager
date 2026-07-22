# Implementation

1. Serialize history schema initialization and correct version-finalization order.
2. Extend history regression coverage with concurrent legacy opens.
3. Add the validated Rust database-restore transaction command and unit tests.
4. Reuse batch-insert statement construction in `syncStore` and invoke the Rust command once per restore.
5. Update `V1.3.1` changelog and persistence/sync contracts.
6. Run focused Rust tests, full history tests, `cargo check`, TypeScript checks, and diff validation.
7. Move SSH multi-step persistence to explicit Rust single-connection commands and remove pooled frontend transaction control.
8. Coalesce identical SSH remote-history requests and enforce monotonic catalog generation/cursor writes.
9. Add SSH rollback and remote response-order regression tests; update SSH/history contracts and `V1.3.1` changelog.

## Verification

- `npx tsc --noEmit`: passed.
- `cargo test --lib --manifest-path src-tauri/Cargo.toml commands::sync::tests`: 3 passed.
- `cargo test --lib --manifest-path src-tauri/Cargo.toml commands::ssh_db::tests`: 5 passed.
- `cargo test --lib --manifest-path src-tauri/Cargo.toml history`: 141 passed.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`: passed.
- `rustfmt +stable --check --edition 2021 src-tauri/src/commands/ssh_db.rs src-tauri/src/commands/sync.rs src-tauri/src/commands/history/catalog.rs`: passed.
- Full `cargo test --lib`: 682 passed, 1 ignored, 1 unrelated existing failure in `commands::hook_settings::tests::install_then_uninstall_pi_extension`; the failure reproduces when run alone.
