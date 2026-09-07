# Provider Domain Rebuild — Technical Design

## 1. Architecture decision

Use an independent app-owned database:

```text
<cli-manager data root>/providers.db
```

It is a CCS-compatible supplier-domain copy, not an attachment to
`cli-manager.db`. The separation is intentional:

1. CCS already uses a `providers` table name and a composite identity; the
   existing application database contains historical prototype migrations.
2. The new domain can preserve CCS-shaped migrations and be copied/imported
   without collisions with project/session tables.
3. A provider-domain failure must not stop project/session database startup.

`cli-manager.db` remains authoritative for projects and Worktrees. It stores
only native provider references; `providers.db` owns provider records,
settings, keys, current state, import mappings, home preferences, and apply
journals.

The historical v25/v26 migration registrations in `cli-manager.db` remain
as immutable compatibility tombstones. They are **not** used by the new domain
and must not be deleted or reused; removing them can make previously opened
user databases fail migration validation.

## 2. Target data model

### 2.1 CCS-compatible core

Copy the CCS supplier-domain schema and keep its composite identity:

```sql
providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,       -- claude | codex | grokbuild
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL, -- CCS-compatible JSON blob
  website_url TEXT,
  category TEXT,
  created_at INTEGER NOT NULL,
  sort_index INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  icon TEXT,
  icon_color TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  is_current INTEGER NOT NULL DEFAULT 0,
  in_failover_queue INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, app_type)
);

settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

The implementation session must pin the upstream CCS commit and copy the
actual schema/migrations from that commit before writing code. The baseline
research is pinned to CCS `ebbf141f`; it is a source compatibility target,
not a promise that a later upstream schema can be guessed.

`settings` owns type common configuration keys:

```text
common_config_claude
common_config_codex
common_config_grokbuild
```

Each provider’s `meta.commonConfigEnabled` controls inheritance. Grok’s
common-config key is a CLI-Manager extension because current CCS does not
enable it; it uses the same TOML editor/merge contract as Grok Build provider
configuration.

### 2.2 Manual multi-key extension

Adopt the compatible part of CCS PR #4957, simplified to manual selection:

```sql
provider_api_keys (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  label TEXT NOT NULL,
  api_key TEXT NOT NULL,          -- plaintext by product decision
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_index INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_id, app_type)
    REFERENCES providers(id, app_type) ON DELETE CASCADE,
  UNIQUE(provider_id, app_type, label)
);

CREATE UNIQUE INDEX provider_api_keys_one_active
  ON provider_api_keys(provider_id, app_type)
  WHERE is_active = 1;
```

Do **not** copy `cooldown_until`, failure count, last error, last-used time,
usage accounting, KeyRing, or routing/failover commands from PR #4957. They
would incorrectly create automated behavior the product excludes.

`settings_config` remains CCS-compatible and contains the provider’s
currently projected credential/document fields. The selected key table is the
canonical credential collection. Every create/update/activate operation
reprojects the active key into the applicable CCS config field in the same
SQLite transaction, avoiding the two representations drifting.

### 2.3 CLI-Manager extension tables

```text
provider_home_preferences
  environment_kind (local | wsl), environment_id, mode (auto | manual),
  home_path, updated_at

provider_apply_journal
  id, app_type, provider_id, home_identity, operation, state,
  targets_json, backups_json, expected_fingerprints_json,
  desired_fingerprints_json, started_at, finished_at, error_code

provider_import_refs
  source_kind, source_identity, source_app_type, source_provider_id,
  source_fingerprint, provider_id, app_type, imported_at

provider_migration_issues
  id, scope_kind (project | worktree), scope_id, app_type,
  legacy_payload, reason, resolved_at
```

The app database receives a versioned provider-reference payload only:

```json
{
  "schemaVersion": 2,
  "source": "cli-manager",
  "appType": "codex",
  "providerId": "native-provider-id"
}
```

No key, base URL, raw config, generated path, or CCS ID is persisted in a
project/Worktree reference. A provider ID is valid only together with its
`appType`.

## 3. Configuration model

### 3.1 Settings shape and editor synchronization

Use CCS’s per-type `settings_config` layout:

- **Claude:** provider metadata plus settings JSON/`env` fields such as
  base URL and model configuration.
- **Codex:** `auth` object and a complete `config` TOML document. The
  editor has both `auth.json` and `config.toml`, exactly as in the CCS
  supplier editor.
- **Grok Build:** complete config TOML with its base URL/model/key mapping.

The editor state machine has one parsed canonical document per source:

```text
structured top fields <-> provider settings_config documents
type common document -> effective merged document
active Key -> credential projection into effective/live document
live file -> owned-field diff and preserved external fields
```

The backend is the only authority for parsing, converting, merging, key
projection, and serialization. The frontend can syntax-highlight and hold a
local unsaved draft but does not implement a second JSON/TOML merger.

When raw JSON/TOML changes:

1. parse and validate its root/type-specific contract;
2. update structured base-URL/model controls only if their source location is
   unambiguous;
3. extract any active credential location into the selected key operation;
4. reject a conflicting credential edit with a focused diagnostic rather than
   losing a document value.

When a helper field changes, the backend patches the parsed document while
preserving unrelated data/comments wherever its serializer permits it. Codex
uses `toml_edit` for user/live TOML modifications.

### 3.2 Effective configuration merge

```text
existing live document (only non-provider-owned portions retained)
  + type common configuration
  + provider settings override
  + active-key projection
  = validated effective document(s)
```

- Object/table: recursive merge.
- Provider source wins on scalar/table conflict.
- Array: provider source replaces common array.
- JSON `null`: a deliberate provider override.
- Key material is never drawn from a type common document.
- A provider with `meta.commonConfigEnabled = false` skips the common layer.

The UI renders three distinct views:

1. **Provider configuration** — editable settings documents;
2. **Common configuration** — type-owned, editable once per type;
3. **Effective / Live diff** — read-only materialized result and the exact
   owned fields that will be changed in Home.

### 3.3 Type writers

| Writer | Provider-owned fields | Preserve/round-trip |
| --- | --- | --- |
| Claude | selected provider `env` endpoint/model/key mapping | hooks, permissions, statusline, MCP, unknown settings |
| Codex | `auth.json` selected credential and provider-owned `config.toml` model/provider fields | projects, MCP servers, hooks, features, TUI, unknown TOML/comment order where possible |
| Grok Build | provider base URL/model/key mapping in `config.toml` | permitted Grok user settings, plugins/MCP/permissions and unknown fields |

Exact provider-owned paths must be a typed per-app map covered by writer tests.
Never replace a whole live file merely because the provider config is saved.

## 4. Global switch transaction

```text
resolve Home + acquire app-type/home lock
 -> validate provider, active key, documents and targets
 -> compare live fingerprints with preview baseline
 -> stage every target file in its target directory
 -> parse staged targets
 -> create recoverable backups + journal(state=staged)
 -> replace live targets
 -> verify fingerprints
 -> SQLite transaction: set one providers.is_current + journal(committed)
 -> clean journal/backups according to retention
```

On any file failure, restore every already changed target from backups and mark
the journal failed. If recovery itself fails, retain journal/backups and block
further apply for that Home/type until a repair operation resolves it. On app
startup, unfinished journals are detected before provider selection is shown.

Codex is two target files, so both must be validated and compensated. Database
current state is committed last. This improves on the upstream CCS ordering,
which can mark a database provider current before the live writer succeeds.

## 5. Scope resolver and launch materializer

```text
Worktree v2 reference
  > Project v2 reference
  > providers.is_current for app type
  -> ProviderResolver
  -> ProviderMaterializer
       Claude: generated settings + --settings
       Codex: generated profile/config + process env key
       Grok: generated GROK_HOME + process env key
```

- The resolver fetches only `providers.db`; CCS is never read in the normal
  path.
- A materialized launch snapshot is immutable for its terminal session. Later
  provider/key/global changes affect new sessions, not active ones.
- Generated files live under
  `<data root>/providers/generated/<app-type>/<scope-id>/`; they do not
  become Home global files and are safely garbage-collected by ownership marker.
- Shell commands receive a correctly escaped config/profile path. Secrets are
  placed only in the child process environment.
- SSH/remote projects do not materialize or transmit local providers/keys.

## 6. Home and dependent directories

```text
CliHomeResolver(environment)
  -> home root
  -> .claude / .codex / .grok roots
  -> global target files
  -> automatic history roots
  -> default Hook/statusline target roots
```

The resolver is a shared backend service with a small DTO for the frontend.
It differentiates local Windows from a named WSL distribution and normalizes
paths before storage. The provider Home preference is lower priority than an
explicit existing hook-root or explicit history-source root:

```text
explicit feature root > selected provider Home > detected OS/WSL Home
```

The settings UI shows each effective target and a `follow selected Home`
action. This makes the override explicit instead of silently moving Hooks or
changing the session-history source.

## 7. Import/cutover design

```text
CCS DB snapshot (read-only)
  -> schema/version detect
  -> scan providers + settings + optional provider_api_keys
  -> normalize app type and compute source fingerprint
  -> preview conflicts / key consent / reference mapping
  -> import transaction into providers.db
  -> persist provider_import_refs
  -> migrate project/worktree references in cli-manager.db
  -> optional explicit global apply to selected Home
```

Import never mutates CCS. It must handle:

- no CCS database or a corrupt database without impairing native providers;
- mainline single-key values (create an active `Imported` key);
- PR #4957 multi-key values (retain manual relevant fields only);
- OAuth/no-key/unrecognized credential layouts (provider imported as draft or
  skipped with a reason);
- same source identity/fingerprint (no duplicate on repeat);
- changed source fingerprint (preview update rather than auto-overwrite);
- legacy override with no mapped imported provider (repair issue, no fallback).

Once the native cutover lands, current CCS read/prepare/reset/list commands are
either removed or isolated behind the import adapter. Test coverage must prove
that renaming `.cc-switch` has no effect on native provider operation.

## 8. Tauri command groups

Keep commands grouped by domain rather than a shallow CRUD list:

```text
provider_catalog_*     list/get/create/update/duplicate/delete/reorder/set_enabled
provider_key_*         list/create/update/delete/reorder/set_active/reveal
provider_common_*      get/update/validate/preview_effective
provider_global_*      get_current/preview_apply/apply/repair
provider_scope_*       resolve/list_selectable/migrate_legacy_reference
provider_home_*        get/select/reset/derived_targets
provider_environment_* inspect/open_target
provider_import_*      discover/preview/commit/list_issues/resolve_issue
```

Read DTOs are list/detail/editor/preview specific. Plaintext key storage is a
product decision, but secret exposure is explicit: a reveal command is
purpose-bound, excludes logs/toasts/store persistence, and requires the
provider/key identity. Default list DTOs contain only label, enabled/active
state, and a masked hint. Full raw documents may reveal the selected active
credential after the user explicitly opens the credential/auth view.

## 9. Prototype and interaction design

The approved review asset is
`assets/ccs-provider-domain-prototype.png` (with editable
`ccs-provider-domain-prototype.svg` source). The two required screens are:

1. **Provider list:** type tabs; global current strip; search/import/environment
   actions; drag-sort provider cards showing base URL/model/key state; selected
   card; an explicit Add provider action.
2. **Codex provider editor:** top-level endpoint, API key/multi-key section,
   model/model provider, common-inheritance control, `auth.json` and
   `config.toml` full editors, advanced options, effective config/live diff,
   model test and billing configuration panels.

Claude and Grok use the same editor hierarchy, with their native documents and
model fields. The screen must not hide base URL/key/model behind a generic
textarea. It must use existing setting-page patterns, app confirmation
dialogs, localized copy, focus management, and an unsaved-change guard.

## 10. Implementation risks / decisions locked

| Risk | Design response |
| --- | --- |
| existing user DB has old provider migrations | retain immutable migration tombstones; new domain uses a separate DB |
| multiple files cannot share one OS transaction | journal, target lock, backup, compensation, startup repair |
| complete raw editor and key list can diverge | key projection/reconciliation in a single provider DB transaction |
| common config incorrectly attached to a provider | store it by app type only; editor is opened from the type tab |
| different Home consumers disagree | all defaults use CliHomeResolver; explicit feature roots override visibly |
| CCS IDs collide with native IDs | composite app identity and import-ref mapping; no heuristic fallback |
| source config contains secret | plaintext storage is allowed, but reveal is explicit and defaults/logs/sync remain masked |
| old terminal running after switch | session snapshots remain immutable; only new launches resolve again |

## 11. UI follow-up design from manual review

### 11.1 Page-level state

`NativeProviderSettingsPage` keeps the current CLI type selection, but adds a
small page-surface state:

```text
providerCatalogView = catalog | cliHome
importSurface = closed | open
```

The catalog view renders type tabs, search, Import, CLI Home, add/refresh and
the provider list/detail shell. Import is opened from the Import action and is
not mounted as a permanent catalog section. CLI Home is rendered in its own
surface and reuses the existing Home/environment/global-apply state and
guards; it is not duplicated in the catalog.

### 11.2 Import repair identity

Import issues continue to use the stable issue ID and native provider ID for
commands, but the read DTO/UI label must resolve the reference identity:

```text
scopeKind + scopeId
  -> project/worktree display name (when present)
  -> localized missing-record label + stable ID (when absent)
```

The resolver must not change repair semantics or introduce name-based matching.
Names are presentation-only; commands still submit the exact issue/provider
IDs. The stable ID is secondary text or a tooltip for diagnosis.

### 11.3 Equal-height catalog/detail shell

The page shell supplies one bounded responsive height to both panes. The left
catalog and right detail each use their own vertical `ScrollArea`; the outer
provider grid does not grow with the number of cards. The detail pane keeps its
header, key section and document editors inside the same scroll context, so a
missing/empty/loading detail state cannot leave a broken blank card or push the
list to a different height.

The implementation must verify the shell at 1024px and 1440px, with long
provider names, many providers, long raw documents, preview errors and no
selected provider. No new dependency or layout framework is justified.

### 11.4 Common editor and detail containment follow-up

- Common configuration remains type-scoped: Claude uses JSON, Codex/Grok Build
  use TOML. The editor is collapsible but defaults open to preserve existing
  visibility. Monaco provides code editing, folding and accessible naming.
- A Validate action calls a non-writing backend command. The repository keeps
  one validation rule set for both validate and save, so TOML errors and secret
  fields are surfaced before any database write.
- The page surface selector precedes the CLI type selector. Detail cards use a
  shared min-width/overflow contract, responsive info columns and wrapping
  action rows so long values cannot push controls outside the detail viewport.
