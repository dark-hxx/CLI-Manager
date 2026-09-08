# cc-switch and Claude Settings Research

## Sources

- cc-switch README_ZH: https://github.com/farion1231/cc-switch/blob/main/README_ZH.md
- cc-switch v3.11.1 release notes: https://github.com/farion1231/cc-switch/blob/main/docs/release-notes/v3.11.1-zh.md
- Claude Code settings docs: https://docs.anthropic.com/en/docs/claude-code/settings

## cc-switch Facts

- cc-switch is a cross-platform Tauri desktop app for Windows, macOS, and Linux.
- Its documented default database location is `~/.cc-switch/cc-switch.db`.
- The database is SQLite and stores providers, MCP, prompts, and skills.
- cc-switch supports user workflows where config data may be synced or stored outside the platform default directory.
- The FAQ describes "通用配置片段" as the mechanism for preserving non-provider fields such as plugins/config across provider switches.
- v3.11.1 release notes explicitly restored a "full config overwrite + common config snippet" strategy after partial key merge caused data loss.

## Claude Code Settings Facts

- Claude settings scopes are Managed, User, Project, and Local.
- User settings live at `~/.claude/settings.json`; on Windows, `~` resolves to `%USERPROFILE%`.
- Project settings live under the repository's `.claude/settings.json`.
- Local project settings live in `.claude/settings.local.json` and are intended for personal project overrides.
- Managed settings have the highest precedence and cannot be overridden by lower scopes.
- File-based managed settings locations:
  - Windows: `C:\Program Files\ClaudeCode\`
  - macOS: `/Library/Application Support/ClaudeCode/`
  - Linux and WSL: `/etc/claude-code/`
- File-based managed settings support a `managed-settings.d/` drop-in directory. JSON files are sorted alphabetically and deep-merged; arrays are concatenated and de-duplicated.
- Claude Code watches settings files and reloads most keys, including hooks, when they change.

## Implications for CLI-Manager

- CLI-Manager must not hard-code `C:\Users\Admini\.cc-switch\cc-switch.db`; that is only one user's current default path.
- The existing `ccSwitchDbPath` setting in CLI-Manager should be the highest-priority path source.
- If `ccSwitchDbPath` is unset, the backend default should remain the platform user's `~/.cc-switch/cc-switch.db`.
- For WSL/UNC Claude config directories, CLI-Manager may derive and suggest a WSL-side `~/.cc-switch/cc-switch.db`, but should not silently switch away from a user-selected DB.
- The most compatible default defense is to merge CLI-Manager hook entries into `common_config_claude`, then keep a lightweight auto-repair check for cases where external writes still remove hooks.
- Managed settings are technically strong but should be an explicit advanced option because they affect the machine-level Claude Code policy surface and may require elevated permissions.
