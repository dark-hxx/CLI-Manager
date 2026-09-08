# Implementation Plan

## Backend

1. Refactor cc-switch DB path resolution for reuse by hook settings code.
2. Add cc-switch common-config merge helpers:
   - parse `common_config_claude` as JSON and treat `common_config_codex` as TOML;
   - remove CLI-Manager-owned hook commands from relevant events;
   - add current Claude hook commands generated from the selected Claude config directory;
   - enable Codex TOML `[features].hooks = true` while leaving hook commands in `hooks.json`;
   - serialize JSON/TOML preserving non-owned fields.
3. Add a Tauri-safe status payload for cc-switch protection outcome.
4. Extend `hook_settings_install` and `hook_settings_get_status` signatures if needed to accept `ccSwitchDbPath`/`dbPath`.
5. Add Rust unit tests for:
   - common config merge preserves existing fields/hooks;
   - invalid Claude JSON returns a failure status and does not overwrite;
   - explicit invalid DB path does not fallback;
   - missing default DB is non-fatal.

## Frontend

1. Pass `ccSwitchDbPath ?? undefined` from `HookSettingsPage` and sidebar hook install flows.
2. Extend Hook settings types with cc-switch protection metadata.
3. Show protection status in the Claude Hook card/details area.
4. Adjust install toast to include sync outcome.
5. Add one-time notice path for auto-repair restoration.

## Validation

1. `npx tsc --noEmit`
2. `cd src-tauri && cargo check`
3. Targeted Rust tests for `ccswitch`/`hook_settings` if added.
4. Manual smoke:
   - no cc-switch DB installed;
   - default DB present;
   - custom selected DB path;
   - invalid selected DB path;
   - WSL Claude config mismatch warning.

## Implementation Result

- Backend common-config sync added to Claude/Codex Hook install/uninstall/status with selected `ccSwitchDbPath` priority and platform default fallback.
- Codex common-config sync corrected to TOML `[features].hooks = true`; it no longer parses or writes `common_config_codex` as JSON.
- Automatic repair added behind the persisted `claudeHookAutoRepairKnownInstalled` flag, with one-time frontend notice.
- Hook settings UI now shows one shared cc-switch protection state above system notifications and install toast includes sync outcome.
- Code-spec updated in `.trellis/spec/backend/cli-hook-contracts.md`.

## Verification Log

- `npx tsc --noEmit` passed.
- `cargo test hook_settings` passed: 17 tests.
- `cargo check` passed.
- `git diff --check` passed.
- `gitnexus detect-changes` could not run because the repository is not indexed.
- `gitnexus analyze` failed on this machine because `tree-sitter-dart` has no native build for Windows Node 22.23.0.
