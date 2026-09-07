# Provider Domain Rebuild — Acceptance Plan

## Gate 0 — Removal and baseline

- [x] The shallow native-provider UI/store/commands are absent.
- [x] Settings returns to the stable CCS read-only page until the rebuilt
  native UI is delivered; no half-working native screen remains reachable.
- [x] Historical v25/v26 provider migration registrations remain immutable and
  existing `cli-manager.db` starts successfully.
- [x] The high-risk Hook status behavior remains intact.
- [x] `npx tsc --noEmit` and `cd src-tauri && cargo check` pass after
  cleanup.

Phase 0 implementation evidence (2026-08-02): the independent `providers.db`
opener creates the CCS-compatible core plus manual-key, type-common,
Home/import/repair, and apply-journal tables; configures WAL, foreign keys, a
5-second busy timeout, and migration-before-backup handling. The historical
v25/v26 migration source is unchanged, and no production provider command
reads the new database yet. Rust tests cover fresh initialization, common
config seeds, composite identity, foreign-key cascade, active-key uniqueness,
backup preservation, and idempotent re-open.

## Gate 1 — Provider-domain database and catalog

| ID | Given / when | Then |
| --- | --- | --- |
| DB-01 | A fresh data root starts | A separate `providers.db` has CCS-compatible core tables, manual key table, common settings, import refs, home preferences, and journal. |
| DB-02 | Same `id` exists for Codex and Claude | Composite `(id, app_type)` identity keeps both records independent. |
| DB-03 | User creates/duplicates/reorders/deletes a provider | List/card order, notes, URL, model and documents persist; copy behavior is explicit for keys/current state. |
| DB-04 | A provider is referenced by global/project/Worktree | Disable/delete is rejected with reference details and no mutation. |
| DB-05 | Two activation requests race | DB constraint and transaction leave at most one active key per provider/type. |
| DB-06 | Key A is active and user deletes/disables it | UI/backend require a same-provider replacement or an explicit draft transition. |
| DB-07 | User saves documents with an active key | Key table and projected CCS-shaped settings config remain identical for the selected credential. |
| DB-08 | CCS database is absent or corrupt | Native catalog opens normally; only import reports the source problem. |

## Gate 2 — Complete configuration editor

- [ ] Provider list matches
  `assets/ccs-provider-domain-prototype.png`: three type tabs, global
  current strip, search, drag ordering, provider cards, base URL/model/key
  status, import/environment/add actions.
- [ ] Every provider editor opens with visible base URL/API request URL, active
  API key/key manager, and model selection before advanced/raw configuration.
- [ ] Claude supports typed fields plus a complete editable `settings.json`.
- [ ] Codex supports typed fields plus complete editable `auth.json` and
  `config.toml`; the latter round-trips `model`, `model_provider`,
  `model_providers`, projects, MCP, hooks, features and unknown data.
- [ ] Grok Build supports typed fields plus complete editable `config.toml`
  and its selected model/provider mapping.
- [ ] The key can be explicitly revealed in the auth/key editor as permitted
  by the plaintext-storage product decision; default list/store/toast/diagnostic
  views remain masked.
- [ ] Raw document parse errors do not overwrite a draft and point to the
  document/field. Structured fields synchronize only after valid parsing.
- [ ] Type common configuration is one editor per type, never stored on a
  provider. Toggling inheritance changes effective preview only after save.
- [ ] Effective merge proves common defaults < provider override < active-key
  projection; arrays replace, provider scalars win, JSON null explicitly wins.
- [ ] Source/common/provider/effective/live-diff views identify field origin.
- [ ] No UI exposes automatic rotation, health, quota, retry, validity, or
  failover controls.
- [ ] Import is opened by an explicit catalog action; the source path, preview,
  repair mapping, consent and commit workflow are not permanently inline in
  the provider catalog.
- [ ] Import repair rows show project/Worktree display names, with stable IDs
  retained as secondary diagnostics and a localized fallback for deleted
  records.
- [ ] CLI Home is a separate provider-page surface; the catalog does not render
  the full Home/environment/global-apply section inline.

## Gate 3 — Global Home materialization

| ID | Given / when | Then |
| --- | --- | --- |
| G-01 | Eligible Claude provider is applied globally | Selected Home’s `.claude/settings.json` contains provider-owned endpoint/model/key fields and preserves hooks/permissions/unknown fields. |
| G-02 | Eligible Codex provider is applied globally | Selected Home’s `.codex/auth.json` and `.codex/config.toml` both represent the provider; model and provider endpoint are visible. |
| G-03 | Eligible Grok provider is applied globally | Selected Home’s `.grok/config.toml` contains its provider-owned mapping and preserves allowed unrelated configuration. |
| G-04 | One of Codex’s target writes fails | Every already written target is restored; DB current state remains previous; journal records recoverable failure. |
| G-05 | App exits/crashes after staging/replacing | Next launch detects and completes/repairs journal; UI does not claim an unverified current provider. |
| G-06 | User changes active key on current provider | The new active key is selected manually; user is asked to reapply globally; no automatic reapply is hidden. |
| G-07 | An existing terminal is running | Global switch does not change its environment/config or restart its process; only later launches use new state. |
| G-08 | Target live config changed since preview | Apply is blocked with a diff/reload/overwrite choice; stale snapshot does not silently overwrite. |

## Gate 4 — Home, environment, Hook, history

- [ ] Auto local Home, manually selected local Home, manually pasted absolute
  Home, reset-to-auto, WSL UNC Home, and two different WSL distributions are
  stored/resolved independently.
- [ ] Selecting `.claude`, `.codex`, `.grok`, a relative path, a file,
  inaccessible path, and read-only path produces a clear rejection/remedy.
- [ ] The screen previews derived `.claude`, `.codex`, `.grok`, live
  target and history paths before saving.
- [ ] Environment inspection reports CLI executable/version, config syntax,
  target access, current provider/key presence, environment conflict
  presence/fingerprint, Home source, and Hook/history alignment without
  returning values.
- [ ] Automatic Hook/statusline targets and automatic Claude/Codex/Grok history
  roots use the selected Home.
- [ ] Existing explicit Hook directory and explicit history source are not
  silently changed; UI labels them as independent and offers explicit adoption.
- [ ] Changing Home refreshes diagnostics/history bindings but does not install,
  uninstall, move, or delete Hook/history files.

## Gate 5 — Native project and Worktree switching

| ID | Given / when | Then |
| --- | --- | --- |
| S-01 | No Worktree/project override | Launch resolves current native global provider. |
| S-02 | Project override exists | Launch resolves it without modifying global Home/current row. |
| S-03 | Worktree override exists | It wins over project override; reset restores project/global in order. |
| S-04 | Claude/Codex/Grok local project starts | Each materializes its documented isolated configuration mechanism; key is process/config scoped and never concatenated into a shell command. |
| S-05 | CCS DB is renamed after import | Provider settings, project selector, badge, terminal create, session restore and CC Connect remain operational. |
| S-06 | Legacy CCS reference maps on import | It becomes v2 native reference through import refs. |
| S-07 | Legacy CCS reference cannot map | It becomes a repair issue; it never picks a same-name/first provider. |
| S-08 | SSH project starts | Local provider secret/config is not sent to the remote host. |
| S-09 | Multiple sessions/panes/Workspaces exist | Their current snapshots remain stable after later scope/key/global changes. |

## Gate 6 — CCS import

- [ ] Preview handles missing/empty/corrupt local and WSL CCS DB paths.
- [ ] Mainline CCS provider imports its metadata, documents, common config,
  current state candidate, and a discoverable single active key after explicit
  key consent.
- [ ] Compatible PR #4957 multi-key records import labels/notes/tags/order/
  enabled/active state, while cooldown/usage/failover data is ignored.
- [ ] Empty/OAuth/unknown credential layouts become a labelled draft/skipped
  result, never a blank active key.
- [ ] Same source identity/fingerprint is idempotent; changed source produces
  an explicit update/conflict preview; same display name alone never merges.
- [ ] Import does not mutate CCS. Global apply is a separate confirmed action.
- [ ] Default sync/backup/export contains no plaintext key; restore shows key
  placeholders requiring re-entry.

## Gate 7 — UX, i18n, accessibility

- [ ] Test 1024px and 1440px widths: list and editor scroll independently;
  no horizontal loss of controls.
- [ ] Mouse and keyboard can create, select, reorder, edit, activate key,
  switch global provider, open common editor, inspect Home and import.
- [ ] Focus order follows the visual order; dialog close/delete returns focus
  to an appropriate provider card; destructive changes use app confirmations.
- [ ] Status is text + icon/color. Buttons have labels; editors and parse
  errors are associated with fields.
- [ ] All new visible strings exist in `zh-CN` and `en-US`; manually switch
  language and verify no fallback keys or 12-hour time format.
- [ ] Screen review confirms the supplied CCS screenshots’ functional depth:
  list cards, top-level endpoint/key/model, multi-key, raw full config,
  common config and global switch are all present.
- [ ] The provider list and detail panes use the same bounded responsive height;
  both scroll independently, long lists do not grow the outer page, and no
  detail card is blank, clipped, overlapped or pushed off-screen.

## Required automated checks

```powershell
npx tsc --noEmit
cd src-tauri
cargo check
cargo test
```

Add focused Rust tests for schema/migrations, parser/merge, type writers,
journal compensation/recovery, resolver precedence, import mapping, and
redaction. Add frontend tests for catalog/editor/key/common/Home/import state,
localized error mapping, and scope selector behavior.

## Release gate

- [ ] All P0/Gate 0–5 scenarios pass; CCS import P1/Gate 6 has no unexplained
  failures.
- [ ] No production data path calls a CCS runtime list/prepare/reset/switch
  command after cutover.
- [ ] GitNexus `detect_changes(compare master)` contains only expected
  provider-domain flows.
- [ ] Changelog target is replaced from `[TEMP]` with the user-provided
  release version.

### Phase 7 implementation evidence (2026-08-04)

- [x] Static UI implementation: the catalog exposes an Import action and only
  mounts the complete import workflow inside a modal while it is open.
- [x] Repair labels resolve project/Worktree names from the project snapshot;
  exact issue/provider IDs remain unchanged for repair commands, with localized
  missing-record fallbacks. `node --test scripts/nativeProviderImportDisplay.test.mjs`:
  3 passed, 0 failed.
- [x] CLI Home is a separate page surface and reuses the existing Home hook and
  section; catalog/common-config content is not rendered in that surface.
- [x] The catalog/detail shell has one bounded responsive height at `lg` and
  independent vertical scrolling; the catalog itself fills the shared height.
- [x] New action, surface, repair-label and fallback strings have matching
  `zh-CN`/`en-US` entries; static parity is zh=3434/en=3434 with no missing or
  extra keys.
- [ ] Runtime UI checks at 1024px/1440px, keyboard/focus/ARIA, language switch,
  macOS runtime and WSL paths remain blocked by the current environment and
  closeout constraints.

### UI-05~08 implementation evidence (2026-08-04)

- [x] Common configuration is collapsible and uses Monaco for editing. Claude
  is presented as JSON; Codex/Grok Build are presented as TOML. JSON local
  object checks and the non-writing backend `provider_common_config_validate`
  command provide validation before save.
- [x] Existing Claude/Codex/Grok type tabs retain their corresponding icons.
- [x] `供应商目录 / CLI Home` surface navigation is rendered above the CLI type
  tabs; only the selected surface is mounted.
- [x] Provider detail, key and raw-document cards have responsive min-width and
  overflow protection; narrow layouts wrap or collapse detail fields instead
  of clipping them, while list/detail panes retain independent scrolling.
- [ ] Runtime verification at 1024px/1440px, Monaco focus/ARIA, keyboard flow,
  language switching, macOS runtime and WSL remain environment-blocked.
