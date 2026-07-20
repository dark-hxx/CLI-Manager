# Built-in Statusline Contracts

## 1. Scope / Trigger

- Applies when changing the built-in Claude Code statusline runtime, settings schema, preview command, legacy import, or Claude `statusLine` installation.
- The Rust renderer is the single behavior authority. The React editor must not duplicate widget rendering logic.

## 2. Signatures

```rust
pub fn run_and_exit() -> !
pub fn statusline_get_status() -> Result<StatuslineStatus, String>
pub fn statusline_load_settings() -> Result<StatuslineSettings, String>
pub fn statusline_save_settings(settings: StatuslineSettings) -> Result<StatuslineSettings, String>
pub fn statusline_import_legacy() -> Result<StatuslineSettings, String>
pub fn statusline_render_preview(settings: StatuslineSettings, payload: Value, language: Option<String>) -> Result<String, String>
pub async fn statusline_install(app: AppHandle, refresh_interval: Option<u8>, cc_switch_db_path: Option<String>) -> Result<StatuslineStatus, String>
pub async fn statusline_uninstall(app: AppHandle, cc_switch_db_path: Option<String>) -> Result<StatuslineStatus, String>
pub fn codex_statusline_load(config_dir: Option<String>) -> Result<CodexStatuslineConfig, String>
pub fn codex_statusline_save(config_dir: Option<String>, items: Vec<String>) -> Result<CodexStatuslineConfig, String>
pub fn statusline_profiles_load(tool: StatuslineProfileTool, config_dir: Option<String>) -> Result<StatuslineProfileState, String>
pub fn statusline_profiles_create(tool: StatuslineProfileTool, name: String, payload: Value, config_dir: Option<String>) -> Result<StatuslineProfileState, String>
pub fn statusline_profiles_save(tool: StatuslineProfileTool, profile_id: String, payload: Value, config_dir: Option<String>) -> Result<StatuslineProfileState, String>
pub fn statusline_profiles_switch(tool: StatuslineProfileTool, profile_id: String, config_dir: Option<String>) -> Result<StatuslineProfileState, String>
pub fn statusline_profiles_delete(tool: StatuslineProfileTool, profile_id: String, config_dir: Option<String>) -> Result<StatuslineProfileState, String>
pub fn statusline_profiles_analyze_import(path: String, config_dir: Option<String>) -> Result<ImportAnalysis, String>
pub fn statusline_profiles_commit_import(path: String, revision: u64, decisions: Vec<ImportDecision>, config_dir: Option<String>) -> Result<(), String>
pub fn statusline_backup_export() -> Result<StatuslineBackupBundle, String>
pub fn statusline_backup_restore(bundle: StatuslineBackupBundle) -> Result<(), String>
pub fn statusline_powerline_font_status() -> Result<PowerlineFontStatus, String>
pub fn statusline_powerline_install_fonts() -> Result<PowerlineFontInstallResult, String>
```

Claude invokes the runtime as:

```text
<cli-manager executable> __statusline
```

## 3. Contracts

- `__statusline` must branch before Tauri/WebView initialization, consume one JSON payload from stdin, print rendered text to stdout, and exit.
- Built-in configuration lives at `<home>/.cli-manager/statusline/settings.json` and keeps ccstatusline v3 field names for import compatibility.
- Preview and live execution must both call the same Rust `render` function.
- Preview adds localized `name: value` labels through the shared render pipeline; live `__statusline` output uses Chinese short labels for data widgets. Git branch output uses `⎇ <branch>` without an additional text label.
- The `context-bar` widget renders a 16-cell bar followed by compact used/limit values and the used percentage: `[bar] used/limit (percentage)`.
- Powerline rendering owns theme palettes, separators, start/end caps, optional inverted separator backgrounds, widget auto-alignment and cross-line theme continuation.
- The first Powerline segment has three leading spaces and one trailing space; later segments keep one space on both sides. This preserves a clear left inset without widening every separator gap.
- Built-in Powerline themes select the ccstatusline-zh v2.2.23 ANSI16, ANSI256 or TrueColor palette from `colorLevel`; live output and preview must receive the same escape sequences.
- Font installation is user-triggered only and writes the bundled `Symbols Nerd Font Mono` resource to the current user's font directory. It must not require Git or network access.
- Powerline font status must reflect a font family discoverable by the operating system, not merely a font file present on disk. Windows installation registers and activates the selected font and broadcasts `WM_FONTCHANGE`; Linux refreshes the user font cache with `fc-cache`; macOS installs into `~/Library/Fonts`. The terminal font stack must include the installed Powerline family as a glyph fallback.
- Legacy import reads `<home>/.config/ccstatusline/settings.json`, upgrades `git-pr` to `git-review`, writes only the CLI-Manager copy, and never modifies the legacy file.
- Claude config path uses `CLAUDE_CONFIG_DIR` when non-empty, otherwise `<home>/.claude/settings.json`.
- Install preserves every unrelated Claude field and writes `type=command`, the managed `__statusline` command, `padding=0`, and optional `refreshInterval` clamped to `1..=60`.
- Uninstall removes `statusLine` only when its command contains the CLI-Manager `__statusline` marker.
- cc-switch common config means the app-level shared snippet stored in the cc-switch SQLite `settings` table as `common_config_claude` (JSON) or `common_config_codex` (TOML). cc-switch merges that snippet into every provider whose metadata enables "Apply Common Config" when switching providers.
- Statusline actions must save/apply the local config first, then best-effort write cc-switch common config automatically. If cc-switch is missing, invalid, or unavailable, the local config write is the fallback and still succeeds.
- Claude install/uninstall and profile save/switch flows may best-effort merge/remove the managed `statusLine` in cc-switch `settings.common_config_claude`.
- CC Switch common-config sync reuses the Hook path resolver and transaction rules: explicit invalid paths never fall back, WSL/host mismatches are not written, malformed JSON is preserved, and local Claude installation remains successful when sync is unavailable.
- `StatuslineStatus.ccSwitch` is `null` for read-only status checks and contains `{ state, dbPath, message, wslMismatch }` after install/uninstall. Supported states match Hook protection: `notDetected`, `notSynced`, `synced`, `invalidDb`, `unavailable`, `syncFailed`.
- User configuration writes must be validated and use a same-directory temporary file before replacement.
- Codex native statusline configuration is an ordered array at `[tui].status_line` in `<CODEX_HOME>/config.toml`; the editor changes only this assignment and preserves all other TOML lines and tables.
- Codex statusline save/switch flows may best-effort merge the same `[tui].status_line` assignment into cc-switch `settings.common_config_codex`, preserving existing `[features]`, `[hooks.state.*]`, `[windows]`, `[projects.*]`, and unrelated `[tui]` keys. `common_config_codex` is TOML, not JSON.
- The frontend item catalog must use current official Codex item ids. Unknown ids supplied for save return `codex_statusline_unknown_item` instead of writing invalid configuration.
- Named Claude and Codex profiles live in `<home>/.cli-manager/statusline/profiles.json`; each tool has an independent active profile and strongly validated payload shape.
- Saving or switching a profile applies the actual Claude/Codex configuration first, then updates the active profile metadata. Failed application must not change `activeProfileId`.
- The active profile cannot be deleted or overwritten by library import.
- Profile library import is two-phase: analyze and validate the whole versioned JSON, collect per-profile conflict decisions, then commit only when the library revision still matches.
- Exported profile libraries contain statusline payloads and profile metadata only; they must not contain CLI config paths, environment values, provider secrets, or unrelated Claude/Codex settings.
- Versioned application backups include only CLI-Manager's validated `statusline/settings.json` and `statusline/profiles.json`. Restore atomically replaces those internal files and must not apply external Claude/Codex configuration, cc-switch state, or fonts.

## 4. Validation & Error Matrix

| Condition | Error / behavior |
|---|---|
| Settings root is not JSON object | `statusline_invalid_root` |
| Invalid JSON | `statusline_invalid_json` |
| Lines empty or more than three | `statusline_invalid_line_count` |
| Widget id/type empty | `statusline_invalid_widget` |
| Legacy file missing | `statusline_legacy_not_found` |
| Claude settings malformed | `claude_settings_invalid_json`; do not overwrite |
| Claude settings root not object | `claude_settings_invalid_root`; do not overwrite |
| Uninstall sees third-party command | No-op; preserve third-party `statusLine` |
| Default cc-switch DB missing | Local install/uninstall succeeds; `ccSwitch.state=notDetected` |
| Explicit cc-switch DB invalid | Local install/uninstall succeeds; `ccSwitch.state=invalidDb` |
| Invalid `common_config_claude` JSON | Preserve the row; local install/uninstall succeeds; `ccSwitch.state=syncFailed` |
| Uninstall sees third-party common-config `statusLine` | Preserve it and return `ccSwitch.state=notSynced` |
| Custom command exceeds timeout | Kill child and hide the widget for that render |
| Codex `status_line` is not a string array | `codex_statusline_invalid_array`; do not overwrite |
| Codex item id is not in the supported native catalog | `codex_statusline_unknown_item`; do not overwrite |
| Delete active profile | `statusline_profile_active_delete_forbidden` |
| Import overwrites active profile | `statusline_profiles_active_overwrite_forbidden` |
| Import library changed after analysis | `statusline_profiles_revision_changed` |

## 5. Good/Base/Bad Cases

- Good: a v1 config without `version` imports, gains version 3, keeps unknown widgets, and leaves the source file untouched.
- Good: install updates only `statusLine` while preserving env, permissions, hooks, MCP and provider fields.
- Good: install also replaces only `common_config_claude.statusLine`, preserving provider defaults, Hook entries and unrelated common fields.
- Base: cc-switch is absent; Claude `settings.json` still changes normally and the frontend receives `notDetected` without an error toast.
- Bad: cc-switch sync failure causes the command to report the whole local installation as failed, or uninstall deletes a third-party common-config statusline.
- Good: saving Codex items inserts or replaces only `[tui].status_line`, while `[features]`, providers, hooks and project trust tables remain byte-for-byte equivalent apart from line placement around the edited assignment.
- Base: no internal config exists; runtime renders built-in defaults without writing during the high-frequency render path.
- Bad: preview implements a separate TypeScript formatter and drifts from live output.
- Bad: uninstall deletes a status line owned by another tool.

## 6. Tests Required

- Default configuration validates.
- Legacy aliases migrate without deleting unknown widget fields.
- Fixed payload assertions cover model, token and layout output.
- Fixed payload assertions cover live Chinese labels, Git branch symbol output and the combined context bar format.
- Powerline tests assert the first segment's three-space left inset and the compact single-space padding elsewhere.
- Invalid JSON/root/line count never overwrites the source file.
- Install/uninstall tests assert unrelated Claude fields survive and third-party commands are preserved.
- Common-config tests assert install preserves existing fields/Hooks, uninstall removes only `__statusline`, and malformed/third-party values are never overwritten.
- TypeScript check verifies `ccSwitchDbPath` uses camelCase and `StatuslineStatus.ccSwitch` matches Rust serialization.
- Codex TOML tests cover existing `[tui]`, missing `[tui]`, unrelated tables, item ordering and invalid arrays.
- Profile tests cover first adoption from actual config, tool-specific payload validation, active delete protection, failed switch preserving active id, external drift normalization, import conflict decisions and revision mismatch zero-write behavior.
- TypeScript check verifies Tauri payload field names and settings types.
- Powerline font detection covers common Powerline/Nerd Font family names; platform installation changes require Rust compile checks and manual glyph verification on each supported desktop OS.

## 7. Wrong vs Correct

### Wrong

```ts
const preview = renderStatuslineInReact(settings, payload);
```

### Correct

```ts
const preview = await invoke<string>("statusline_render_preview", { settings, payload });
```

Profile switching must apply the actual file before changing active metadata:

```rust
apply_payload(tool, &target.payload, config_dir)?;
library.tool_mut(tool).active_profile_id = target.id;
save_library(&library)?;
```

Do not update `activeProfileId` first; a failed Claude/Codex write would leave UI metadata claiming a configuration that is not actually active.

Do not make cc-switch availability a prerequisite for local installation:

```rust
let mut status = install(refresh_interval)?;
status.cc_switch = Some(sync_ccswitch_claude_statusline(...).await);
Ok(status)
```
