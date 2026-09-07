# Provider-domain source manifest

This manifest pins the upstream compatibility sources used by Phase 0. The
implementation must refresh this file when a later phase needs a newer source;
it must not silently follow a moving branch.

## Pinned sources

| Source | Commit | Use | Canonical files |
| --- | --- | --- | --- |
| CC Switch main | [`ebbf141fc71547a99f669df1be8e345130d1d890`](https://github.com/farion1231/cc-switch/commit/ebbf141fc71547a99f669df1be8e345130d1d890) | CCS provider identity, core fields, app-type and live-file conventions | `src-tauri/src/database/schema.rs`, `src-tauri/src/provider.rs`, `src-tauri/src/app_config.rs`, `src-tauri/src/config.rs`, `src-tauri/src/codex_config.rs`, `src-tauri/src/grok_config.rs` |
| CC Switch multi-key PR #4957 | [`843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86`](https://github.com/JacktheGodzillaSlayer/cc-switch/commit/843ad7cd34b7236cd8caaaa82ba4bb1b1aa4be86) | Child-key shape and explicit active-key CRUD reference | `src-tauri/src/database/schema.rs`, `src-tauri/src/database/dao/api_keys.rs`, `src-tauri/src/commands/api_key.rs` |

## Phase 0 extraction record

- Extracted on: `2026-08-02`.
- Mainline provider identity is composite `(id, app_type)` with storage type
  `grokbuild`; the public CLI-Manager type alias `grok` is normalized at the
  domain boundary in a later phase.
- Mainline provider fields retained in `providers.db`: `name`,
  `settings_config`, `website_url`, `category`, `created_at`, `sort_index`,
  `notes`, `icon`, `icon_color`, `meta`, `is_current`, and
  `in_failover_queue`.
- Mainline `settings` remains the type-common configuration store. The
  provider-domain schema adds the required `common_config_claude`,
  `common_config_codex`, and `common_config_grokbuild` keys by convention;
  rows are created when the common-config repository is implemented.
- The multi-key source contributes `provider_api_keys` fields `id`, composite
  provider ownership, `label`, `api_key`, `tags`, `notes`, `enabled`,
  `sort_index`, `is_active`, `created_at`, and `updated_at`.
- The multi-key source fields for cooldown, failure counts, last use, error
  tracking, KeyRing, routing, quota, and failover are deliberately excluded.
  CLI-Manager enforces one active key per `(provider_id, app_type)` with a
  partial unique index and selects keys manually only.

## Compatibility boundary

The pinned sources are schema/API evidence, not a runtime dependency. Normal
provider catalog, launch, Home apply, Hook/history, and session restore paths
must read only CLI-Manager's `providers.db` after cutover. CCS remains a
read-only import source.
