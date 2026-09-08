# cc-switch Hook 防覆盖保护

## Goal

Prevent CLI-Manager's Claude Hook registration from being lost when cc-switch rewrites Claude Code settings during provider switches, while respecting user-selected cc-switch database paths and cross-platform environments.

## User Value

Users who manage Claude Code providers with cc-switch should be able to install CLI-Manager hooks once and keep receiving Hook events after switching providers. The default path should be low-friction; stronger protection should appear only when the normal integration is unavailable or repeatedly fails.

## Confirmed Facts

- CLI-Manager currently installs Claude hooks into the selected Claude config directory's `settings.json` via `hook_settings_install`.
- The installed hook commands contain the `__hook` marker and are registered under top-level `hooks`.
- CLI-Manager's own `ccswitch_apply_provider` only replaces provider `env` values and preserves top-level `hooks`, but external cc-switch provider switching can rewrite the whole settings file.
- CLI-Manager already has a persisted `ccSwitchDbPath` setting in `settingsStore.ts`; `null` means use the platform default.
- Existing frontend provider flows pass `ccSwitchDbPath ?? undefined` to backend cc-switch commands.
- Existing backend cc-switch commands resolve default DB path as `home_dir/.cc-switch/cc-switch.db` and validate custom paths.
- cc-switch's documented storage location is `~/.cc-switch/cc-switch.db`, not a Windows-only fixed path.
- cc-switch supports a "通用配置片段" mechanism intended to preserve shared fields during provider switching.
- cc-switch v3.11.1 release notes confirm provider switching uses full config overwrite plus common config snippet.
- Claude Code supports user, project, local, and managed settings scopes; managed settings are strongest but system-level.

## Requirements

1. Use a shared cc-switch DB path strategy for Hook protection.
   - Highest priority: user-selected `ccSwitchDbPath` from Settings -> Provider.
   - Fallback: platform default `~/.cc-switch/cc-switch.db`.
   - For WSL/UNC Claude config directories, derive a WSL-side candidate only as a suggestion unless no user-selected path exists and the candidate clearly exists.
   - Never hard-code `C:\Users\Admini\.cc-switch\cc-switch.db`.

2. Detect cc-switch compatibility during Claude Hook install/status.
   - If a valid cc-switch DB is found, expose that status in the Hook settings UI.
   - If a user-selected DB path is invalid, do not silently fallback to another DB; show the path as invalid and direct the user to Settings -> Provider.
   - If no DB exists at the default path, treat cc-switch as not detected rather than failing Hook installation.

3. Add default cc-switch common-config protection.
   - When installing Claude hooks and cc-switch DB is available, automatically merge CLI-Manager hook entries into `settings.common_config_claude` as part of the install action.
   - When installing Codex hooks and cc-switch DB is available, automatically merge the TOML `[features].hooks = true` flag into `settings.common_config_codex` as part of the install action; Codex hook commands remain in `hooks.json`.
   - The UI must clearly report the sync result in the install outcome/toast/status details.
   - Merge only CLI-Manager hook entries; preserve existing common config fields and existing non-CLI-Manager hook entries.
   - Use transactions and stable errors for DB write failures.
   - Never expose provider secrets to the frontend.

4. Add automatic repair as a low-risk fallback.
   - CLI-Manager should detect a previously installed Claude Hook whose `__hook` entries disappeared from `settings.json`.
   - On first detected loss, restore missing CLI-Manager hook entries silently, then show a lightweight one-time notice such as "Claude Hook was overwritten by another tool and has been restored."
   - Repeated losses should surface an "advanced protection" entry point.

5. Gate advanced protection by context.
   - The advanced section stays collapsed/hidden during the normal success path.
   - Trigger advanced UI when common-config sync fails, Hook loss repeats, user manually expands it, or user declined common-config sync and later hits a loss risk.
   - Advanced options focus on global protection only:
     1. automatic repair;
     2. cc-switch common-config sync retry/status details.
   - System managed settings protection is not implemented in this release; keep it as a documented future advanced option only.

6. Respect platform boundaries.
   - Windows native, WSL, macOS, and Linux must all use platform-appropriate default paths.
   - WSL Claude config paths must not be paired with a Windows cc-switch DB without a visible warning.
   - macOS/Linux defaults must use `$HOME/.cc-switch/cc-switch.db`.
   - Managed settings paths, if implemented, must follow Claude Code's documented platform locations.

## Acceptance Criteria

- Installing Claude Hook never depends on a hard-coded Windows user path.
- Hook protection uses `ccSwitchDbPath` when the user has selected one in Settings -> Provider.
- Invalid user-selected cc-switch DB paths show a clear warning and do not cause writes to a different default DB.
- With a valid `common_config_claude` JSON / `common_config_codex` TOML, installing Hook can merge CLI-Manager protection without removing existing common config fields.
- Existing common config hooks not owned by CLI-Manager survive install, reinstall, and uninstall.
- If cc-switch is not installed, Claude Hook install still succeeds as it does today.
- WSL Claude config plus Windows cc-switch DB produces a visible mismatch warning rather than silent cross-environment writes.
- Automatic repair can detect missing `__hook` entries after prior install state.
- Advanced protection is not prominent in the happy path but becomes reachable after failure or repeated loss.
- `npx tsc --noEmit` and `cd src-tauri && cargo check` pass after implementation.

## Out Of Scope

- Rewriting every cc-switch provider's `settings_config` one by one.
- Making `settings.json` read-only.
- Editing unrelated cc-switch tables such as providers, proxy logs, skills, or MCP servers.
- Rewriting Codex provider settings outside cc-switch common-config Hook protection.
- Implementing project-local `.claude/settings.local.json` protection in this release.
- Implementing Claude Code system managed settings protection in this release.

## Decisions

- System managed settings protection is deferred. This release focuses on cc-switch DB path reuse, common-config sync, Hook loss detection, and low-risk automatic repair.
- Automatic repair restores missing Claude Hook entries silently and shows a lightweight one-time notice instead of asking for confirmation every time.
- Project-local `.claude/settings.local.json` protection is deferred. This release only handles global/user-level Claude Hook protection plus cc-switch global common-config sync.
- When a valid cc-switch DB is detected during Claude Hook install, common-config sync runs automatically and reports the outcome rather than requiring a separate confirmation.

## Open Questions

- None.
