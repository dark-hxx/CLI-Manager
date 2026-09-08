# Rust Ownership and Stable Namespace Contracts

## Scope and Layout

```text
src-tauri/src/
  lib.rs                 # App setup, plugin/IPC registration and stable module routes
  main.rs, bin/          # Existing GUI and helper process entries
  app/migrations.rs      # Database migration composition
  commands/mod.rs        # Thin explicit routes for existing command namespaces
  features/<domain>/     # Domain command/service implementations and adjacent tests
  infrastructure/        # Daemon, PTY, SSH/process, storage, files, system and WebDAV
  shared/                # Dependency-free shared encoding helper
src-tauri/ssh-agent/      # Separate remote process/package; do not merge into the GUI crate
```

Domains include agents, app-data, codex-proxy, desktop-pet, files, git, history, hooks,
notifications, projects, providers, remote, stats, statusline, sync, system and terminal.

## Namespace Contract

Physical paths and logical crate namespaces are deliberately different:

```rust
// commands/mod.rs — one owner, no duplicated forwarding implementation
#[path = "../features/history/mod.rs"]
pub mod history;
```

Callers keep `crate::commands::history::history_get_session`; the implementation is in
`features/history/mod.rs`. Similarly, `crate::pty` and `crate::daemon` are routed by lib.rs
to infrastructure. Do not change module names or visibility merely to mirror directories:
that changes `pub(super)` ancestry, helper-binary APIs and command macro paths.

## Public Boundaries

- Library/command registries are explicit compatibility entries. Cross-domain calls use
  their established module APIs; private implementation submodules remain subject to Rust
  visibility and contract review. Do not add wildcard forwarding files or duplicate state.
- The architecture check resolves direct and grouped `crate` references through these routes,
  so a shared module cannot hide a feature dependency behind `crate::commands::...`.
- New direct `crate::features` layer paths obey public-entry checks. Relative `super` and
  local aliases still require compiler checks and source review; the script is not a Rust compiler.
- Register new module routes explicitly; preserve command names, serde fields and IPC arguments.

## Moving Modules Safely

1. Move the complete child tree. A mod.rs owner resolves children alongside itself.
2. Resolve `include_str!`, `include_bytes!` and existing `#[path]` relative to the old file,
   then point the new file at the same resource. Do not rewrite arbitrary user/fixture paths.
3. Keep declarations, visibility, module order, function bodies and fixture bytes unchanged.
4. Run strict architecture, `cargo check --locked`, desktop library tests, relevant shared
   crate tests and SSH-agent tests. Update source-contract test paths to the actual owners.

The convergence byte audit is recorded under the architecture task. Do not run old migration
scripts against an already migrated tree; use current registries and relevant contracts to navigate.
