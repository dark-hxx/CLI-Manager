# Research: cc-switch and multi-key provider implementations

- Query: Research upstream `cc-switch` and the likely fork/branch/PR implementing multiple API keys per provider; extract reusable patterns for CLI-Manager's deliberately manual-only model, including Claude Code/Codex/Grok config behavior and migration from CCS provider IDs to native provider IDs.
- Scope: mixed
- Date: 2026-08-02

## Superseding implementation decision

This evidence is retained for source links and writer behavior. The task’s
final decision supersedes its earlier “logical contract” proposal:

- copy the complete CCS supplier-domain schema/configuration conventions into
  a separate CLI-Manager-owned `providers.db`;
- extend it with the compatible manual subset of `provider_api_keys`;
- retain complete raw configuration editor surfaces, including Codex
  `auth.json` and `config.toml`, rather than a redacted minimal form;
- use CCS only as a read-only import source after cutover;
- support a type-level common config for Claude, Codex, and Grok Build even
  where current CCS does not expose the Grok common-config feature.

The definitive requirements and implementation rules are now
`../prd.md`, `../design.md`, and the provider-domain contracts.

## Findings

### Executive conclusion

> Product decision override (2026-08-02): CLI-Manager will intentionally store provider Key plaintext in its SQLite key table. The security recommendations below remain useful for frontend/log/export redaction, but the OS credential-store recommendation is not part of the selected design.

The highest-confidence match for the user-mentioned “cc-switch fork/variant implementing multiple keys/provider” is upstream open PR [farion1231/cc-switch#4957 — feat: Multi-API Key Pool](https://github.com/farion1231/cc-switch/pull/4957), whose head is [`JacktheGodzillaSlayer/cc-switch:feat/multi-api-keys`](https://github.com/JacktheGodzillaSlayer/cc-switch/tree/feat/multi-api-keys) at commit [`843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86`](https://github.com/JacktheGodzillaSlayer/cc-switch/commit/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86). It is the only upstream PR found that directly adds a child key table, per-provider key CRUD, and explicit active-key selection.

The match is not certain because the supplied URL was duplicated and did not identify the intended fork. PR #4957 is also intentionally much broader than CLI-Manager's scope: it adds round-robin selection, quota tracking, cooldown, 429 failover, and proactive rotation. Its data model and typed CRUD are useful references; its runtime KeyRing, quota/failover behavior, plaintext secret flow, and non-transactional DB-to-live-file activation are unsuitable.

The current upstream used for comparison is [`farion1231/cc-switch`](https://github.com/farion1231/cc-switch) `main` at commit [`ebbf141fc71547a99f669df1be8e345130d1d890`](https://github.com/farion1231/cc-switch/commit/ebbf141fc71547a99f669df1be8e345130d1d890) (2026-08-01). It stores one provider configuration blob per `(provider_id, app_type)` and has no first-class provider-key collection.

### Files found

#### Current upstream cc-switch

- [`src-tauri/src/provider.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/provider.rs#L9-L44) — provider entity and per-app credential/config shapes.
- [`src-tauri/src/database/schema.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/database/schema.rs#L25-L43) — provider table schema and composite primary key.
- [`src-tauri/src/database/dao/providers.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/database/dao/providers.rs#L180-L309) — provider persistence and current-provider transaction.
- [`src-tauri/src/commands/provider.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/commands/provider.rs#L22-L118) — provider CRUD/switch command surface.
- [`src-tauri/src/app_config.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/app_config.rs#L367-L497) — supported app types, aliases, switch modes, and common-config applicability.
- [`src-tauri/src/config.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/config.rs#L36-L44) — Claude and cc-switch paths; same-directory temporary-file writer.
- [`src-tauri/src/codex_config.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/codex_config.rs#L169-L269) — Codex paths and paired live-file writer.
- [`src-tauri/src/grok_config.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/grok_config.rs#L25-L32) — Grok Build path, model validation, import, and live write.
- [`src-tauri/src/services/provider/mod.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/provider/mod.rs#L2527-L2597) — provider service, switching order, and state/live-file consistency behavior.
- [`src-tauri/src/services/provider/live.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/provider/live.rs#L241-L256) — JSON/TOML common-config merging, normalization, snapshots, and live import.
- [`src-tauri/src/commands/import_export.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/commands/import_export.rs#L19-L59) — SQL export/import command surface.
- [`src-tauri/src/database/backup.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/database/backup.rs#L95-L203) — atomic snapshot file creation and temp-database validation/import.
- [`src-tauri/src/services/env_checker.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/env_checker.rs#L5-L54) — environment conflict detection, including values returned to the caller.
- [`src-tauri/src/services/env_manager.rs`](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/env_manager.rs#L42-L71) — environment backup/removal behavior.

#### Likely multi-key fork/PR

- [`src-tauri/src/database/schema.rs`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/database/schema.rs#L398-L433) — `provider_api_keys` schema.
- [`src-tauri/src/database/dao/api_keys.rs`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/database/dao/api_keys.rs#L20-L22) — key DAO and explicit plaintext-storage warning.
- [`src-tauri/src/commands/api_key.rs`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/commands/api_key.rs#L28-L47) — key DTO and CRUD/activation commands.
- [`src-tauri/src/provider.rs`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/provider.rs#L210-L260) — centralized mapping from app type to the provider config's secret field.
- [`src-tauri/src/app_config.rs`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/app_config.rs#L380-L440) — app types and secret-path mapping on the PR branch.
- [`src-tauri/src/services/provider/per_key_live.rs`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/services/provider/per_key_live.rs#L43-L47) — per-key live-file materialization used by automatic routing.
- [`src-tauri/src/proxy/providers/key_ring.rs`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/proxy/providers/key_ring.rs) — round-robin/cooldown/failover runtime that is outside CLI-Manager's scope.
- [`src/components/api-key/ApiKeyListSection.tsx`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src/components/api-key/ApiKeyListSection.tsx#L56-L67) — multi-key UI and pool/rotation framing.
- [`src/lib/api/apiKey.ts`](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src/lib/api/apiKey.ts#L4-L23) — frontend API type exposing full plaintext keys.

#### CLI-Manager integration touchpoints

- `.trellis/spec/backend/ccswitch-integration-contracts.md:134` — existing Claude project override stores a CCS `providerId`; `:161` specifies launch-time CCS re-read.
- `.trellis/spec/backend/ccswitch-integration-contracts.md:278` — existing Codex project override stores a CCS `providerId`; `:353` describes the managed handoff.
- `src/lib/providerSwitching.ts:6` — current provider override types and generated-path/profile parsing.
- `src/components/ProviderSwitchModal.tsx:343` — current UI lists providers through `ccswitch_list_providers`; `:503` and `:527` prepare Claude/Codex overrides.
- `src/stores/terminalStore.ts:1294` — current terminal launch prepares CCS-backed overrides; remote-handoff use starts around `:1717`.
- `src-tauri/src/commands/ccswitch.rs:398` — current provider listing; Claude prepare at `:1183`, Codex prepare at `:1928`.
- `src-tauri/src/lib.rs:222` and `:600` — worktree/project `provider_overrides` migrations.

### Current upstream capability and config matrix

| Concern | Claude Code | Codex | Grok |
|---|---|---|---|
| Upstream app identity | `AppType::Claude` | `AppType::Codex` | `AppType::GrokBuild`; aliases include `grok`, `grok-build`, `grokbuild`, and `grok_build` ([source](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/app_config.rs#L386-L443)) |
| Live config path | `~/.claude/settings.json` ([source](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/config.rs#L166-L169)) | `~/.codex/auth.json` plus `~/.codex/config.toml` ([source](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/codex_config.rs#L169-L185)) | `~/.grok/config.toml` ([source](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/grok_config.rs#L25-L32)) |
| Credential/config shape | Provider JSON has Claude environment values such as Anthropic token/base URL ([source](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/provider.rs#L207-L222)) | Provider JSON stores `auth` plus configuration TOML ([source](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/provider.rs#L152-L164)) | Provider JSON stores TOML; selected model requires name/base URL and either inline `api_key` or `env_key` ([source](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/grok_config.rs#L98-L173)) |
| Global provider switching | Exclusive current provider; DAO clears all current flags for app type then marks target current in a DB transaction | Same | Same |
| Common config | Supported; JSON deep merge | Supported; structured TOML merge | Not supported by `CommonConfigSnippets::get/set` ([source](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/app_config.rs#L450-L497)) |
| PR #4957 multi-key support | Yes | Yes | No: the branch predates `GrokBuild` and its `AppType` list has no Grok variant ([source](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/app_config.rs#L407-L440)) |

“Grok” in current cc-switch means the **Grok Build CLI configuration format**, not a generic xAI/OpenAI-compatible provider. CLI-Manager should not finalize its Grok writer until its intended CLI and exact schema are confirmed.

### Current upstream patterns

#### Provider data model and CRUD

`Provider` has a single `settings_config` value and no key collection ([`provider.rs` L9-L44](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/provider.rs#L9-L44)). The database uses a composite primary key `(id, app_type)` and stores `settings_config` as text ([`schema.rs` L25-L43](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/database/schema.rs#L25-L43)). Consequently, a CCS provider ID is not a globally unique foreign key without its app type.

The provider service exposes conventional list/add/update/delete/switch operations. Adding the first provider may make it current and write it live. Deleting the current provider is blocked. Current-provider selection is transactionally unique inside CCS because `set_current_provider` clears every current row for the app type and sets the target in one transaction ([`providers.rs` L290-L309](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/database/dao/providers.rs#L290-L309)).

This global “one selected provider per app type” is a good semantic match for CLI-Manager. It is separate from “one selected key per provider”; both invariants are required in the native model.

#### Switching order and consistency

Normal switching first backfills the outgoing provider from live files, then updates local/DB current state, and only afterward writes the target live configuration ([`services/provider/mod.rs` L3058-L3237](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/provider/mod.rs#L3058-L3237)). A target live-file failure can therefore leave CCS's selected-provider state ahead of the actual CLI config. CLI-Manager should not copy this ordering without an operation journal and rollback.

#### Common-config inheritance

The live service deep-merges JSON and TOML with the common snippet as the source. Common scalar values overwrite provider values ([JSON merge](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/provider/live.rs#L241-L256), [TOML merge](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/provider/live.rs#L375-L395)). A structured TOML editor preserves order/comments better than stringify-and-replace ([`live.rs` L451-L482](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/provider/live.rs#L451-L482)). Explicit provider metadata controls whether common config is inherited, and normalization removes inherited common values from the provider's stored override.

The structural merge and normalization are reusable. The precedence is not: the task requires common defaults plus provider override, so provider-specific values should win on conflict. Secrets should not be inherited through a generic common-config merge.

#### Atomic writes and rollback

The generic writer creates a temporary file in the destination directory, flushes it, then renames it ([`config.rs` L296-L351](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/config.rs#L296-L351)). On Windows it removes the destination before rename, which introduces a missing-file window and is not a strict atomic replacement; it also does not show a directory `fsync` durability step.

Codex writes two live files. It snapshots old auth/config, writes auth, then config, and restores auth if the config write fails ([`codex_config.rs` L222-L269](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/codex_config.rs#L222-L269)). The implementation reads `_old_config` but does not restore it. That is incomplete cross-file rollback and should not be treated as an atomic two-file commit.

`LiveSnapshot` is useful as an idea but does not cover all current apps and is not used as a full DB-plus-files transaction during normal switching ([`live.rs` L942-L1013](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/provider/live.rs#L942-L1013)).

#### Import/export

Full export is a SQL snapshot, so it includes `providers.settings_config` and therefore any inline tokens. Import first makes a backup, applies imported SQL to a temporary database, runs schema/migrations/validation there, then uses SQLite Backup to copy into the live database ([`database/backup.rs` L119-L203](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/database/backup.rs#L119-L203)). This temp-DB validation and safety-backup pattern is strong. Plaintext secret export without encryption/passphrase or an explicit “include secrets” choice is not.

Live-config import creates a default provider only under limited seed-state conditions; it is not a previewable, conflict-aware migration workflow. Native CCS import should instead scan, preview, map identities, report conflicts, and commit the complete migration transactionally.

#### Environment checks

The environment checker looks for Anthropic-prefixed variables for Claude, OpenAI-prefixed variables for Codex, and exact `XAI_API_KEY`/`GROK_DEFAULT_MODEL` variables for Grok ([`env_checker.rs` L40-L54](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/env_checker.rs#L40-L54)). On Windows it inspects user and machine registry scopes. Its response includes `var_value`, so secrets can cross into the frontend/logging boundary ([`env_checker.rs` L5-L31](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/services/env_checker.rs#L5-L31)). CLI-Manager should return name, scope, presence, and a masked fingerprint only.

Environment removal writes a plaintext JSON backup and then deletes variables sequentially; failure after earlier deletions has no automatic rollback. A native implementation should treat environment remediation as an explicit, separately confirmed operation rather than part of provider activation.

### PR #4957 multi-key implementation

#### Data model

The PR adds `provider_api_keys` with composite provider ownership, a human label, plaintext `api_key`, tags/notes, `enabled`, ordering, `is_active`, cooldown/failure/last-use fields, and a composite foreign key back to providers with cascade deletion ([schema](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/database/schema.rs#L398-L433)). A migration backfills an active `Default` key from existing provider config and skips empty/OAuth configurations.

The child-table relationship, label, enabled/order fields, and backfill are reusable. The cooldown/failure/usage fields exist solely for automatic routing and should be omitted. The table has no partial unique index enforcing one active key per provider; DAO transactions attempt to maintain the invariant, but corrupted/imported/concurrent data can still contain multiple active rows.

For CLI-Manager, enforce the invariant at the database layer with a partial unique index equivalent to `UNIQUE(provider_id) WHERE is_active = 1` (include `app_type` if provider IDs are not globally unique). Also enforce ownership on activation and define the zero-key/draft state separately from an enabled provider.

#### Key CRUD and activation

The PR exposes typed Tauri commands for create/read/update/delete/activate. Activation transactionally clears the old active row, activates the requested row, and updates the provider's `settings_config`; afterward it resets runtime KeyRing state and writes the live CLI file ([`api_key.rs` L368-L472](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/commands/api_key.rs#L368-L472)). If live writing fails, the DB has already committed the new active selection. This is the same split-state problem as upstream provider switching.

Deletion permits deleting the active key and does not require choosing a replacement. The now-stale active secret may remain duplicated in `settings_config`. CLI-Manager should block deletion or disabling of the active key unless a replacement is selected atomically in the same command. The simplest manual-only contract is:

1. A draft provider may have zero keys and cannot become globally/project active.
2. The first usable key becomes active only when the corresponding config render/write succeeds.
3. An enabled provider with keys has exactly one active key.
4. Activating another key is a single backend operation; no key is selected by request routing.
5. Deleting/disabling the active key requires an explicit replacement, or deletion is rejected.
6. Running CLI processes retain their existing environment/config snapshot; the new key applies to future launches and explicitly managed live files.

#### Secrets

The PR explicitly notes keys are plaintext on disk in its DAO ([`api_keys.rs` L20-L22](https://github.com/JacktheGodzillaSlayer/cc-switch/blob/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86/src-tauri/src/database/dao/api_keys.rs#L20-L22)), returns the full secret in key DTOs, and includes it in frontend API types. Masking the React input/display is therefore cosmetic, not a trusted-boundary control.

CLI-Manager should keep secret material behind Rust commands and return metadata plus masked fingerprint, for example `sk-…a91f`, never a recoverable secret. Create/update accepts a secret write-only; an unchanged edit uses an explicit `keep_existing` action. Export defaults to metadata-only, with secret export requiring a separate, prominently labeled encrypted path if implemented at all. Logs, errors, environment diagnostics, and migration reports must redact both raw and URL-encoded forms.

Avoid duplicating the active secret in both a key table and a provider JSON blob. Render the effective provider config inside the backend from the active key plus non-secret provider/common settings. If legacy compatibility requires a materialized snapshot, treat it as a derived cache and scrub it from normal list/export APIs.

#### Unsupported automation

The PR's KeyRing, cooldown, usage/quota tracking, 429 handling, round-robin ordering, proactive 90% rotation, and per-key live files all contradict the requested scope. They substantially enlarge runtime concurrency and failure-state requirements. Do not port them. There should be no automatic key choice, health score, quota polling, validity probing, retry failover, or background activation.

### Reusable and unsuitable pattern matrix

| Pattern | Decision | Reason/adaptation |
|---|---|---|
| Provider child-key table | Reuse | Natural one-to-many model; add backend-only secret handling and DB-enforced single-active invariant. |
| Composite ownership `(provider_id, app_type)` | Reuse where IDs are type-local | Matches CCS identity and prevents a Claude key being attached to a Codex provider. Prefer globally unique native provider IDs but keep app-type validation. |
| Human key label/notes/enabled/order | Reuse selectively | Useful CRUD affordances; `enabled` needs explicit active-key rules. Tags are optional, not MVP-critical. |
| Central app-type → credential-field mapping | Reuse | Prevents divergent extraction/rendering logic; extend and test for current Grok Build schema. |
| Backfill active key from provider config | Reuse | Good migration basis; add preview, provenance, idempotence, OAuth/empty/manual-conflict reporting. |
| Typed backend CRUD commands | Reuse | Keeps validation and secret access in Rust; do not return plaintext secret DTOs. |
| Transactional old-active/new-active update | Reuse and strengthen | Add a partial unique index and coordinate it with live-file commit/rollback. |
| Common-config normalization/structured TOML edit | Reuse with reversed precedence | Preserve comments/order; merge common defaults first and provider override second. Never merge secrets generically. |
| Temp DB validation and pre-import backup | Reuse | Strong import safety; import should be previewable and mapping-aware. |
| Same-directory temp write | Reuse and strengthen | Stage all outputs first; use a Windows-safe replacement strategy, backups, recovery journal, and durability checks. |
| KeyRing/round-robin/quota/cooldown/failover | Reject | Explicitly outside scope and introduces background/concurrency behavior. |
| Per-key materialized live files | Reject | Unnecessary for manual selection; increases secret copies and partial-write states. |
| Plaintext key through WebView/API | Reject | UI masking does not protect the secret boundary. |
| Duplicate active secret in provider JSON and key row | Reject | Creates stale-secret and export/leak risks. |
| DB commit before live write | Reject | Leaves selected state inconsistent with actual CLI config on failure. |
| Delete active key without replacement | Reject | Violates exactly-one-active semantics and can leave stale live credentials. |

### Recommended native logical model

The following is a logical contract, not a demand for exact table names:

- `providers`: stable native ID, `app_type`, display name, enabled/draft state, non-secret provider override/config, timestamps.
- `provider_keys`: stable key ID, native provider ID, label, backend-owned secret or secret reference, masked fingerprint, enabled, `is_active`, ordering, timestamps. No quota/health/cooldown/rotation fields.
- `active_cli_provider`: one row per CLI app type pointing to the globally selected native provider.
- `provider_import_refs`: `(source, app_type, external_id) → native_provider_id`, source fingerprint/version, import timestamps; unique on the source identity for idempotence.
- Existing project/worktree override JSON: continues to point to a provider, but `providerId` becomes a native ID and must carry a schema/source migration marker so an old CCS ID cannot be ambiguously interpreted as native.

The active key belongs to the provider, not to the global/project selection. Therefore a global Claude selection and a project Claude override that both reference provider P use P's same manually active key. Changing P's active key affects future launches for every scope selecting P. Project overrides continue to choose a provider, not a key.

### Atomic activation/write contract

A truly atomic transaction cannot span SQLite and multiple CLI config files, especially Codex's JSON+TOML pair. The backend needs a recoverable coordinator rather than merely a DB transaction:

1. Acquire a per-app-type operation lock and validate target provider/key ownership, enabled state, and app type.
2. Compute effective config from common defaults, provider overrides, and the target active key entirely in memory.
3. Snapshot every destination plus selected-provider/key DB state; persist a small operation journal without secret-bearing diagnostics.
4. Stage every target file in its destination directory and validate the staged JSON/TOML before replacing anything.
5. Replace all live files using backups. If any replacement fails, restore every already-replaced file and leave/restore DB selection.
6. Commit selected provider/key state and mark the journal complete. If DB commit fails, restore live files. Surface a distinct “rollback incomplete” recovery state if restoration itself fails.
7. On next startup, detect unfinished journals and offer/perform deterministic recovery before another switch.

For a project override that uses isolated generated settings/profile files, apply the same staged-write rule to those files; do not route through CCS at runtime. Existing generated path/profile metadata can be recreated from the native provider rather than used as import identity.

### CCS ID to native ID migration/import mapping

The current CLI-Manager contract treats `provider_overrides.*.providerId` as a CCS provider ID and rereads CCS during launch (`.trellis/spec/backend/ccswitch-integration-contracts.md:134-162`, `:278-353`). The new contract retains project/worktree override behavior but changes that field to a native provider reference. Runtime fallback to CCS would create an ambiguous dual source of truth and must not remain after cutover.

Required implications:

1. **Source identity is tripartite.** Use `(source = "ccswitch", app_type, external_id)` as the import key. CCS's primary key is `(id, app_type)`, so `external_id` alone is not safely global.
2. **Native IDs are stable and persisted.** Generate a native ID once and store the import reference. Re-import looks up that mapping and updates/previews the same native provider; it must not create a new UUID each run.
3. **Import providers/keys before overrides.** First import provider records and their single legacy credential/backfilled key, producing a complete external→native mapping. Then rewrite project and worktree override JSON in one migration transaction.
4. **Migrate global selection separately per app type.** CCS `is_current` maps to `active_cli_provider[app_type]`; it is independent of project overrides and per-provider active keys.
5. **Version the override payload.** Add a schema/source marker such as `schemaVersion` and `providerSource: "native"`, or perform a DB migration with an equivalent migration-complete marker. An unmarked UUID-like `providerId` must never trigger heuristic CCS/native lookup.
6. **Preserve provenance, not runtime dependency.** Retain external ID/source/fingerprint in `provider_import_refs` and an import audit report. Normal listing, preparation, switching, and terminal launch read only CLI-Manager's native store.
7. **Handle missing IDs explicitly.** If an existing project/worktree override refers to a deleted or unimportable CCS provider, retain its original JSON in a migration audit/quarantine record and mark the override unresolved/disabled. Do not silently switch to global and do not query CCS at runtime.
8. **Conflict behavior must be previewable.** Name collisions are not identity. If the same mapped CCS provider changed, show update differences; if an unmapped CCS provider resembles an existing native provider, ask merge-versus-import rather than name-matching automatically.
9. **Legacy key backfill is one key, not a pool.** Extract the app-specific credential from CCS `settings_config`, create one native key (for example “Imported from CC Switch”), and make it active only after its effective config validates. OAuth/empty/unsupported shapes become explicit skipped/conflict items.
10. **Generated artifacts are derived.** Claude override `settingsPath` and Codex `profileName` are recreated from the native provider/key/common configuration. They are not part of the external identity mapping and should not force continued reads from CCS.

An import report should count discovered/imported/updated/skipped/conflicted providers and overrides, list only masked fingerprints, and include a rollback/backup identifier. Repeated import should be idempotent by import reference and source fingerprint.

### Secondary candidate and related upstream discussions

[`jiaoshou99999/cc-keyring-companion`](https://github.com/jiaoshou99999/cc-keyring-companion) is a separate companion rather than a cc-switch fork. Its [README](https://github.com/jiaoshou99999/cc-keyring-companion/blob/main/README.md) describes up to ten key/base-URL slots with ordered automatic rotation and quota failover. It supports Claude/Codex/Gemini, is macOS/proxy-oriented, and does not cover Grok. Its config writer uses temp files, `fsync`, rename, directory `fsync`, and restrictive permissions ([`config-store.js`](https://github.com/jiaoshou99999/cc-keyring-companion/blob/main/src/config/config-store.js)); its CCS integration backs up and transactionally inserts a managed proxy provider while refusing to overwrite a non-managed provider ([`cc-switch.js`](https://github.com/jiaoshou99999/cc-keyring-companion/blob/main/src/integration/cc-switch.js)). Those filesystem/ownership guards are useful references, but its proxy and automatic rotation architecture is outside scope.

Related primary discussions that help distinguish candidates:

- [Issue #1278](https://github.com/farion1231/cc-switch/issues/1278) — earlier proposal for grouped keys and automatic rotation.
- [Issue #4831](https://github.com/farion1231/cc-switch/issues/4831) — batch/duplicate provider workflow, not a first-class multi-key store.
- [Issue #5299](https://github.com/farion1231/cc-switch/issues/5299) — provider-plus-keys discussion referencing the multi-key direction.

### Related specs

- `.trellis/tasks/08-02-key/prd.md` — native provider/key scope, explicit rejection of rotation/failover/quota/validity, import-only CCS dependency, and global/project selection requirements.
- `.trellis/spec/guides/fix-triage-guide.md` — new-feature scenario enumeration and cross-boundary discovery requirements.
- `.trellis/spec/backend/ccswitch-integration-contracts.md` — current CCS runtime contract and legacy override identity that the migration must replace.
- `AGENTS.md` — project architecture, i18n, required triage, and impact-analysis rules for later implementation.

## Caveats / Not Found

- The original user-supplied URL was duplicated, so PR #4957 is a high-confidence identification, not proof of the intended repository. No exact second URL was available to disambiguate.
- PR #4957 is open and unmerged as of the research date. Its head branch can be force-pushed or deleted; conclusions above are pinned to commit `843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86`.
- Current upstream conclusions are pinned to `ebbf141fc71547a99f669df1be8e345130d1d890`; cc-switch behavior may change after 2026-08-01.
- The multi-key PR predates current Grok Build support. Its credential-path mapping cannot be assumed correct for Grok and should not be ported wholesale.
- Current upstream “Grok” is Grok Build. The exact Grok CLI/product intended by CLI-Manager, its authoritative config schema, and whether inline keys or environment references are supported remain unresolved.
- No merged upstream implementation was found that combines current Claude, Codex, and Grok support with manual-only multiple keys and exactly one active key per provider.
- No evidence was found of encrypted-at-rest provider secrets in current upstream cc-switch or PR #4957. Database backups/exports should be assumed to contain plaintext secrets unless CLI-Manager introduces its own secret boundary.
- Exact Windows replacement semantics, key storage backend, import UX, and crash-recovery journal schema require implementation design and platform testing; the recommendations here define required behavior, not a verified library choice.
