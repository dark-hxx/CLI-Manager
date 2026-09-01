# CCS-Compatible Provider Domain Contracts

> Planned implementation contract for the provider-domain rebuild. Read together
> with task `08-02-key` before modifying supplier, project-switch, Home, Hook,
> history, or terminal-launch code.

## Ownership and compatibility

- The app-owned provider domain lives in
  `<cli-manager data root>/providers.db`; it is not embedded in
  `cli-manager.db`.
- Copy CCS supplier-domain schema/migrations/settings configuration shapes from
  an explicitly pinned upstream commit. Preserve provider composite identity
  `(id, app_type)`; do not treat ID alone as globally unique.
- Public types are `claude`, `codex`, and `grok`; storage/import maps
  Grok Build to `grokbuild`.
- `.cc-switch/cc-switch.db` is a read-only import source only. No normal
  catalog, global apply, project resolver, terminal launch, badge, CC Connect,
  Hook, history, or restore path may read it after cutover.
- Keep historical provider migrations in `cli-manager.db` registered exactly
  as shipped. They are compatibility tombstones, not a schema to extend.

## Phase 0 verified persistence boundary

### 1. Scope / Trigger

The provider domain must have a durable storage boundary before any catalog or
launch command is migrated away from CCS. This boundary is initialized during
desktop startup, after legacy app-file migration, while the existing
`cli-manager.db` provider migrations remain untouched.

### 2. Signatures

```text
app_paths::providers_db_path() -> Result<PathBuf, String>
app_paths::providers_db_url() -> Result<String, String>
provider::initialize() -> Result<(), String>
```

The initializer is an internal startup operation; it does not expose a
provider command or permit the frontend to open SQLite directly.

### 3. Contracts

- The database path is `<home>/.cli-manager/providers.db`.
- The connection uses WAL, `foreign_keys = ON`, `synchronous = NORMAL`, and a
  bounded 5-second busy timeout.
- Schema version 1 creates the CCS-shaped `providers` and `settings` tables,
  the composite `(provider_id, app_type)` manual-key table, and the
  Home/import/repair/apply-journal tables. `settings` is seeded with empty
  `common_config_claude`, `common_config_codex`, and
  `common_config_grokbuild` documents.
- Schema version 2 is additive: it keeps every version-1 provider/key/Home/
  import/repair/apply-journal table unchanged, seeds versioned
  `routing.service.v1`, `routing.takeovers.v1`, three `routing.app.<app>.v1`,
  `routing.rectifier.v1`, `routing.optimizer.v1`, and
  `routing.global_proxy.v1` settings with `INSERT OR IGNORE`, and creates the
  sanitized `routing_request_logs` table plus created-time/app-time indexes.
- Every schema step runs in one SQLite transaction: create/verify schema,
  seed settings, record the SHA-384 checksum, set `PRAGMA user_version`, then
  commit. A failed step must leave the previous version and rows intact.
- Before applying any newer schema to an existing non-empty database, the WAL is
  checkpointed and the database is copied to
  `.cli-manager/backups/providers/providers.db.backup-<unix-ms>-<pid>.db`.
- Provider-domain initialization failure is logged as a warning and does not
  stop `cli-manager.db`, PTY, history, or the rest of desktop startup.
- No production provider command reads `providers.db` in Phase 0; later phases
  must add the domain repository/commands before removing CCS runtime reads.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Existing provider DB version is newer than the binary | `provider_db_version_unsupported`; preserve the file and continue app startup |
| Existing DB needs schema initialization | checkpoint, backup, apply schema, record checksum, then set version |
| Backup or schema initialization fails | `provider_db_backup_failed` / `provider_db_schema_failed`; preserve the main app startup |
| Required domain table is absent after initialization | `provider_db_table_missing`; do not expose the incomplete store |
| Routing log column/index is absent or malformed | `provider_db_column_missing` / `provider_db_index_missing` / `provider_db_index_invalid`; keep the prior schema version |
| Two current providers share one app type | partial unique-index violation; later command layer maps it to a stable provider error |
| Two active keys share one provider/type | partial unique-index violation; later command layer maps it to `provider_key_active_conflict` |

### 5. Good / Base / Bad Cases

- Good: a fresh data root creates schema v2, seeds the three common documents
  and eight routing settings, and leaves the historical `cli-manager.db`
  migration checksum unchanged.
- Base: an existing version-1 provider DB is checkpointed/backed up, upgraded
  without changing provider/key rows or an existing routing setting, and
  reopening version 2 is idempotent without a second backup.
- Base: a future-version DB is rejected before backup or mutation.
- Bad: putting the CCS-compatible tables into `cli-manager.db` or making
  startup fail because an optional provider DB cannot be opened.

### 6. Tests Required

- Assert WAL, foreign keys, both schema checksums, required table/index shape,
  the three common-config rows, and all routing defaults on a fresh database.
- Assert the same provider ID can exist for Claude and Codex, while a
  duplicate composite identity fails.
- Assert the composite key foreign key, cascade deletion, current-provider
  uniqueness, and active-key uniqueness.
- Assert a version-0 database is checkpointed/backed up and preserves its
  pre-existing marker.
- Assert version 1 -> 2 preserves provider/key/settings rows, produces one v1
  backup, rejects future versions without mutation, and rolls back both backup
  failure and malformed-routing-schema failure before `user_version` changes.
- Assert version-2 reopen is idempotent.
- Keep the historical v25/v26 migration checksum/registration tests passing.

### 7. Wrong vs Correct

#### Wrong

```text
open cli-manager.db -> add/alter the old provider tables -> mark provider current
```

This couples project/session startup to the removed prototype schema and can
invalidate existing SQLx migration checksums.

#### Correct

```text
legacy cli-manager.db migration unchanged
  -> open .cli-manager/providers.db with WAL/foreign keys/busy timeout
  -> checkpoint + backup before each required schema upgrade
  -> transactionally apply and verify independent provider-domain migrations
  -> warn and continue if this optional store cannot initialize
```

## Core data invariants

- Providers contain CCS-compatible `settings_config`, provider metadata,
  `meta.commonConfigEnabled`, ordering and at-most-one current record per
  app type.
- Type common config belongs in the `settings` key
  `common_config_<app_type>`; it is never attached to one provider.
- `provider_api_keys` has a composite foreign key to providers and a partial
  unique index enforcing at most one active key per provider/type.
- A ready/current/scope-selectable provider has exactly one enabled active key.
  A draft may have zero. Activating/deleting/disabling a key and projecting it
  into `settings_config` are one SQLite transaction.
- Product policy is plaintext `api_key` storage in SQLite. It does not
  authorize accidental dissemination: default list DTOs, logs, diagnostics,
  errors, sync/export and journal payloads are masked.
- Multi-key is manual only. Do not add automatic validation, health, rotation,
  quota, cooldown, rate-limit, round-robin, failover, KeyRing, or proxy code.

## Configuration and writer contract

- Claude editor/writer owns full `settings.json`; Codex owns full
  `auth.json` and `config.toml`; Grok Build owns full `config.toml`.
  Every type exposes base URL, active key and selected model as typed fields
  plus raw documents.
- Effective order is live non-owned fields + type common config + provider
  settings + active-key projection. Providers win scalar/table conflicts,
  arrays replace, JSON `null` is explicit override.
- Parse and merge in Rust. Use structured TOML editing where live user
  documents must retain comments/order. Frontend parsing is only an editor aid.
- Writers change only documented provider-owned paths. Preserve Hooks,
  permissions, MCP, project trust, statusline and unknown user fields.
- When a writer owns a credential-bearing document, it must remove stale
  provider credentials from every owned profile/entry before projecting the
  selected active key; an unselected Grok model profile or legacy top-level
  Codex auth field must not retain an imported credential.
- Global apply resolves a selected Home, stages/parses all target files,
  creates recoverable backups, replaces/verifies every target, then commits
  current state. Journal and compensate partial failure; recover unfinished
  operations on next startup. Codex must compensate both files.
- Scope launch snapshots are all-or-nothing: if materializing or writing any
  generated file, key projection, or manifest fails, remove the incomplete
  snapshot root before returning the error so no orphaned configuration or
  credential remains for later launch/recovery.

## Scope and Home contract

- Scope resolution is Worktree v2 reference > project v2 reference > native
  global current. A reference includes app type, source `cli-manager`,
  schema version and provider ID.
- Resolve and materialize providers only from `providers.db`. No name/UUID
  heuristic maps a legacy CCS reference; import refs perform the mapping or a
  repair issue is retained.
- Project materialization is not global switch: Claude generated settings +
  `--settings`; Codex process config overrides; Grok keeps the resolved real
  Home and applies the selected provider per process through `--model`,
  `GROK_MODELS_BASE_URL`, and `XAI_API_KEY`. Provider launches must never
  replace `GROK_HOME`, because Hook, MCP, history, skills, and user state share
  that Home. Secrets are child-process environment/config data, never shell
  command text. Remote SSH does not receive local key material.
- `CliHomeResolver` is the only default source for global targets, Hook/
  statusline targets and automatic history roots. Explicit feature roots have
  higher priority and must be labelled rather than overwritten.
- Home preferences are per local/WSL environment identity. Validate root
  directories; do not accept a CLI subdirectory as Home.
- The local identity `host` is never a WSL distribution. When a WSL Home
  request omits the environment identity, resolve the default distribution
  and its real `$HOME` inside WSL, then return the concrete distribution
  identity and normalized UNC Home. A manual WSL UNC path may supply the
  distribution identity when the explicit identity is absent.
- Saving a Home also persists one active Home identity in `providers.db`;
  startup restores that identity so no-explicit-root defaults follow the last
  saved Home. The per-environment preferences remain independent, and this
  active pointer must never override an explicit Hook or history root.

## IPC boundary

Group new Tauri commands under catalog, key, common, global, scope, Home,
environment and import prefixes. Rust validates all IDs, types, document
syntax, reference state, filesystem target, lock and secret projection.

Read DTOs are deliberately shaped:

- List/detail DTO: no full secret.
- Explicit credential/auth reveal: purpose-bound and not persisted by frontend
  state/logging.
- Effective/live preview: reveal credential only after explicit action and
  never reuse its payload in toasts, journal, diagnostics, or export.
- Environment result: variable name/scope/presence/masked fingerprint only.

Use stable error codes; never stringify an SQL error, raw config body, Home
contents, or secret into a user-visible command error.

## Scenario: Native provider catalog, Home apply, and scope resolution

### 1. Scope / Trigger

- Trigger: any new/changed Claude, Codex, or Grok provider; key; common
  configuration; global Home apply; project/Worktree reference; Home choice;
  or CCS import.
- Goal: replace CCS runtime coupling with a complete app-owned compatible
  provider domain without changing an active terminal session.

### 2. Signatures

```text
provider_catalog_list(appType) -> ProviderCard[]
provider_catalog_get(providerId, appType) -> ProviderEditor
provider_catalog_save(input) -> ProviderEditor
provider_key_set_active(providerId, appType, keyId) -> ProviderEditor
provider_common_get(appType) -> CommonConfig
provider_common_save(appType, document) -> CommonConfig
provider_global_preview(providerId, appType, homeIdentity) -> ApplyPreview
provider_global_apply(providerId, appType, homeIdentity, previewFingerprint) -> ApplyResult
provider_scope_resolve(projectId, worktreeId?, appType) -> ResolvedProvider
provider_home_select(environment, mode, homePath?) -> DerivedCliTargets
provider_home_active_get() -> DerivedCliTargets
provider_home_cached_get(environment) -> DerivedCliTargets | null
provider_wsl_list_distros() -> string[]
provider_environment_inspect(homeIdentity) -> EnvironmentReport
provider_import_preview(source) -> ImportPreview
provider_import_commit(previewId, options) -> ImportResult
```

- All provider/key calls include `appType`; the command must reject an ID/key
  owned by another type.
- `previewFingerprint` is required for apply so an external live-file edit
  cannot be overwritten from a stale preview.

### 3. Contracts

- `ProviderEditor` carries full editable documents and structured endpoint/
  model fields; list DTOs are secret-masked.
- `ApplyPreview` contains target paths, non-secret field diffs and live
  fingerprints. `ApplyResult` records verified target hashes and current
  state only after every writer succeeds.
- A key reveal/auth-editor command is explicit, non-cacheable and omitted from
  store persistence/logging; normal editor/list/diagnostic DTOs never include
  full key content.
- `DerivedCliTargets` is produced only by `CliHomeResolver`; it includes
  local/WSL identity and derived Claude/Codex/Grok config/history/Hook roots.
- `provider_wsl_list_distros` is a read-only bounded probe using `wsl.exe -l -q`;
  it returns trimmed non-empty distribution names and never resolves a Home.
- Manual WSL Home validation must use one bounded WSL command to validate
  directory, readable and writable status together, while preserving the
  stable validation error mapping. It must not launch one WSL process per
  predicate.

### 4. Validation & Error Matrix

| Condition | Error code / result |
| --- | --- |
| Unsupported or mismatched app type | `provider_app_type_invalid` / `provider_identity_mismatch` |
| Missing provider/current active key | `provider_not_ready` / `provider_key_not_active` |
| Invalid raw JSON/TOML or conflicting key projection | `provider_config_invalid` / `provider_key_projection_conflict` |
| More than one active key | database unique-index failure mapped to `provider_key_active_conflict` |
| Referenced provider disable/delete | `provider_referenced` with scope summary |
| Bad/readonly/unreachable Home | `provider_home_invalid` / `provider_home_not_writable` |
| WSL executable unavailable while listing distributions | `provider_wsl_unavailable` |
| WSL distribution list command times out or exits unsuccessfully | `provider_wsl_list_failed` |
| Live file changed after preview | `provider_apply_conflict` |
| Stage/replace/verify/restore failure | `provider_apply_failed` / `provider_recovery_required` |
| CCS source missing/corrupt/unsupported | `provider_import_source_invalid` |
| Unmapped legacy scope reference | persisted repair issue; no fallback resolution |

### 5. Good / Base / Bad Cases

- Good: activate Key B for current Codex provider, preview the changed
  `auth.json`/`config.toml`, explicitly apply, then a newly launched Codex
  process uses Key B while an old terminal is unchanged.
- Base: a draft provider with no key remains editable but cannot be global or
  scope selected.
- Bad: the project launch looks up a CCS provider by the same display name.
- Bad: common config is stored in the selected provider record or a Codex
  writer replaces the entire file and removes Hooks/MCP.

### 6. Tests Required

- Database: core CCS tables, composite identity, type common settings, active
  key unique index, key projection transaction, import reference idempotence.
- Writer: all type documents, unknown field preservation, external-change
  fingerprint conflict, Codex second-file failure compensation, crash journal
  recovery.
- Resolver: auto/manual local/WSL Home; explicit Hook/history overrides;
  Worktree > project > global; no CCS file in normal resolution.
- Import: mainline single key, PR multi-key, OAuth/empty/corrupt source,
  duplicated names, changed fingerprints and unmapped legacy reference.
- Multi-key import deduplication uses the source label plus an in-memory
  credential digest; it must never use a masked display value, because distinct
  short credentials can share the same mask. After deduplication, duplicate
  source labels receive deterministic numeric suffixes so the native schema's
  per-provider label uniqueness cannot discard a distinct credential; the same
  normalized labels must be used by preview and commit. Source keys are sorted
  by their source `sort_index` before this normalization, with deterministic
  tie-breakers.

### 7. Wrong vs Correct

#### Wrong

```text
set providers.is_current = 1
write ~/.codex/auth.json
write ~/.codex/config.toml
```

The database can say “current” while the second file fails.

#### Correct

```text
preview + lock + stage + parse + backup + replace all targets + verify
  -> commit current state and journal
  -> otherwise compensate files and retain recovery journal
```

## Scenario: Persisted active Home is restored when the settings page remounts

### 1. Scope / Trigger

- Trigger: the CLI Home settings surface is opened again after the user saved a
  local or WSL Home selection.
- Goal: restore the persisted active Home identity and derived targets without
  treating the initial page mount as an explicit Home re-detection request.

### 2. Signature

```text
provider_home_active_get() -> ProviderHomeState
```

### 3. Contracts

- The command is read-only and returns the active state restored by
  `initialize_cache`, including environment kind/id, mode, Home path and all
  derived CLI targets.
- It reads the existing active Home identity/cache and does not invoke a WSL
  `$HOME` probe or change the persisted preference.
- Explicit `provider_home_get`, `provider_home_select` and
  `provider_home_reset` semantics remain unchanged; only the initial settings
  page load uses the active-state read.
- `provider_home_cached_get` is read-only and returns only an already cached
  environment state. A cache miss returns `null`; it must never invoke local or
  WSL Home detection or fall back to another environment's state.

### 4. Validation & Error Matrix

| Condition | Error code / result |
| --- | --- |
| Active identity/cache is unavailable | `provider_home_active_unavailable` |
| Active WSL state was persisted previously | return the cached WSL state; do not silently fall back to local `host` |
| No prior active preference exists | initialization provides the local `host` state |

### 5. Good / Base / Bad Cases

- Good: save WSL distro A with a manual UNC Home, close settings, reopen, and
  receive WSL distro A plus the same manual path.
- Base: save local Home, reopen settings, and receive the local `host` state.
- Bad: remount the page by calling `provider_home_get(local, host)` and
  overwrite the displayed saved WSL state.

### 6. Tests Required

- Command registration and TypeScript invoke contract compile successfully.
- Home focused tests continue to cover local/WSL state derivation and active
  cache behavior.
- Manual runtime check: save WSL manual Home, close/reopen settings, and
  verify environment, distro, mode and path all remain unchanged.

### 7. Wrong vs Correct

#### Wrong

```text
settings_mount -> provider_home_get(local, host)
```

This discards the selected active identity in the settings UI even though the
backend preference was persisted.

#### Correct

```text
settings_mount -> provider_home_active_get()
explicit_refresh -> provider_home_get(current_draft_environment)
save -> provider_home_select(current_draft)
```

The initial read restores persisted state; only explicit actions perform the
corresponding detection or persistence transition.

## Required implementation verification

- Fresh and historical app databases start correctly.
- Core schema/composite FK/current/active-key constraints are enforced by DB.
- Claude/Codex/Grok raw documents and typed endpoint/model controls round-trip.
- Common config is type-scoped and merges with correct precedence.
- Global apply preserves non-owned fields and compensates partial writes.
- Local/WSL Home alignment covers global files, Hook and history defaults.
- History source shape checks for WSL UNC locations must use the same WSL-aware
  existence probe as root validation; never call host `Path::is_dir/is_file`
  for a WSL path.
- CCS import WSL source probes and read-only snapshot commands must use the
  shared bounded subprocess helper; a stopped or unhealthy WSL distribution
  must return an import error instead of blocking the settings UI.
- Worktree/project/global precedence and launch snapshots work with CCS absent.
- Single/multi-key CCS import is previewable, idempotent and has no heuristic
  reference fallback.

## Acceptance closeout boundary (2026-08-03)

- Windows-side Rust and TypeScript checks are not evidence of a real WSL write/import run. If `wsl.exe --status` or `--list --quiet` cannot provide a working distribution and Python SQLite runtime, the WSL acceptance items remain `BLOCKED`.
- The three global writers, compensation, journal recovery, external-modification protection, and Home/Hook/History alignment require a real writable Home run in addition to unit tests; unit tests must not be reported as that manual evidence.
- Native production runtime must retain only the read-only CCS import adapter. No production path may call CCS list/prepare/reset/switch operations after cutover.

## Common configuration validation command (2026-08-04)

- `provider_common_config_validate` accepts the same `CommonConfigSetInput` as
  `provider_common_config_set` and returns no document or secret data.
- It validates app type, expected format, JSON object shape and TOML syntax
  without opening a write transaction or changing the `settings` row.
- `provider_common_config_set` calls the same repository validator before its
  database write; validate and save therefore cannot drift in accepted syntax.

## Common configuration is format-validated only (2026-09-01, issue #241)

- Common configuration validation is **format-only**: JSON object shape for
  Claude, TOML syntax for Codex/Grok Build. There is no secret-field gate, and
  `provider_common_config_contains_secret` is no longer emitted by any path.
- Rationale: the gate matched `token`/`key`/`secret`/`password`/`credential`/
  `authorization` as **substrings of field names**, so ordinary CLI options such
  as `model_auto_compact_token_limit` and `requires_openai_auth` were rejected as
  secrets. Substring field-name matching cannot distinguish a credential from an
  option that merely mentions one.
- `provider_common_config_get` / `_set` return the stored document **verbatim,
  never redacted**. The editor is a round-trip surface: masking a value the user
  just typed would make the next save persist `[REDACTED]`. Redaction stays on
  the provider document and effective-preview DTOs, which are display-only.
- Whether a credential belongs in common configuration is the user's decision.
  The key manager remains the recommended place, not an enforced one.

## Provider editor and current-state feedback contract (2026-08-04)

### 1. Scope / Trigger

- Trigger: provider create/edit now accepts a provider-specific JSON/TOML
  document, and `provider_global_current` must recognize an already materialized
  Home even when `providers.is_current` was never committed by CLI-Manager.

### 2. Signatures

- `provider_catalog_update(input: ProviderUpdateInput) -> ProviderDetail`
- `provider_global_current(input: GlobalCurrentInput) -> GlobalCurrent`
- Internal `merge_settings_config_update(app_type, existing, incoming)` keeps
  the persisted JSON envelope while validating the nested Codex/Grok TOML.

### 3. Contracts

- Update input may contain `settingsConfig`; Claude uses a JSON object, Codex
  and Grok Build use `{ "config": "<TOML>" }` plus any existing envelope fields.
- Existing JSON secret fields and TOML secret paths remain owned by the key
  manager. A provider document edit may change non-secret fields only.
- Current detection scans active-key candidates for a plan whose every target
  live byte sequence equals its desired byte sequence. Exact materialized match
  takes precedence over a stale `is_current` flag; the flag remains a fallback
  for drift, missing-key and unavailable states.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Incoming settings is not a JSON object | `provider_settings_must_be_object` |
| Claude document is invalid JSON | `provider_settings_invalid_json` |
| Codex/Grok nested config is invalid TOML | `provider_config_invalid` |
| Existing TOML secret cannot be safely preserved | `provider_document_secret_edit_requires_key_manager` |
| Exact target match found | current provider name/id with `applied` state |
| Only database current flag found | current provider with computed drift/key-missing/unavailable state |
| No match and no current flag | `not_set` |

### 5. Good / Base / Bad Cases

- Good: edit Codex `config.toml` model while its API key is redacted; the
  model changes and the stored key remains byte-for-byte unchanged.
- Base: imported Home files match one active-key provider even when all
  database `is_current` flags are zero; current status names that provider.
- Bad: trust the masked key returned to the frontend and overwrite the real
  key with `***` or `[REDACTED]`.
- Bad: identify current only from `providers.is_current` after an external or
  CCS-created configuration already exists on disk.

### 6. Tests Required

- Repository unit tests assert JSON and TOML key-manager-owned secrets survive
  provider document updates while non-secret fields change.
- Global unit tests assert a plan matches only when every target matches and
  rejects a single changed target.
- Runtime acceptance must still verify actual local/WSL target recognition,
  external modification protection, compensation and journal recovery.

### 7. Wrong vs Correct

#### Wrong

```text
incoming.settingsConfig -> normalize -> UPDATE providers
provider_global_current -> SELECT ... WHERE is_current = 1
```

#### Correct

```text
incoming settings -> preserve key-manager-owned JSON/TOML secrets
  -> validate envelope and nested format -> UPDATE providers
global current -> build each active-key plan -> compare every target
  -> exact file match first, database flag fallback for drift reporting
```

## 8. Global apply display and preflight contract (2026-08-04)

- `ProviderHomeState.homePath` is the parent Home directory. Confirmation UI
  must select the app-specific target root from `ProviderHomeState.targets`;
  it must not present `homePath` as the actual Claude/Codex/Grok write target.
- The explicit preview action is optional at the UI boundary. When the user
  clicks Apply without an existing preview, the frontend must obtain a fresh
  `GlobalPreview` and use its fingerprint with `provider_global_apply`.
- The backend apply command continues to require a fingerprint. This keeps
  locks, live-file conflict detection, staging, verification, compensation and
  journal recovery unchanged while removing only the user-facing click-order
  requirement.

## Provider advanced metadata and generated documents (2026-08-04)

- The existing provider `settingsConfig` envelope may contain an `advanced`
  object for Codex/Grok maintenance metadata. Repository update/merge paths
  round-trip unknown envelope fields; they must not be interpreted as secret
  material or silently discarded.
- Runtime materializers consume only CLI-recognized typed fields and the nested
  provider document. The frontend-generated Claude JSON, Codex TOML and Grok
  TOML are seed documents for an empty provider record; backend validation and
  key-manager-owned secret projection remain authoritative on save/apply.
- No IPC signature or writer contract changes are required for this metadata.
  Global writers continue to use existing target-specific config files,
  fingerprint checks, compensation and journal recovery.

## Scenario: Provider model discovery and generated target documents (2026-08-05)

### 1. Scope / Trigger

- Trigger: fetching models from a persisted Claude/Codex/Grok provider or
  materializing global/project provider files after common-config merge.

### 2. Signatures

```text
provider_fetch_models(input: FetchModelsInput) -> FetchModelsResult
FetchModelsInput = { appType, providerId, baseUrl, isFullUrl?, apiFormat?, apiKeyField? }
FetchModelsResult = { models: string[] }
```

### 3. Contracts

- The backend resolves the enabled active key; plaintext never crosses the IPC
  response. Standard Base URLs append `/v1/models`; a full URL is used exactly.
- Model responses accept an array, `data[]`, or `models[]`; string entries and
  object `id`/`name` entries are trimmed, sorted and deduplicated.
- Claude project snapshots serialize the complete effective JSON after common
  merge and key projection. Do not pass it through the partial global writer.
- Codex writes plaintext only to root-level `auth.json.OPENAI_API_KEY`.
  `config.toml` contains no API key or `env_key`; endpoint/wire fields belong
  under `[model_providers.<name>]`, never at the TOML root.

### 4. Validation & Error Matrix

| Condition | Error |
| --- | --- |
| Missing enabled active key | `provider_models_active_key_required` |
| Empty Base URL | `provider_models_base_url_required` |
| Request/timeout failure | `provider_models_request_failed` |
| Non-JSON response | `provider_models_invalid_response` |
| Non-success HTTP | `provider_models_http_<status>` |
| Empty/unsupported list | `provider_models_empty` |

### 5. Good / Base / Bad Cases

- Good: `/v1/models` returns duplicate IDs; the UI receives one sorted entry
  per ID and no credential.
- Base: an existing provider without an active key remains editable but model
  discovery returns a stable error.
- Bad: put the Codex key or `env_key` in `config.toml`, nest it under an `auth`
  object in `auth.json`, or drop common fields from a Claude snapshot.

### 6. Tests Required

- Unit-test full/base URL construction and all accepted model list shapes.
- Assert Claude snapshot bytes retain both common and provider fields.
- Assert Codex auth is root-level `OPENAI_API_KEY`; config removes root endpoint
  aliases, secrets and `env_key` while preserving unowned MCP/Hook sections.

### 7. Wrong vs Correct

#### Wrong

```text
config.toml: env_key = "CLI_MANAGER_PROVIDER_KEY"
auth.json: { "auth": { "OPENAI_API_KEY": "..." } }
```

#### Correct

```text
auth.json: { "OPENAI_API_KEY": "..." }
config.toml: model_provider + [model_providers.<name>] without credentials
```

## Scenario: Codex scoped providers preserve the real Home (2026-08-06)

### 1. Scope / Trigger

- Trigger: launching or resuming local Codex with the native global provider,
  a project override, a Worktree override, or an explicit restored provider.
- `CODEX_HOME` owns config, Hooks, MCP, sandbox policy, plugins, skills,
  project trust and sessions. It is not a provider-only config path.

### 2. Signatures

```text
provider_scope_prepare(input: ScopePrepareInput) -> ProviderLaunchSnapshot?
ProviderLaunchSnapshot.configOverrides: string[]
ProviderLaunchSnapshot.codexProfileName: string?
ProviderLaunchConfig = { appType, providerId, snapshotId, claudeSettingsPath?, generatedHome?, grokModel? }
```

### 3. Contracts

- Codex global resolution returns `null`: global apply already materialized the
  provider into the selected real Home, so launch must not create a snapshot
  or override `CODEX_HOME`.
- Codex project/Worktree/explicit resolution returns a snapshot containing a
  secret key file plus a generated non-secret profile name. The profile is
  written beside the selected real Codex Home config and the command uses
  `--profile <name>`; it must not redirect `CODEX_HOME` or create a generated
  `auth.json`/`generatedHome`.
- PTY preparation validates the snapshot manifest, injects the active key as
  `CLI_MANAGER_PROVIDER_KEY`, and leaves `CODEX_HOME` unchanged.
- The frontend appends `--profile <name>` only to a direct Codex command;
  legacy snapshots without a profile name may continue using their existing
  `-c` overrides. SSH continues to discard local provider launch data.
- Persisted legacy Codex snapshots with `generatedHome` remain invalid; a
  snapshot without `codexProfileName` may use its existing `configOverrides`
  fallback until the next fresh launch rebuilds it.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Global Codex provider | `provider_scope_prepare` returns `null`; use real Home |
| Scoped Codex command is not direct | `provider_codex_command_unsupported`; release snapshot |
| Override contains quotes, control or shell interpolation characters | `provider_config_invalid` / `provider_codex_override_invalid` |
| Snapshot carries legacy Codex `generatedHome` | `provider_snapshot_mismatch` |
| Missing/empty snapshot key | `provider_snapshot_missing` / `provider_snapshot_invalid` |

### 5. Good / Base / Bad Cases

- Good: a project override changes endpoint/model/key while the real Home MCP,
  Hook, `danger-full-access` sandbox and sessions remain available.
- Base: follow-global launches with no provider snapshot and uses the files
  written by global apply.
- Bad: point `CODEX_HOME` at a generated directory containing only
  `auth.json` and `config.toml`; this hides Hooks, MCP, sandbox and history.

### 6. Tests Required

- Assert global Codex selection is passthrough and project/Worktree sources
  still materialize scoped launch data.
- Assert scoped snapshots create no isolated Codex Home, expose no secret in
  the profile or DTO, and keep the key only in the protected snapshot
  file/environment.
- Assert direct new/resume commands receive `--profile`, unsupported commands
  fail closed, and legacy `-c` fallback remains available.
- Type-check all launch DTO consumers and run provider module Rust tests.

### 7. Wrong vs Correct

#### Wrong

```text
provider scope -> generated/codex/{auth.json,config.toml}
  -> CODEX_HOME=generated/codex -> Hooks/MCP/sandbox/sessions disappear
```

#### Correct

```text
global -> real Home files, no snapshot
project/Worktree -> real CODEX_HOME + non-secret `--profile` profile
  + active key in PTY child environment
```

## Scenario: Grok scoped providers preserve the real Home (2026-08-06)

### 1. Scope / Trigger

- Trigger: launching local Grok Build with a native global provider, project
  override, Worktree override, or explicit restored provider.
- `GROK_HOME` owns Hook, MCP, sessions, skills, plugins and other user state;
  it is not a provider-only configuration path.

### 2. Signatures

```text
ProviderLaunchSnapshot.grokModel: string?
PTY environment: GROK_MODELS_BASE_URL + XAI_API_KEY
startup command: grok --model <validated-model> ...
```

### 3. Contracts

- Global Grok resolution returns `null` like every other app type: global apply
  already wrote the provider into the real Home `config.toml`, so launch must
  not inject `GROK_MODELS_BASE_URL` / `XAI_API_KEY` / `--model`.
- Every scoped (project / Worktree / explicit) Grok provider keeps the resolved
  real Home and returns a
  releasable snapshot containing a secret key file plus manifest-validated
  Base URL/model metadata. It must not create a generated Grok Home or set
  `GROK_HOME` in child-process overrides.
- PTY preparation validates provider/snapshot/model identity before reading the
  key and injecting `GROK_MODELS_BASE_URL` plus `XAI_API_KEY`.
- The frontend replaces any existing `-m`/`--model` argument with one safely
  quoted `--model` value on direct Grok commands. Model IDs accept only the
  bounded identifier character set; unsupported wrapper commands fail closed.
- Persisted legacy Grok snapshots with `generatedHome` or without `grokModel`
  are released and rebuilt before PTY recreation.
- SSH continues to discard local provider snapshots and secrets.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Snapshot contains a generated Grok Home | `provider_snapshot_mismatch` |
| Manifest lacks Base URL/model or key | `provider_snapshot_invalid` / `provider_snapshot_missing` |
| DTO model differs from manifest | `provider_snapshot_mismatch` |
| Startup command is not direct Grok | `provider_grok_command_unsupported`; release snapshot |
| Model contains whitespace, quotes, controls or shell metacharacters | `provider_grok_model_invalid` |

### 5. Good / Base / Bad Cases

- Good: two Worktree terminals select different Grok providers; each receives
  its own endpoint/key/model while both read the same real Hook/MCP/history.
- Base: a global provider launch returns `null` from `provider_scope_prepare`;
  the terminal uses only the live `config.toml` already written by global apply,
  with no snapshot, env overrides, or `--model` flag.
- Bad: point `GROK_HOME` at a snapshot containing only `config.toml`; this
  hides Hook, MCP, sessions, skills and realtime history consumers.

### 6. Tests Required

- Assert Grok snapshot creation writes no generated Home/config and returns the
  selected model with manifest Base URL/model metadata.
- Assert PTY environment injection preserves an existing `GROK_HOME` while
  replacing endpoint/key only.
- Assert command handling replaces existing model flags, rejects wrapper and
  unsafe model input, and keeps resume arguments.

### 7. Wrong vs Correct

#### Wrong

```text
provider scope -> generated/grokbuild/<snapshot>/grok/config.toml
  -> GROK_HOME=generated/grokbuild/<snapshot>/grok
  -> real Hook/MCP/sessions/skills disappear
```

#### Correct

```text
provider scope -> manifest(base URL/model) + protected key file
  -> real GROK_HOME unchanged
  -> GROK_MODELS_BASE_URL + XAI_API_KEY + grok --model <model>
```

## Scenario: Global provider passthrough and restore re-resolution (2026-08-07)

### 1. Scope / Trigger

- Trigger: launching, restoring, or resuming any local Claude / Codex / Grok
  terminal whose project has no Worktree, project, or explicit provider
  override — i.e. the project follows the native global provider.
- Generated snapshots exist to isolate an *override*. A follow-global launch has
  nothing to isolate: global apply already wrote the provider into the real Home.

### 2. Signatures

```text
scope_override(appType, input) -> Option<(providerId, "explicit"|"worktree"|"project")>
prepare(input) -> None when scope_override is None
resolve(input) -> ResolvedProvider  // still falls back to global current for UI probing
```

### 3. Contracts

- `prepare()` must call `scope_override()` and return `None` before resolving the
  global current provider. Resolving global current first is a defect: an
  imported-but-never-applied catalog has `is_current = 0` for every row, so
  `current_provider_id()` returns `provider_current_not_set` and blocks terminal
  creation for a project that needs no snapshot at all.
- Passthrough is uniform across `claude`, `codex` and `grokbuild`. No app type
  may special-case itself back into snapshot generation for a global source.
- `provider_scope_resolve` keeps the full Worktree > project > global fallback so
  the switch modal can still display `source: "global"` plus the current global
  provider name. Only `prepare()` short-circuits.
- Session restore never reuses a persisted snapshot. Snapshot IDs are
  single-launch: they are released on close and garbage-collected on startup, and
  they do not reflect override or global-current changes made between sessions.
  Restore releases the persisted snapshot and re-resolves from current state.
- Restore writeback must not fall back to the persisted snapshot
  (`launch.providerSnapshot ?? persisted` is wrong). A follow-global restore
  writes `undefined`, so a released snapshot ID is never persisted again.
- Daemon attach is exempt: the process is still alive and must not be hot
  switched, so it keeps its existing snapshot reference.
- A global apply targets one Home identity. A project launched under a different
  environment (local Home applied, launched through WSL, or the reverse) does not
  receive the provider; the user re-applies under that Home. Launch must not
  fabricate a snapshot to bridge the gap.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| No Worktree/project/explicit override | `prepare` returns `null`; command stays bare (`claude`, `codex`, `grok`) |
| No project ID at all (ad-hoc terminal) | `scope_override` returns `None`; passthrough |
| App database unavailable | `scope_override` returns `None`; passthrough rather than a hard launch failure |
| Explicit provider ID present | `"explicit"`; snapshot is built even when it equals the global current |
| Catalog imported but never applied globally | passthrough; no `provider_current_not_set` on launch |
| Persisted snapshot present at restore | released, then re-resolved from current scope |

### 5. Good / Base / Bad Cases

- Good: a project follows global; `claude` launches bare and reads the live
  `~/.claude/settings.json` written by global apply, keeping hooks, permissions
  and statusline.
- Base: the same project later gains a project override; the next launch appends
  `--settings <generated>` again with no other behavior change.
- Bad: appending `--settings <generated>/<uuid>/claude/settings.json` for a
  follow-global project. This makes the "global" switch a per-launch override,
  contradicts the Scope and Home contract, and strands the user when the
  snapshot is garbage-collected before a restore.

### 6. Tests Required

- Assert `scope_override` returns `None` for every snapshot app type when no
  explicit/Worktree/project ID is supplied, including blank-string IDs.
- Assert an explicit provider ID resolves to `"explicit"` for every app type and
  never falls through to global.
- Type-check the restore/resume writeback so a released snapshot cannot be
  reassigned to the recreated session.

### 7. Wrong vs Correct

#### Wrong

```text
prepare -> resolve_selection -> current_provider_id()
  -> global provider -> snapshot -> claude --settings <generated>
  (and provider_current_not_set when nothing was ever applied)
```

#### Correct

```text
prepare -> scope_override -> None -> Ok(None)
  -> bare `claude` -> live Home settings.json from global apply
restore -> release persisted snapshot -> re-resolve current scope
```

## Scenario: Recover history written by legacy Grok snapshots (2026-08-06)

### 1. Scope / Trigger

- Trigger: release or garbage collection encounters an old Grok snapshot whose
  generated `grok/sessions` contains session directories.

### 2. Signatures

```text
release_snapshot(snapshotId) -> Result<(), provider_snapshot_history_recovery_*>
garbage_collect_snapshots(activeSnapshotIds) -> Result<(), provider_snapshot_history_recovery_*>
backup root = <cli-manager>/backups/provider-grok-history/<snapshotId>/sessions
```

### 3. Contracts

- Snapshot deletion is ordered after recovery: atomically stage a durable
  backup, copy only absent project/session directories into the current real
  Grok history root, then delete the snapshot.
- Existing destination sessions are never overwritten. The durable backup is
  retained after success and is the manual recovery source for conflicts.
- Copy only regular files/directories and reject symlinks or special entries.
- Any backup/restore failure aborts deletion, so source history remains
  retryable. WSL UNC targets fail closed because host `std::fs` access is not a
  valid WSL history operation.
- New Grok snapshots contain no generated Home/sessions and take the ordinary
  empty-recovery path.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| No legacy session directory | Continue normal snapshot deletion |
| Existing real session ID | Keep real session; retain legacy copy in backup |
| Backup/restore I/O failure | `provider_snapshot_history_recovery_failed`; keep source snapshot |
| Symlink/special entry | `provider_snapshot_history_recovery_unsafe_entry`; keep source snapshot |
| WSL UNC target | `provider_snapshot_history_recovery_wsl_unsupported`; keep source snapshot |

### 5. Good / Base / Bad Cases

- Good: legacy session is backed up, restored under the same project/session
  path, then the obsolete snapshot is removed.
- Base: retry after successful backup/restore is idempotent and changes no
  existing destination bytes.
- Bad: recursively delete a Grok snapshot before checking `grok/sessions`.

### 6. Tests Required

- Assert backup and restore preserve session bytes and repeated calls succeed.
- Assert an existing real session is not overwritten while backup keeps the
  legacy bytes.
- Assert WSL target rejection occurs before backup/source mutation.
- Run provider scope/module tests and `cargo check`.

### 7. Wrong vs Correct

#### Wrong

```text
release/GC -> remove_dir_all(snapshot) -> legacy Grok conversation is lost
```

#### Correct

```text
release/GC -> backup -> restore missing sessions -> remove snapshot
           -> on any error: keep snapshot
```

## Scenario: Grok history IPC uses the session root (2026-08-06)

### 1. Scope / Trigger

- Trigger: the frontend loads Grok history after the history source settings
  store has an active `locations.sessionRoot` instance.
- The IPC field `grokSessionRoot` is already the complete
  `<home>/.grok/sessions` directory.

### 2. Signatures

```text
HistoryRoots.grok_session_root = <home>/.grok/sessions
resolve_grok_history_root(roots) -> <home>/.grok/sessions
collect_grok_session_files(root) -> scans root/*/*/updates.jsonl
```

### 3. Contracts

- `HistoryRoots.grok_session_root` and `resolve_grok_history_root` represent
  the complete Grok session root, not the parent `.grok` configuration root.
- Explicit `grokSessionRoot` values are used as-is after whitespace/path
  normalization. The scanner and exact-session lookup must not append another
  `sessions` segment.
- When no explicit root is supplied, the default resolver returns the real
  user's `.grok/sessions` directory.
- List, exact lookup, detail validation, search, stats and catalog refresh share
  this same root contract.
- The IPC command signatures and frontend history source settings schema remain
  unchanged.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Explicit root is `<home>/.grok/sessions` | Scan sessions directly below root |
| Explicit root contains no sessions | Return an empty list without error |
| No explicit root | Resolve the real default `.grok/sessions` |
| Root path is WSL UNC | Preserve existing WSL-aware handling |
| Path would be `<home>/.grok/sessions/sessions` | Never construct or scan it |

### 5. Good / Base / Bad Cases

- Good: a session under `<root>/<project>/<session>/updates.jsonl` appears in
  history when the frontend passes `<root>` as `grokSessionRoot`.
- Base: default and explicit roots produce the same session shape and project
  filtering behavior.
- Bad: treat the IPC `sessionRoot` as a config root and append `sessions` a
  second time.

### 6. Tests Required

- Assert an explicit `.grok/sessions` root is scanned without a duplicate
  `sessions` segment.
- Assert the Grok parser and exact-session lookup use a session-root fixture.
- Keep catalog/history module tests and `cargo check` passing.

### 7. Wrong vs Correct

#### Wrong

```text
frontend sessionRoot = <home>/.grok/sessions
  -> backend collect(root.join("sessions"))
  -> <home>/.grok/sessions/sessions
```

#### Correct

```text
frontend sessionRoot = <home>/.grok/sessions
  -> backend collect(root)
  -> <home>/.grok/sessions/<project>/<session>/updates.jsonl
```

## Scenario: Preferred local-routing port editing (2026-08-09)

### 1. Scope / Trigger

- Trigger: the routing settings UI edits the persisted preferred listener port.
- Goal: allow a user-selected port without leaving an active Home projection
  pointing at an old route endpoint.

### 2. Signatures

```text
routing_set_preferred_port(port: u16) -> RoutingState
```

### 3. Contracts

- `port` must be in the existing service-config range `1024..=65535`.
- The command persists `routing.service.v1.preferred_port` and returns the
  normal persisted service plus daemon state DTO.
- The command accepts a port change only when the local routing service is
  stopped and the takeover list is empty. The next service start uses the
  saved port.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Port below 1024 | `routing_port_invalid` |
| Service is enabled | `routing_port_change_requires_service_disabled` |
| Any Home takeover remains | `routing_port_change_requires_takeover_disabled` |
| Same as persisted port | return current state without a write |

### 5. Good/Base/Bad Cases

- Good: stop routing, remove takeovers, save port `18080`, then start routing;
  the listener selects `18080` as its preferred candidate.
- Base: the UI disables the input while service/takeovers are active and
  explains the prerequisite in both supported locales.
- Bad: live-change only the listener port while leaving a takeover's stored
  endpoint and Home projection on the previous port.

### 6. Tests Required

- Rust: `validate_service_config` rejects `1023` with `routing_port_invalid`.
- Rust: routing service tests continue to cover listener start/reload and
  occupied-port fallback behavior.
- Frontend: type-check the port input and command payload; manually verify
  save/disable/re-enable in both `zh-CN` and `en-US`.

### 7. Wrong vs Correct

#### Wrong

```text
running listener + active takeover
  -> overwrite preferred_port only
  -> Home still points to the old endpoint
```

#### Correct

```text
stop routing + remove takeovers
  -> persist preferred_port
  -> start routing with the new preferred candidate
```

## Scenario: Streaming failover circuit and provider memory (2026-08-09)

### 1. Scope / Trigger

- Trigger: an enabled failover route returns an HTTP success response but its
  SSE stream ends before the protocol completion event.
- Goal: avoid repeating the failed provider during CLI reconnects and retain
  the successful fallback provider for the next request.

### 2. Contracts

- Codex Responses streaming is successful only after `response.completed`.
  `error`, `response.failed`, early EOF, upstream read errors, and timeouts
  before completion are failures.
- A streaming failure opens that provider's runtime circuit immediately. The
  next request skips it and tries the next eligible queued provider.
- After a fallback provider completes successfully, it becomes the current
  provider through the existing hot-switch path. Daemon failover selection
  promotes that current eligible provider to the front while preserving the
  saved order of the remaining queue.
- The already-started HTTP stream is not replayed mid-response; failover is
  applied to the next client request/reconnect.

### 3. Tests Required

- Assert Codex Responses output chunks do not settle success before
  `response.completed`.
- Assert an incomplete stream records a failure using an immediate-open
  policy.
- Assert the current eligible provider is promoted ahead of the saved queue
  order for daemon selection.

## Scenario: Automatic failover current-provider identity commit (2026-08-17)

### 1. Scope / Trigger

- Trigger: automatic failover selects a provider and reaches the existing
  non-streaming or streaming success-commit boundary.
- Goal: keep `providers.is_current` aligned with the provider that actually
  completed the routed request, including when the saved queue excludes the
  previous current provider.

### 2. Signatures

```text
ProviderSnapshot { provider_id, is_current, ... }
should_hot_switch_provider(auto_failover_enabled, selected_provider_is_current, status)
apply_hot_switch_for_active_homes(app_type, next_provider_id)
```

### 3. Contracts

- Candidate position is an attempt-order property, not provider identity.
  Queue index `0` may still be a non-current provider when the previous
  current provider is not eligible or is absent from the queue.
- A successful automatic request schedules the existing safe hot-switch path
  whenever the selected request snapshot was not current. An already-current
  provider does not schedule a redundant switch.
- Non-streaming requests commit only after the complete successful body is
  read. Streaming requests commit only after the protocol-specific semantic
  completion event. Failure, incomplete stream, timeout, or client
  cancellation must not update `is_current`.
- `attempt_index`, `attempt_count`, and `degraded` continue to describe the
  request's candidate traversal. Do not derive provider-current identity from
  those usage fields.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Automatic failover off | Do not schedule automatic hot switch |
| Selected snapshot is already current | Keep current provider; no redundant switch |
| Non-current provider completes successfully | Run the existing hot-switch/commit path |
| Non-current provider returns failure or its stream does not complete | Keep the previous current provider |

### 5. Good / Base / Bad Cases

- Good: current A is outside queue `[B, C]`; B succeeds at index `0`, becomes
  current, and is highlighted by all `isCurrent` consumers after refresh.
- Base: current A is eligible and succeeds at index `0`; no hot switch occurs.
- Bad: treat `selected_provider_index > 0` as proof of provider change; B at
  index `0` then serves requests while A remains highlighted.

### 6. Tests Required

- Assert a non-current candidate at index `0` requires a hot switch on success.
- Assert current candidates, disabled automatic failover, and failed HTTP
  responses do not require a switch.
- Preserve streaming tracker tests proving completion succeeds while failure,
  early EOF, timeout, and cancellation cannot commit the switch.

### 7. Wrong vs Correct

#### Wrong

```text
should_switch = selected_provider_index > 0
```

#### Correct

```text
should_switch = auto_failover_enabled
  && !selected_provider_is_current
  && response_is_success
```

## Scenario: Persisted routing intent and daemon runtime reconciliation (2026-08-09)

### 1. Scope / Trigger

- Trigger: the GUI connects to or spawns a daemon, or a later routing refresh
  finds that persisted service intent differs from daemon runtime.
- Goal: do not present a stopped listener as enabled, and restore the desired
  listener without depending on a specific frontend page mounting.

### 2. Signatures

```text
reconcile_persisted_service(client) -> RoutingState
routing_set_service_enabled(enabled) -> RoutingState
RoutingStart { listener_addresses, preferred_port, last_actual_port }
```

### 3. Contracts

- `service_enabled` is the persisted desired state; `daemon.status` is the
  runtime truth used by the UI and takeover/failover gating.
- After `connect_or_spawn` returns a valid client, the Rust startup path must
  reconcile persisted service intent before publishing that client through
  `DaemonBridge`. Recovery cannot be owned only by Settings or sidebar Hooks.
- Enabled intent plus a stopped daemon sends `RoutingStart` with the complete
  persisted local/WSL listener set, preferred port, and last actual port.
  Running runtime is an idempotent no-op; disabled intent must not start it.
- A successful start persists the returned actual port without changing the
  user's enabled intent. A persistence failure rolls back the runtime action.
- Recovery failure is logged with a sanitized error code and must not prevent
  the valid daemon client from being installed in `DaemonBridge`.
- If persisted service intent is enabled while the daemon is stopped, routing
  state refresh attempts `RoutingStart` and keeps the real stopped state visible
  if recovery fails.
- Re-enabling an already-persisted service must reconcile the daemon instead of
  returning early.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Intent disabled + runtime stopped | No-op; do not start listener |
| Intent enabled + runtime running | No-op; preserve listener and actual port |
| Intent enabled + runtime stopped | Start complete persisted listener set and save actual port |
| WSL NAT gateway no longer matches takeover | Reject recovery with existing gateway-changed error; keep bridge usable |
| Runtime action succeeds but persistence fails | Roll back start/stop and return sanitized persistence error |
| Daemon lacks routing capability | Skip recovery, install bridge, expose unsupported runtime truth |

### 5. Good / Base / Bad Cases

- Good: routing was enabled, a new daemon starts stopped, startup reconciliation
  restores it before any provider UI is opened.
- Base: an existing daemon still owns the running listener; reconnect is a no-op.
- Bad: restore only in `useNativeProviderRouting`, leaving sidebar-only startup
  with enabled intent and a stopped listener.

### 6. Tests Required

- Assert enabled/stopped chooses Start, enabled/running is a no-op,
  disabled/running chooses Stop, and disabled/stopped is a no-op.
- Assert the start frame preserves the complete listener list plus preferred
  and last actual ports.
- Run daemon routing tests, full Rust tests, and `cargo check`; manually smoke
  test enable -> app/daemon exit -> app relaunch without opening Settings.

### 7. Wrong vs Correct

#### Wrong

```text
daemon connected -> publish bridge -> wait for Settings Hook to restore route
```

#### Correct

```text
daemon connected -> reconcile persisted intent -> publish bridge
```

- Resetting failover circuits also resets the active route provider to the first
  ready provider in the saved queue order when an active takeover exists.
- Each failover request logs the ordered candidate IDs, snapshot-load skips,
  circuit skips, actual attempts, upstream status classification, stream
  completion/failure, and the final selected provider so queue traversal can be
  diagnosed from daemon logs.

## Scenario: Manual hot-switch queue mode (2026-08-09)

### 1. Scope / Trigger

- Trigger: an active CLI Home takeover with automatic failover disabled.
- Goal: reuse the failover queue as a single-provider manual route selector.

### 2. Signatures

- `routing_set_failover_queue(input: RoutingFailoverQueueInput) -> RoutingFailoverState`
- `set_failover_enabled(app_type: &str, enabled: bool) -> RoutingFailoverState`
- `apply_hot_switch_for_active_homes(app_type: &str, next_provider_id: &str)`

### 3. Contracts

- With automatic failover disabled, the queue contains exactly one ready
  provider; selecting it hot-switches active takeovers and updates `is_current`.
- With automatic failover enabled, multiple ready providers are allowed and the
  daemon traverses them by queue order and circuit state.
- Disabling automatic failover normalizes the queue to the current provider;
  enabling it preserves that provider as the initial queue entry.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Automatic failover off and queue length is not one | `routing_failover_manual_queue_single` |
| Automatic failover on and queue is empty | `routing_failover_queue_empty` |
| Selected provider is not ready | `routing_provider_not_ready` |
| Hot switch fails | Restore the previous queue and return the error |

### 5. Good / Base / Bad

- Good: selecting B produces `[B]`, applies the hot switch, and marks B current.
- Base: automatic mode keeps a multi-provider queue for traversal.
- Bad: an empty or multi-provider manual queue is rejected.

### 6. Tests Required

- Reject manual queues with zero or multiple providers.
- Restore the previous queue when a hot switch fails.
- Verify multi-provider traversal is only available when automatic failover is on.

### 7. Wrong vs Correct

- Wrong: manual mode stores `[A, B]`, leaving the active route ambiguous.
- Correct: manual mode stores `[B]` and hot-switches to B; automatic mode stores
  `[A, B]` and lets failover traverse it.

## Scenario: Automatic failover circuit lifecycle (2026-08-19)

### 1. Scope / Trigger

- Trigger: the user enables or disables automatic failover for one app type.
- Goal: prevent a circuit state from leaking across failover toggle cycles or
  appearing while the app is in manual hot-switch mode.

### 2. Contracts

- A successful automatic-failover toggle resets every daemon circuit entry for
  that app type before the new mode is used; other app types are unchanged.
- When automatic failover is disabled, provider surfaces derive availability
  from provider readiness and do not render cached `open` or `halfOpen` circuit
  labels from daemon snapshots.
- Re-enabling automatic failover starts from closed circuit counters; later
  real upstream failures may establish new circuit state normally.
- The reset is runtime-only. It does not change provider order, the saved
  queue, the current provider, or circuit policy parameters.

### 3. Tests Required

- Assert the app-wide reset uses an empty provider ID and clears all provider
  counters for the selected app type.
- Verify both provider surfaces hide open/half-open labels while automatic
  failover is disabled and expose newly established state after re-enabling.
- Verify toggling one app type does not reset another app type's circuits.

## Scenario: WSL distribution enumeration with deferred Home detection (2026-08-11)

### 1. Scope / Trigger

- Trigger: the CLI Home UI enters WSL or changes the selected WSL distribution.
- Goal: make installed distribution selection responsive without running the
  slower WSL `$HOME` probe during draft editing.

### 2. Signatures

```text
provider_wsl_list_distros() -> Result<Vec<String>, String>
provider_home_get(environmentKind, environmentId?) -> ProviderHomeState
provider_environment_inspect(input) -> EnvironmentReport
```

### 3. Contracts

- `provider_wsl_list_distros` runs `wsl.exe -l -q` through the shared bounded
  subprocess helper with a 5-second timeout, decodes UTF-8/UTF-16LE output,
  trims empty lines, and returns distribution names only.
- The list command does not call `provider_home_get`, `$HOME` probing, path
  validation, or environment inspection.
- Home/diagnostic snapshots remain unchanged until an explicit refresh, save,
  or reset action invokes the existing Home/inspection commands.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `wsl.exe` cannot be located | `provider_wsl_unavailable` |
| List command times out or exits unsuccessfully | `provider_wsl_list_failed` |
| List succeeds with no installed distributions | `Ok([])` |
| Distribution output contains blank/duplicate lines | Trim blanks; frontend de-duplicates before selection |

### 5. Good / Base / Bad Cases

- Good: WSL entry lists installed distributions, preserves the selected name
  when present, and does not start Home recognition.
- Base: the selected distribution was removed; the frontend selects the first
  returned distribution and waits for explicit refresh before resolving Home.
- Bad: a list timeout is converted into a Home probe or silently selects the
  Windows `host` identity.

### 6. Tests Required

- Parse UTF-8 and UTF-16LE list output, including CRLF, BOM, blanks and names
  containing spaces.
- Assert list command timeout/failure maps to stable error codes.
- Frontend: assert environment changes do not invoke Home/inspection commands;
  explicit refresh invokes them with the selected distribution.

### 7. Wrong vs Correct

#### Wrong

```text
environment select change -> provider_home_get -> wsl.exe probe $HOME
```

#### Correct

```text
environment select change -> provider_wsl_list_distros (enumeration only)
explicit refresh/save/reset -> provider_home_get/select/reset -> inspect
```

## Scenario: Provider lifecycle references and project scope gates (2026-08-17)

### 1. Scope / Trigger

- Trigger: disabling/deleting a provider, or selecting a provider from a
  project/Worktree menu.
- Goal: distinguish catalog import provenance from real runtime references,
  keep scoped selection out of the global Home writer, and prevent new Grok
  project/Worktree overrides.

### 2. Signatures

```text
delete_provider(appType, providerId) -> Result<(), ProviderError>
set_provider_enabled(appType, providerId, enabled) -> Result<ProviderCard, ProviderError>
provider_reference_count(appType, providerId) -> i64
ProviderSwitchModal.applyProvider(provider) -> persist target provider_overrides
```

### 3. Contracts

- `provider_reference_count` reads `cli-manager.db` read-only and parses
  `projects.provider_overrides` plus only `worktrees` whose status is `active`.
  It uses the same schema-v2 parser as scope resolution: matching app type,
  `source = cli-manager`, version 2, and exact provider ID.
- `providers.db.provider_import_refs` records import provenance only. It must
  never block lifecycle operations; its existing foreign-key cascade remains
  responsible for cleanup after a provider deletion.
- A missing app database returns zero references. Lifecycle scanning counts
  only successfully parsed schema-v2 values. Malformed or legacy CCS
  overrides do not resolve to a native catalog ID and therefore cannot block
  every provider operation; scope resolution keeps its separate migration
  diagnostics when it is asked to launch such a scope.
- Claude/Codex selector mutations persist only the selected project or
  Worktree override. `provider_scope_prepare` remains the launch materializer:
  Claude uses generated settings plus `--settings`; Codex uses a non-secret
  profile beside the real Home plus `--profile`, with the key in child process
  environment only.
- New Grok project/Worktree selection is unsupported. UI must not list,
  persist, or globally apply Grok from that menu. Existing persisted Grok
  references remain readable solely for backward compatibility.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Exact project or active Worktree reference | `provider_referenced_cannot_disable` / `provider_referenced_cannot_delete` |
| Imported but unreferenced non-current provider | lifecycle operation proceeds |
| Current provider | existing `provider_current_cannot_*` error |
| Malformed or legacy CCS override during lifecycle scan | ignored; it is not a native catalog reference |
| Grok project/Worktree switch | localized unsupported UI; no mutation |

### 5. Good / Base / Bad Cases

- Good: an imported, non-current Claude provider with no v2 override can be
  disabled or deleted.
- Base: a project and an active Worktree reference the same Claude provider;
  both block disable/delete, while a missing Worktree does not.
- Bad: count `provider_import_refs`, invoke global preview/apply from a
  project selector, or create a new Grok override from the UI.

### 6. Tests Required

- Repository regression test covers project reference, app-type isolation,
  active versus missing Worktree, a non-matching provider ID, and legacy or
  malformed values that must not block catalog operations.
- Scope tests keep schema-v2 parser and Claude/Codex launch materialization
  coverage passing.
- Frontend type-check verifies delete-error localization and the Grok gate.
- Manual desktop checks cover project and Worktree selection for Claude/Codex,
  global Home non-mutation, and the Grok unsupported prompt in both locales.

### 7. Wrong vs Correct

#### Wrong

```text
delete -> providers.db.provider_import_refs -> block imported provider
project switch -> provider_global_apply -> rewrite real Home
```

#### Correct

```text
delete -> cli-manager.db v2 project/active-Worktree references -> exact block
project switch -> target provider_overrides -> next launch materializes scope
```
