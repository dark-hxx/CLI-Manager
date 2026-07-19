# SSH config roots and launch injection

## Goal

Host/project config-root persistence, launch env injection, deletion semantics, and boundary validation.

## Requirements

- Persist per-host Claude/Codex roots and optional SSH project overrides.
- Resolve launch priority as project override, host preference, then native default with no injected variable.
- Inject only `CLAUDE_CONFIG_DIR` or `CODEX_HOME` for the project's configured CLI source.
- Validate absolute POSIX and `~/...` roots at both UI/store and Rust process boundaries.
- Preserve remote integration identity when a Host is deleted; never uninstall remote state implicitly.

## Acceptance Criteria

- [x] Migration and cascade/unbound semantics have focused Rust tests.
- [x] Absolute, `~`, `~/...`, traversal, expansion, newline, and backslash cases are tested.
- [x] SSH new-tab, split, detached, restore, and daemon launch paths share the same resolved environment.
- [x] Local and WSL launch behavior remains unchanged.
- [x] `npx tsc --noEmit` and focused Rust tests pass.

## Notes

- Parent design: `../07-19-ssh-claude-codex-agent-hook/design.md`.
