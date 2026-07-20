# Sync Statusline Common Config To cc-switch

## Goal

Ensure CLI-Manager-managed Claude/Codex statusline and Hook settings survive cc-switch provider switches by writing the correct shared snippets into cc-switch common config, with explicit user-facing confirmation/education before writing shared common config.

## Changelog Target

[TEMP]

## What I Already Know

- cc-switch stores common config snippets in its SQLite `settings` table as `common_config_claude`, `common_config_codex`, and similar app-specific keys.
- cc-switch merges `common_config_claude` into Claude provider settings as JSON and `common_config_codex` into Codex provider config as TOML.
- CLI-Manager already syncs Hook install/uninstall to cc-switch common config.
- Claude statusline install/uninstall syncs `statusLine`, but statusline profile save/switch does not currently resync common config.
- Codex native statusline writes `[tui].status_line` into `config.toml`; this also needs cc-switch common config protection.
- User requested checking `D:\OneDrive\备份\ccswitch\cc-switch.db` read-only before writing logic.

## Requirements

- Read the local cc-switch DB only; do not modify it during investigation.
- Preserve cc-switch expected formats:
  - Claude common config is JSON stored in `settings.value`.
  - Codex common config is TOML stored in `settings.value`.
- Sync only CLI-Manager-owned shared config:
  - Claude `hooks` entries for CLI-Manager `__hook`.
  - Claude `statusLine` for CLI-Manager `__statusline`.
  - Codex `[features].hooks = true` and CLI-Manager-owned `[hooks.state.*]` trust blocks.
  - Codex `[tui].status_line = [...]`.
- Do not write provider secrets, provider endpoints, model provider routing, or project-local state into common config.
- Before writing cc-switch common config from a user action, ask the user whether to write to common config, and explain what common config means.
- Update project specs/docs so future changes know which settings must ask before writing into cc-switch common config.

## Acceptance Criteria

- [ ] Local cc-switch DB format is inspected read-only and reflected in technical notes.
- [ ] Saving/switching Claude statusline can update `common_config_claude.statusLine` when user chooses to write common config.
- [ ] Saving/switching Codex statusline can update `common_config_codex` `[tui].status_line` when user chooses to write common config.
- [ ] Existing Hook common-config sync behavior remains intact.
- [ ] UI copy explains cc-switch common config before writing it.
- [ ] Specs document common-config write rules and confirmation requirement.
- [ ] TypeScript and Rust checks relevant to touched code pass.

## Definition of Done

- Code changes are minimal and scoped.
- Existing user/provider fields are preserved during common-config merge.
- cc-switch DB errors remain non-fatal for local CLI-Manager config writes.
- `CHANGELOG.md` and relevant specs are updated.

## Out of Scope

- Modifying cc-switch source code.
- Writing to the user's real cc-switch DB during automated verification.
- Changing provider switching semantics or storing secrets in common config.

## Technical Notes

- CLI-Manager repo: `D:\work\pythonProject\CLI-Manager`
- cc-switch repo: `D:\work\pythonProject\cc-switch`
- Local cc-switch DB to inspect read-only: `D:\OneDrive\备份\ccswitch\cc-switch.db`
- Read-only DB inspection found `settings(key TEXT PRIMARY KEY, value TEXT)`.
- Local `common_config_claude` is formatted as JSON and contains existing shared `env`, `permissions`, and `hooks`.
- Local `common_config_codex` is formatted as TOML and contains top-level shared Codex keys, `[features].hooks`, `[hooks.state.*]`, and `[tui]` keys.
- Provider `commonConfigEnabled` lives in the `providers.meta` JSON field.
