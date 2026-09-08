# Design: cc-switch Hook Protection

## Scope

This release protects global/user-level Claude and Codex Hook registration from cc-switch provider switches. It does not implement project-local settings protection or system managed settings protection.

## Architecture

### Backend

- Extend `commands::hook_settings` so Claude Hook install can optionally receive the selected cc-switch DB path from frontend settings.
- Reuse `commands::ccswitch` path resolution behavior:
  - selected `ccSwitchDbPath` has priority;
  - blank/none means platform default `~/.cc-switch/cc-switch.db`;
  - invalid explicit path is reported and never silently replaced by a default DB.
- Add backend operations that merge CLI-Manager hook protection into `settings.common_config_claude` and `settings.common_config_codex`.
- Keep merge ownership narrow:
  - for Claude JSON, remove/replace only hook commands recognized as CLI-Manager-owned (`__hook` marker or known legacy scripts);
  - preserve all non-CLI-Manager hook entries;
  - preserve all non-hook fields in the Claude common config JSON;
  - for Codex TOML, preserve existing TOML fields and only ensure `[features].hooks = true`; hook commands remain in `hooks.json`.
- Use SQLite through `sqlx`; do not add `rusqlite`.
- Use a transaction for common config writes.

### Frontend

- Hook install calls pass `ccSwitchDbPath ?? undefined` to the backend.
- Hook status surface reports cc-switch protection state:
  - not detected;
  - synced;
  - invalid selected DB;
  - sync failed;
  - WSL environment mismatch warning.
- Install toast says when common-config sync was applied, skipped, or failed.
- Hook install itself succeeds even if cc-switch is not installed.
- If common-config sync fails after Hook install succeeds, show a warning rather than failing the whole install.

### Automatic Repair

- Track prior installed state using existing Hook status signals plus a persisted lightweight flag if needed.
- On refresh/startup/install-status checks, detect when CLI-Manager-owned hook entries are missing after they were previously installed.
- Restore missing entries silently, then show a one-time lightweight notice.
- Repeated loss surfaces advanced protection details/status, but this release stays global-only.

## Data Flow

1. User clicks "Install Claude Hook".
2. Frontend invokes `hook_settings_install({ selectedDir, codexSelectedDir, ccSwitchDbPath })`.
3. Backend installs hooks into Claude `settings.json`.
4. Backend resolves cc-switch DB:
   - explicit valid path: use it;
   - explicit invalid path: report invalid selected DB in status, do not write default;
   - none + default exists: use default;
   - none + default missing: mark not detected.
5. If DB is usable, backend merges current CLI-Manager hook entries into the relevant `common_config_<tool>` key.
6. Backend returns Hook status with cc-switch protection metadata.
7. Frontend shows install success plus sync outcome.

## Compatibility Notes

- Windows native default: `%USERPROFILE%\.cc-switch\cc-switch.db`.
- macOS/Linux default: `$HOME/.cc-switch/cc-switch.db`.
- WSL default: WSL user's `$HOME/.cc-switch/cc-switch.db`.
- Windows native managing WSL `.claude` may require a WSL UNC cc-switch DB path; warn on mismatch instead of guessing silently.

## Failure Handling

- Missing default DB: no-op, Hook install remains successful.
- Invalid selected DB: do not fallback; return status warning.
- DB locked/open failure: return sync failure status; Hook install remains successful.
- Missing `settings` table: return sync unavailable; Hook install remains successful.
- Invalid `common_config_claude` JSON: do not overwrite blindly; return sync failure status.
- `common_config_codex` is TOML, not JSON; preserve existing TOML text and ensure `[features].hooks = true`.

## Future Work

- Project-local `.claude/settings.local.json` protection.
- System managed settings protection with platform-specific elevated permission UX.
