# Provider Domain Rebuild — Requirements Research

## Changelog target

`[TEMP]`

## Decision

CLI-Manager will own the complete CC Switch-compatible provider domain. It will
not use CC Switch as a runtime provider catalog, switch engine, or project
launch dependency. CC Switch remains an explicit, read-only import source.

The target is deliberately a **complete provider domain**, not a reduced
“provider + URL + key” form:

- provider CRUD, copy, ordering, notes, icons, enabled/current state;
- all provider configuration for Claude Code, Codex, and Grok Build;
- a type-level common configuration with per-provider inheritance;
- multiple plaintext keys and manual selection of one active key;
- global switching that writes the selected provider into the selected user
  Home’s real CLI configuration files;
- project and Worktree overrides resolved from CLI-Manager’s database;
- local/WSL environment inspection and one authoritative, user-selectable
  Home root;
- CCS import, preview, conflict handling, and legacy override migration.

This scope copies the supplier-oriented tables, configuration shapes, command
semantics, and screen depth of CC Switch. It does **not** copy CC Switch’s
unrelated proxy, MCP, prompt, quota, payment, usage, or automatic key-routing
subsystems.

## Product problem

Today provider selection is coupled to `.cc-switch/cc-switch.db`. That causes
an external program’s installation, schema, and IDs to decide whether
CLI-Manager can list providers, launch a project override, or recover a
session. The brief native-provider attempt was intentionally removed because
it provided only a shallow text form and did not match the full configuration
experience users rely on in CC Switch.

The replacement must preserve the powerful part of CCS: a provider is a real
configuration profile, including endpoint, models, credentials, raw config
documents, common configuration, and a globally materialized live state.

## User-facing outcomes

1. A user can maintain Claude Code, Codex, and Grok Build providers without
   installing or opening CC Switch.
2. One provider can contain multiple account/API keys. The user explicitly
   chooses the active key. There is no automatic validation, rotation,
   failover, cooldown, quota, or health-based switching.
3. A user can select a global provider for each CLI type and CLI-Manager writes
   that provider into the selected Home’s actual CLI files. A newly opened CLI
   outside CLI-Manager sees that choice too.
4. A user can optionally select a provider for a project or Worktree. The
   launch uses CLI-Manager’s provider database, never a CCS lookup.
5. A user can inspect and edit the complete type-specific configuration:
   models, endpoint/base URL, auth file, main config file, advanced fields,
   and effective merged output. Existing non-provider configuration such as
   MCP, hooks, projects, and permissions is retained when applying globally.
6. A user can choose the Home used for diagnosis and global application. The
   same Home drives default hook targets and session-history roots unless a
   user has explicitly configured a more-specific override.
7. Existing CCS data can be imported safely and repeatedly, with a preview
   rather than becoming a permanent external runtime dependency.

## Functional requirements

### R1. CC Switch-compatible catalog

- The catalog database is app-owned at
  `<CLI-Manager data root>/providers.db`; on the current Windows layout this
  is `~/.cli-manager/providers.db`.
- It contains the CCS supplier-domain tables and JSON/TOML settings shapes,
  with CCS’s composite identity `(id, app_type)` retained.
- Public UI type names are `claude`, `codex`, and `grok`. Storage and
  import normalize Grok to CCS `grokbuild` while accepting its documented
  aliases.
- A provider has name, note, website, category, icon/color, ordering,
  enabled/current state, endpoint/base URL, model settings, full
  `settings_config`, and metadata.
- List cards are reorderable and show name, base URL, selected model, active
  key label/count, and global/current status. They are not merely table rows.
- Create, edit, duplicate, reorder, delete, enable/disable, and explicit
  global switch are complete operations. Deleting a current/referenced provider
  is rejected with the references that must be changed first.

### R2. Configuration completeness by CLI type

The editor is configuration-first and follows the CCS supplier-editing model.
It must provide structured fields **and** raw documents; neither is a
replacement for the other.

| Type | Required editor surfaces | Global live targets |
| --- | --- | --- |
| Claude Code | provider name/note/website, API base URL, active API key, model family fields, advanced options, complete `settings.json` JSON, effective JSON/diff | `<home>/.claude/settings.json` |
| Codex | provider name/note/website, API base URL/request URL, active API key, `model`, `model_provider`, model-provider fields, advanced options, full `auth.json` JSON, full `config.toml` TOML, effective config/diff | `<home>/.codex/auth.json` and `<home>/.codex/config.toml` |
| Grok Build | provider name/note/website, API base URL, active API key, model/default-model fields, advanced options, full `config.toml` TOML, effective config/diff | `<home>/.grok/config.toml` |

- API base URL, active key, and at least the type’s model selection are visible
  at the top of a provider editor. They are validated before a provider can be
  globally applied; draft providers may remain incomplete.
- The raw documents are full editable documents, not a restricted set of
  fields. Codex’s editor must retain/round-trip `auth.json` and
  `config.toml`, including model providers, MCP, hooks, project trust, and
  unknown fields.
- API key input and auth/config document represent the same active credential.
  The UI may reveal and edit it in the explicit full-config editor because
  plaintext storage is a product decision; on save the backend reconciles it
  with the selected key record in one transaction. A key must not silently
  diverge between a raw document and the key table.
- Typed helper controls update the corresponding raw document fields and show
  where the field is written. Raw edits update structured controls after
  successful parsing. If a document cannot be parsed, the field controls show
  the parse error and cannot overwrite it.

### R3. Type-level common configuration

- Common configuration belongs to a CLI **type**, never to a provider.
- Each type has a dedicated common-config editor reachable from its type tab:
  Claude JSON; Codex shared TOML plus the supported authentication/common
  document; Grok TOML.
- Each provider has a visible `inherit common configuration` switch. Its own
  settings override common settings; disabling inheritance uses only that
  provider’s settings.
- The UI exposes Source / Type common / Provider / Effective / Live diff
  views. It must show which source wins for each conflicting field.
- Merge policy: recursively merge objects/tables; provider scalar/table values
  win; arrays are replaced; JSON `null` explicitly overrides a common value.
  Key material is injected only after the common/provider merge.
- Although current CCS does not provide a Grok common snippet, this product
  explicitly requires one. Its format and merge behavior are the Grok Build
  TOML equivalent; it must not be emulated as a provider-specific config.

### R4. Manual multi-key mode

- A provider can contain zero or more keys. A non-draft enabled provider has
  exactly one active key; first key creation may make it active after user
  confirmation.
- Every key has label, note, optional tags, enabled flag, sort order, creation
  time, and plaintext `api_key`. The product explicitly chooses plaintext
  SQLite storage.
- The user can add, edit, reorder, disable, delete, and manually activate a
  key. Activating a key updates the selected provider’s credential projection
  and, if that provider is current, offers to reapply the live config.
- Deleting/disabling the active key requires an explicit replacement key or
  turns the provider into a draft only after a destructive confirmation. No
  background process chooses another key.
- Excluded: automatic key validation, retry, rotation, round-robin,
  rate-limit detection, health state, cooldown, failover, balance/usage
  polling, and proxy/key-pool runtime.

### R5. Global provider switching

- Global is one current provider per CLI type and is an externally observable
  live-config state, not only a row in a database.
- Applying globally resolves the selected Home, creates required directories,
  stages every target file, parses/validates each staged file, writes backups,
  replaces the live targets, then commits the current-provider state.
- Codex is a multi-file apply and must compensate both `auth.json` and
  `config.toml` if either target fails. No database state may claim success
  while live files still represent the previous provider.
- Existing files are owner-aware: provider-owned values are updated, while
  user/CLI-Manager-owned hooks, permissions, MCP, projects, statusline, and
  unknown fields are preserved according to the type writer contract.
- A provider switch changes future processes only. Existing terminal sessions,
  panes, Workspaces, minimized windows, and tray background state keep their
  launch-time environment/config snapshot.

### R6. Project and Worktree switching

- Existing project/Worktree provider selectors are migrated to read the native
  catalog and reference `{ schemaVersion, source: "cli-manager",
  providerId, appType }`.
- Resolution is `Worktree override > project override > type global current`.
  Reset restores the next lower layer; it never alters the global current
  provider.
- A local launch materializes an isolated provider configuration:
  Claude uses a generated settings file and `--settings`; Codex uses an
  generated profile; Grok Build uses a per-process `GROK_HOME`. These are
  project-only mechanics and cannot substitute for the global Home write.
- The active native key is injected into the target process/config, never
  embedded in a shell command. SSH/remote launch continues to reject local
  provider-key injection until a separately approved remote-secret design
  exists.
- Migration from existing CCS override IDs is done through an import mapping
  table. There is no name, UUID-shape, or “first provider” heuristic fallback.
  Unmapped records remain visible as repair issues.

### R7. Home selection and environment diagnostics

- The provider domain owns a `CliHomeResolver` with automatic and manual
  modes. Manual mode accepts a Home root, not `.claude`, `.codex`, or
  `.grok` directly.
- Home choices are stored per execution environment: local Windows and each
  WSL distribution. A Windows path is never copied to a WSL profile.
- The resolver exposes the three derived config roots and history roots before
  the user saves. It rejects relative, file, inaccessible, or read-only Home
  selections and explains the remedy.
- Environment check reports CLI availability/version, config target/file
  syntax, active provider/key presence, write access, environment-variable
  conflicts, Home source, and Hook/history target alignment. It returns
  presence/masked fingerprints only, never environment variable values.
- Hook install/statusline targets and automatic history roots consume the same
  resolver. Explicit Hook config roots and explicit history source instances
  remain higher-priority and are labelled `not following selected Home`;
  users can explicitly adopt the selected Home. Selecting a Home never moves,
  deletes, installs, or uninstalls a Hook.

### R8. CCS import and cutover

- Import reads a selected/default CCS SQLite file as an external, read-only
  source; SQLite snapshot handling supports local and WSL paths.
- Preview lists source provider identity, type, settings/config documents,
  current state, discoverable legacy key, key import result, conflicts, and
  affected project/Worktree references. Secrets are shown only after an
  explicit “include keys” acknowledgement.
- Existing CCS single-key provider credentials become one manual active key.
  When importing a CCS multi-key database compatible with PR #4957, all keys,
  labels, notes, enabled/order, and active selection transfer; rotation,
  quota, cooldown, errors, and usage data are ignored.
- Import uses `(source path identity, app_type, source provider id,
  fingerprint)` for idempotency. Same-name providers never silently merge.
- Import current-provider flags into native global current state only after
  confirmation to apply to the selected Home.
- After cutover all production list, select, launch, badge, CC Connect,
  session restore, and configuration operations resolve native data. CCS
  commands are reduced to import/repair and no production path reads CCS.

## Non-functional constraints

- Desktop-first Windows UI; local PowerShell, CMD, Pwsh, Git Bash and WSL
  launch paths are supported.
- All user-visible copy, error code translations, tooltips, and ARIA labels
  are present in `zh-CN` and `en-US`; English remains 24-hour time.
- Plaintext storage is disclosed in the provider editor and backup/export UI.
  Despite plaintext storage, logs, diagnostics, ordinary UI state, masks,
  crash reports, and default sync/export must not leak full values.
- Provider management commands are Rust/Tauri commands; frontend SQL cannot
  bypass parse, atomicity, reference, Home, or redaction rules.
- No automatic installation/removal of CLIs, environment variables, proxies,
  Hook files, history files, or configuration directories.

## Explicit exclusions

- CC Switch’s proxy service, key ring, usage/billing, balance checks, prompt
  library, MCP library, marketplace, and account automation.
- Automated API key validation, automatic switch/rotation/failover, rate-limit
  management, key health checks, or traffic scheduling.
- Cross-device plaintext key sync/export. Default backup/sync includes
  metadata/config only and restores key placeholders.
- Remote SSH provider or credential deployment.

## Scenario matrix

| Dimension | Required cases |
| --- | --- |
| CLI type | Claude Code, Codex, Grok Build; incomplete draft and complete provider |
| Key state | none, one, several, disabled, active replacement, imported single/multi key |
| Scope | global, project, Worktree, reset to inherited; existing terminal remains unchanged |
| Home | auto local, manual local, manual WSL UNC, each WSL distro, invalid/read-only, restore auto |
| Live files | absent, valid, unknown fields, parse error, external concurrent modification, write failure/rollback |
| Terminal | PowerShell, CMD, Pwsh, Git Bash, WSL; single/multiple panes and Workspaces |
| Hook/history | follow Home, explicit Hook root, explicit history source, install missing/partial/third-party |
| CCS | absent, empty, valid single-key, compatible multi-key, corrupt, conflicts, repeated import |
| UI | list search/reorder, keyboard, 1024/1440 widths, Chinese/English, unsaved editor draft |

## Success criteria

- The provider settings page is a complete CCS-class maintenance surface,
  including visible base URL, API key/key list, models, full documents and
  type common configuration—not a minimal config textarea.
- A global switch demonstrably changes the real Home files for all three
  types and survives restarting CLI-Manager.
- Project/Worktree launch is native-only; removing/renaming
  `.cc-switch/cc-switch.db` does not impair native list, switch, or launch.
- Manual activation selects exactly one key without any automated key behavior.
- Home diagnostics, Hook status/install target, and automatic history source
  derive from one chosen Home and preserve explicit overrides.

## UI follow-up from manual review (2026-08-04)

The following adjustments are part of this existing provider-domain task. They
are acceptance-driven UI corrections, not a new provider capability.

### Confirmed product direction

1. CCS import is a secondary flow. The native provider catalog shows only an
   Import action; the import source path, preview, repair references, key
   consent and commit flow open in a modal/drawer and are not rendered as a
   permanent inline section in the catalog.
2. CLI Home is a separate settings surface reachable from the native provider
   page. The existing Home selection, derived targets, diagnostics, global
   apply and explicit Adopt actions move there and no longer consume vertical
   space in the provider catalog view.
3. The provider catalog and selected-provider detail are two equal-height,
   independently scrollable panes. The provider list has a bounded viewport;
   adding providers must not grow the page or push detail content out of view.

### UI requirements

- UI-01: Unresolved imported project/Worktree references display the readable
  project or Worktree name. The stable ID remains available in a tooltip or
  secondary text; if the record no longer exists, show a localized missing
  label plus the ID rather than an opaque UUID-only row.
- UI-02: The catalog header exposes an Import button. Opening it shows the
  complete existing import workflow, including source selection, preview,
  repair mapping, key consent, update consent, commit and errors. Closing the
  surface preserves no stale preview as an inline catalog block.
- UI-03: The catalog header or page sub-navigation exposes `CLI Home` and
  opens the existing Home/environment/global-apply surface as its own view.
  Home state, selected provider type and unsaved-change guards remain intact.
- UI-04: The catalog/detail shell uses one responsive height contract. The
  list and detail panes scroll independently, have no unbounded provider list,
  and do not create blank, clipped, overlapping or off-screen detail cards.
  Loading, empty and error states must also occupy the same pane height.
- UI-05: The above controls and view changes are fully localized in `zh-CN`
  and `en-US`, keyboard reachable, focus-visible and labelled for assistive
  technology.

### Acceptance additions

- At least six providers do not increase the outer page height; the list and
  detail viewport bottoms align at 1024px and 1440px.
- Import is absent from the catalog body until the user activates the Import
  action; the modal/drawer can be closed and reopened without a stale preview.
- A repair row reads `项目名 / Worktree 名` rather than only
  `scopeKind:scopeId`, while preserving deterministic fallback for deleted
  records.
- CLI Home can be opened, switched, saved, previewed and closed without
  changing provider selection or silently changing Hook/history overrides.

### UI-05~08 acceptance additions

- Common configuration opens in a collapsible code editor. Claude uses JSON;
  Codex and Grok Build use TOML. Validate must not write the database, and Save
  must use the same syntax/secret checks.
- Claude/Codex/Grok type tabs retain visible, keyboard-reachable type icons.
- The `供应商目录 / CLI Home` surface selector is above the type selector.
- At 1024px and 1440px, long URLs, Key labels, raw documents and field-source
  rows must remain readable; detail cards may wrap or scroll but must not clip,
  overlap or push their controls off-screen.
