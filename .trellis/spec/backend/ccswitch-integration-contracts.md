# cc-switch Integration Contracts

> Executable contracts for reading the external cc-switch SQLite db and writing
> CLI-Manager-owned provider config files used by `claude --settings` and
> `codex --profile`. Implementation: `src-tauri/src/commands/ccswitch.rs`.

---

## Scenario: Reading an external tool's SQLite database

### 1. Scope / Trigger

- Trigger: any Tauri command that reads a SQLite file owned by another application
  (here: `~/.cc-switch/cc-switch.db`).

### 2. Signatures

```rust
#[tauri::command]
pub async fn ccswitch_list_providers(
    app: tauri::AppHandle,
    db_path: Option<String>,        // JS 侧传 dbPath（camelCase 自动映射）
) -> Result<CcSwitchProvidersResponse, String>
```

### 3. Contracts

- **Dependency**: use the `sqlx` 0.8 already present in the dependency tree via
  `tauri-plugin-sql` (`default-features = false, features = ["runtime-tokio", "sqlite"]`).
  **Never add `rusqlite`** — `libsqlite3-sys` is a `links = "sqlite3"` crate, two versions
  cannot coexist; the build breaks or pins us to fragile version coupling.
- **Open mode**: `SqliteConnectOptions::new().filename(path).read_only(true)` +
  `SqliteConnection::connect_with`. `create_if_missing` stays default (false) so a typo'd
  path can never create an empty db file.
- **WSL database runtime**: on Windows, a `\\wsl.localhost\<distro>\...` or
  `\\wsl$\<distro>\...` database is never queried or written directly through Plan 9.
  Read commands ask Python `sqlite3` inside the named distro to create an online backup
  snapshot in the Windows temp directory, then keep the existing Rust/sqlx parsing and
  secret masking path. CLI-Manager deletes the snapshot when the prepared read path drops.
- **WSL write runtime**: Hook/statusline common-config updates run a fixed Python sqlite3
  transaction inside the named distro. The request contains only the fixed settings key,
  expected old value and replacement value; `BEGIN IMMEDIATE` plus the old-value check
  prevents overwriting a concurrent cc-switch update. Never expose arbitrary SQL through
  the Tauri boundary and never fall back to UNC writes.
- **Common config write behavior**: User-triggered Hook/statusline operations write
  local CLI config first, then best-effort write cc-switch common config automatically.
  cc-switch common config is a shared snippet merged into all providers with "Apply
  Common Config" enabled. If cc-switch is missing or unavailable, the local config
  write remains the fallback and must still succeed.
- **Allowed common config content**: write only CLI-Manager-owned shared Hook/statusline
  state: Claude `hooks` commands and `statusLine`, Codex `[features].hooks`,
  CLI-Manager-owned `[hooks.state.*]`, and Codex `[tui].status_line`. Do not write
  secrets, base URLs, model-provider routing, generated project provider profiles, or
  project-local state into cc-switch common config.
- **Path resolution**: `None`/blank → default under `app.path().home_dir()`; custom path
  must pass extension allowlist (`.db`) and `is_file()` before any I/O.
- **WSL path validation**: on Windows, validate WSL UNC database existence with
  `wsl.exe -d <distro> --exec test -f <linux_path>`; do not trust host `Path::is_file()`
  as the authority for Plan 9 paths.
- **Secret masking happens in Rust**: env keys containing
  `token|key|secret|auth|password` (case-insensitive) are masked
  (`first 4 + … + last 4`, or `***` if ≤12 chars) before the payload crosses to the
  WebView. Plaintext credentials must never reach the frontend.

### 4. Validation & Error Matrix

| Condition | Error (stable string) |
|-----------|----------------------|
| Path extension is not `.db` | `unsupported_format` |
| File does not exist | `db_not_found` |
| Cannot resolve home dir | `home_dir_unavailable: <err>` |
| SQLite open failure | `db_open_failed: <err>` |
| Query/decode failure | `db_query_failed: <err>` |
| WSL/Python sqlite3 unavailable | `wsl_sqlite_runtime_unavailable` |
| WSL database operation failure | `wsl_sqlite_failed: <err>` |
| WSL common config changed concurrently | `db_write_conflict` |

### 5. Good/Base/Bad Cases

- Good: no `dbPath` arg → default path resolved, providers returned with masked env.
- Base: custom `dbPath` to a moved db file → `db_not_found`, frontend shows mapped hint.
- Bad: opening read-write or with `create_if_missing(true)` → may create/lock another
  app's database file; forbidden.

### 6. Tests Required

- Unit: `is_secret_env_key` accepts/rejects known key names (`ANTHROPIC_AUTH_TOKEN` vs
  `ANTHROPIC_BASE_URL`).
- Unit: `mask_secret` keeps only edges, handles short/empty strings.
- Unit: settings_config parse failure → provider still listed with `configParseError: true`.
- Windows + WSL integration: online backup reads an in-distro database and fixed transaction
  writes a setting that can be read back through a fresh snapshot.

### 7. Wrong vs Correct

#### Wrong
```toml
rusqlite = { version = "0.32", features = ["bundled"] }  # links 冲突 / 重复原生 sqlite
```
#### Correct
```toml
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "sqlite"] }
```

---

## Scenario: Preparing Claude provider settings for `claude --settings`

### 1. Scope / Trigger

- Trigger: switching a claude project's API provider (`ccswitch_prepare_claude_provider`).
- The active provider is stored in project metadata, not inferred from project path.
  Same path + same shell may have multiple project records with different providers.
- Legacy commands that read or rewrite `<project>/.claude/settings.json` remain only
  for compatibility/probing. New switching must not write project-owned Claude config.

### 2. Signatures

```rust
#[tauri::command]
pub async fn ccswitch_prepare_claude_provider(
    app: tauri::AppHandle,
    project_id: String,
    provider_id: String,
    db_path: Option<String>,
) -> Result<CcSwitchClaudeProviderSettings, String>
// { providerId, providerName, settingsPath }；不向前端回传任何 env 内容

Frontend project override shape:

```json
{
  "claude": {
    "providerId": "<cc-switch provider id>",
    "providerName": "<display name or null>",
    "settingsPath": "C:\\Users\\Administrator\\.cli-manager\\providers\\claude\\<project>-<hash>.settings.json"
  }
}
```

#[tauri::command]
pub async fn ccswitch_probe_projects(
    app: tauri::AppHandle,
    project_paths: Vec<String>,
    db_path: Option<String>,
) -> Result<Vec<CcSwitchProjectBadge>, String>
// 每项 { path, hasOverride, providerName }；单项路径缺失/损坏 JSON 容错为
// hasOverride=false，绝不让整批失败；db 缺失 → db_not_found（前端静默清徽标）
```

### 3. Contracts

- **Settings location**: generated Claude settings live under
  `~/.cli-manager/providers/claude`, never under the project directory.
- **Settings content**: read `settings.common_config_claude` and the selected
  `providers.settings_config`, recursively merge object fields with the provider taking
  precedence, then write the complete merged JSON. This preserves provider/common fields
  such as `env`, `permissions`, `hooks`, `model`, and future settings instead of reducing
  the file to `env` only. Do not merge with project `.claude/settings.json`.
- **Startup refresh**: generated settings are a launch cache, not the source of truth.
  Every internal Claude PTY launch with `provider_overrides.claude` must re-read the
  cc-switch provider by `providerId` and overwrite the generated settings file before
  the frontend writes the startup command.
- **Launch command**: for Claude projects with empty `startup_cmd`, frontend appends
  `--settings <settingsPath>` when `provider_overrides.claude` exists. If
  `startup_cmd` is non-empty, do not rewrite it; surface a UI warning that the user
  must manually add `--settings <settingsPath>`.
- **CLI extra args (`cli_args`, projects v13 column)**: with empty `startup_cmd`, the
  resolved command is `cli_tool` + `cli_args` + auto-appended override args, in that
  order. The `--settings` duplicate check (`hasClaudeSettingsArg`) runs against the
  whole command including `cli_args`, so a user-written `--settings` in `cli_args`
  suppresses auto-append. `cli_args` never applies when `startup_cmd` is non-empty.
- **WSL launch path**: when the project shell resolves to WSL/Bash on Windows,
  `--settings` must use `/mnt/<drive>/...`, not a Windows `C:\...` path.
- **Reset**: resetting Claude to global removes the `claude` object from
  `provider_overrides`; it does not delete generated settings files or legacy
  project `.claude/settings.json`.
- **Match rule** (`provider_matches_project_env`): `ANTHROPIC_BASE_URL` equal AND
  (`ANTHROPIC_AUTH_TOKEN` OR `ANTHROPIC_API_KEY`) equal. This is legacy probe
  compatibility only; new project badges prefer `provider_overrides.claude`.
- **Atomic-ish write on Windows**: serialize with `to_string_pretty`, write a temp file
  in the same directory, remove the existing generated target if present, then
  `fs::rename`; clean up tmp on rename failure.

### 4. Validation & Error Matrix

| Condition | Error (stable string) | File touched? |
|-----------|----------------------|---------------|
| blank `project_id` | `project_not_found` | no |
| provider id not in db (app_type='claude') | `provider_not_found` | no |
| common/provider settings config invalid, non-object, or merged result has no env object | `provider_config_invalid` | no |
| tmp write / replace failure | `settings_write_failed: <err>` | no provider override update |
| startup refresh fails | same stable error as prepare command | PTY launch is blocked |

### 5. Good/Base/Bad Cases

- Good: project A and project B share the same filesystem path and shell; applying different
  Claude providers stores different `provider_overrides.claude` values and launches with
  different `--settings` files.
- Base: switching to the same provider again overwrites the generated settings file without
  failing on Windows.
- Base: cc-switch provider env changes after switching → next internal Claude terminal
  launch refreshes the generated settings file before running `claude --settings`.
- Base: `common_config_claude` provides permissions/hooks while the provider overrides
  nested env/model fields → the generated settings file contains both, provider values win.
- Bad: writing provider settings into `<project>/.claude/settings.json` for new switching —
  forbidden because same-path projects would share one provider.

### 6. Tests Required (all in `ccswitch.rs::tests`, run `cargo test ccswitch`)

- Rust unit: generated settings/profile replacement works when the target file already exists.
- Rust unit: common/provider JSON is recursively merged; common-only nested fields survive
  and provider values override matching keys.
- Rust unit: legacy match rule still covers AUTH_TOKEN path, API_KEY path, and negative case.
- Frontend helper: empty Claude `startup_cmd` appends `--settings`; custom
  `startup_cmd` returns unchanged.

### 7. Wrong vs Correct

#### Wrong
```rust
// New switching must not write shared project path state.
fs::write(project.join(".claude/settings.json"), provider_settings_config)?;
```
#### Correct
```rust
let settings_path = write_claude_provider_settings(project_id, provider_id, &merged_settings)?;
// frontend launches: claude --settings <settings_path>
```

---

## Scenario: Codex project provider switching via generated profiles

### 1. Scope / Trigger

- Trigger: switching a project whose configured CLI tool is exactly `codex` to a
  cc-switch provider with `app_type = 'codex'`.
- This is cross-layer: frontend project metadata selects a provider, backend reads
  cc-switch and writes a Codex profile, and PTY launch injects secret env vars.

### 2. Signatures

```rust
#[tauri::command]
pub async fn ccswitch_prepare_codex_provider(
    app: tauri::AppHandle,
    provider_id: String,
    db_path: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<CcSwitchCodexProviderProfile, String>
// { providerId, providerName, profileName }

pub struct CodexProviderLaunchConfig {
    pub provider_id: String,
    pub db_path: Option<String>,
    pub codex_config_dir: Option<String>,
}

pub(crate) async fn apply_codex_provider_launch_env(
    app: &tauri::AppHandle,
    launch_config: Option<CodexProviderLaunchConfig>,
    env_vars: &mut HashMap<String, String>,
) -> Result<(), String>
```

Database migration:

```sql
ALTER TABLE projects ADD COLUMN provider_overrides TEXT NOT NULL DEFAULT '{}';
```

Frontend project override shape:

```json
{
  "codex": {
    "providerId": "<cc-switch provider id>",
    "providerName": "<display name or null>",
    "profileName": "cli-manager-<slug>-<hash>"
  }
}
```

### 3. Contracts

- **Eligibility**: Codex provider switching is enabled only when
  `project.cli_tool.trim().toLowerCase() === "codex"`. Do not enable it for
  wrapper commands or any value that merely contains `codex`.
- **Provider filtering**: the provider switch modal filters by the active adapter:
  Claude projects show only `appType === "claude"`; exact Codex projects show
  only `appType === "codex"`.
- **Do not write project-local Codex provider config**: never write
  `model_provider`, `model_providers`, `openai_base_url`, `profile`, or auth keys
  into `<project>/.codex/config.toml`; Codex ignores these keys in project-local
  config and emits warnings.
- **Profile location**: generated profiles are written into the user's **real
  Codex home** — the custom `codexHookConfigDir` when set, otherwise `~/.codex` —
  so they sit next to the user's own `config.toml` and `auth.json`. `codex --profile
  <name>` layers `$CODEX_HOME/<name>.config.toml` on top of that base config, so the
  profile must live in the same home the user's account/base config live in.
  Do **not** redirect `CODEX_HOME` to an isolated `~/.cli-manager/providers/codex`
  directory: that empty home strips the user's auth and base config. PTY launch
  injects `CODEX_HOME=<resolved real home>` (equal to the default `~/.codex` when no
  custom home is set, so it is a no-op for local shells but guarantees the generated
  profile is discoverable for WSL/Bash shells too). For WSL/Bash shells on Windows,
  the injected `CODEX_HOME` is converted to `/mnt/<drive>/...` while the profile is
  still written through the Windows filesystem path.
  Legacy profiles left in `~/.cli-manager/providers/codex` by the old redirect design
  are purged during cleanup.
- **Provider input shapes**: cc-switch Codex providers may not be shaped like
  Claude `settings_config.env`. The parser must accept both env-style and
  Codex/config-style shapes:
  - env object keys such as `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `CODEX_BASE_URL`,
    `*_BASE_URL`, `*_API_BASE`, `*_ENDPOINT`, `OPENAI_MODEL`, `CODEX_MODEL`,
    `*_MODEL`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `*_API_KEY`, `*_TOKEN`;
  - top-level equivalents such as `openai_base_url`, `base_url`, `api_base`,
    `endpoint`, `model`, `api_key`, `auth_token`, `token`;
  - auth object equivalents such as `settings_config.auth.OPENAI_API_KEY` or
    `settings_config.auth.api_key`;
  - a TOML string stored in `settings_config.config`, including top-level
    `model_provider`, `model`, and `[model_providers.<id>]` tables;
  - Codex-style provider tables such as `model_providers.<id>.base_url` and
    `model_provider = "<id>"`;
  - lowercase and hyphenated variants by normalizing key names before matching.
- **Common config merge**: read TOML text from `settings.common_config_codex` and merge it
  into the selected provider JSON's `config` TOML string before parsing. Matching tables
  are combined without duplicate headers, including semantically equivalent quoted table
  keys written with TOML basic strings or literal strings; provider assignments override
  common values.
- **Profile content**: when merged `settings_config.config` contains a valid selected
  `model_provider` table, preserve the complete non-secret TOML (including fields such as
  `wire_api`, verbosity, feature flags, and future Codex settings). Reuse its `env_key`; if
  missing, inject the generated CLI-Manager env key into the selected provider table. For
  env/top-level legacy shapes without usable TOML, retain the generated routing fallback:

```toml
# Generated by CLI-Manager. Do not put secrets in this file.
model = "gpt-5.4"
model_provider = "cli_manager"

[model_providers.cli_manager]
name = "Provider Name"
base_url = "https://proxy.example.com/v1"
env_key = "CLI_MANAGER_CODEX_PROVIDER_<hash>_API_KEY"
```

- **Secret handling**: API keys/tokens from cc-switch stay in Rust. They must not
  be returned to WebView, written to the generated profile, written to project
  files, or embedded in the startup command. PTY env injection is the only place
  the plaintext secret is applied.
- **Unsafe TOML fallback**: if the raw TOML contains the resolved plaintext secret, do not
  copy it; fall back to the generated non-secret routing profile.
- **Launch command**: for exact Codex projects with empty `startup_cmd`, the
  generated startup command appends `--profile <profileName>` and preserves
  `--no-alt-screen`. If `startup_cmd` is non-empty, do not rewrite it; surface a
  UI warning that the user must manually add `--profile <profileName>`.
- **CLI extra args (`cli_args`, projects v13 column)**: with empty `startup_cmd`, the
  resolved command is `cli_tool` + `cli_args` + auto-appended override args. The
  `--profile` duplicate check (`hasProfileArg`) runs against the whole command
  including `cli_args`, so a user-written `--profile` in `cli_args` suppresses
  auto-append. `cli_args` never applies when `startup_cmd` is non-empty.
- **Reset**: resetting Codex to global removes the `codex` object from
  `provider_overrides`; cleanup may delete unused CLI-Manager-generated profiles
  but must not delete user-owned profiles.
- **Claude compatibility**: Claude switching uses generated settings files and
  `claude --settings` as described in the previous scenario.

### 4. Validation & Error Matrix

| Condition | Error / behavior |
|-----------|------------------|
| provider id not in cc-switch with `app_type = 'codex'` | `provider_not_found` |
| provider `settings_config` invalid / no object-shaped config | `provider_config_invalid` |
| no base URL-like value in env/top-level/config TOML/model provider table (`OPENAI_BASE_URL`, `openai_base_url`, `base_url`, `*_BASE_URL`, `*_API_BASE`, `*_ENDPOINT`) | `provider_config_invalid: missing_codex_base_url` |
| no API key/token-like value in env/auth/top-level config (`OPENAI_API_KEY`, `api_key`, `*_API_KEY`, `*_TOKEN`) | `provider_config_invalid: missing_codex_api_key` |
| generated profile write/rename fails | `profile_write_failed: <err>` |
| custom `startup_cmd` exists | no command rewrite; UI warning only |
| cc-switch db missing/invalid | same `db_not_found` / `unsupported_format` contracts as provider listing |

### 5. Good/Base/Bad Cases

- Good: exact `cli_tool = "codex"`, empty `startup_cmd`, selected provider has
  base URL + API key in any supported cc-switch shape → backend writes profile
  without the key, terminal launches `codex --profile cli-manager-... --no-alt-screen`,
  and PTY env contains the generated env key with the secret.
- Base: exact `cli_tool = "codex"`, provider uses Codex-style `model_providers`
  table plus top-level `api_key` → parser resolves the selected provider table,
  writes only non-secret route/model fields to the generated profile, and keeps
  `api_key` only in Rust-side launch env.
- Base: provider stores `auth.OPENAI_API_KEY` plus a TOML string in
  `config = 'model_provider = "custom"\nmodel = "gpt-5.5"\n[model_providers.custom]\nbase_url = "..."'`
  → parser reads the secret from `auth`, preserves the complete TOML, and writes a
  generated profile. If the TOML lacks `base_url`, the user must complete the
  endpoint in cc-switch; no manual Codex profile file is required.
- Base: exact `cli_tool = "codex"`, custom `startup_cmd` → provider override is
  stored and profile is generated, but startup command is not modified; modal
  warns to add `--profile` manually.
- Bad: writing provider settings into `<project>/.codex/config.toml` or storing
  `OPENAI_API_KEY` in `provider_overrides` / generated TOML — forbidden.

### 6. Tests Required

- Rust unit: generated Codex profile contains `base_url`, `model_provider`,
  `env_key`, and optional `model`, but does **not** contain the secret value.
- Rust unit: config TOML preserves non-routing fields such as `wire_api` and verbosity;
  missing selected-provider `env_key` is injected without discarding the remaining TOML.
- Rust unit: env-style provider, top-level `openai_base_url` + `api_key`,
  `auth.OPENAI_API_KEY` + `config` TOML string, and Codex-style
  `model_providers.<id>.base_url` shapes all parse successfully.
- Rust unit: lowercase/hyphenated key variants parse via normalized matching.
- Rust unit: missing base URL returns `provider_config_invalid: missing_codex_base_url`.
- Rust unit: missing secret returns `provider_config_invalid: missing_codex_api_key`.
- Rust/command check: `ccswitch_prepare_codex_provider` returns provider/profile
  metadata only; no plaintext env values cross the Tauri boundary.
- TypeScript helper: exact `codex` is eligible; wrapper commands containing
  `codex` are not.
- TypeScript helper: empty `startup_cmd` appends `--profile` + `--no-alt-screen`;
  custom `startup_cmd` returns unchanged.
- UI check: provider list is filtered by adapter app type.

### 7. Wrong vs Correct

#### Wrong
```toml
# <project>/.codex/config.toml -- Codex ignores these project-local keys
model_provider = "proxy"

[model_providers.proxy]
base_url = "https://proxy.example.com/v1"
env_key = "OPENAI_API_KEY"
```

#### Correct
```toml
# $CODEX_HOME/cli-manager-provider.config.toml
model_provider = "cli_manager"

[model_providers.cli_manager]
base_url = "https://proxy.example.com/v1"
env_key = "CLI_MANAGER_CODEX_PROVIDER_<hash>_API_KEY"
```

```typescript
// Empty startup_cmd only; exact codex only
resolveProjectStartupCommand(project) // "codex --profile cli-manager-... --no-alt-screen"
```
