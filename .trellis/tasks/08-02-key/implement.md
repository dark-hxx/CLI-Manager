# Provider Domain Rebuild — Phased Implementation Plan

## Delivery rule

This task is planning-only. The earlier incomplete native-provider code is
removed before implementation begins. Historical application-database migration
registrations remain only to keep existing user databases bootable.

Every implementation phase starts by rereading:

- `.trellis/spec/guides/fix-triage-guide.md`;
- the backend and frontend CC Switch provider-domain contracts added by this
  task;
- `.trellis/tasks/08-02-key/{prd,design,acceptance}.md`;
- the pinned upstream research before copying an interface/schema.

For every changed function/class/method, run GitNexus upstream impact analysis
first. Stop and notify the user before editing a HIGH/CRITICAL result. Run
`detect_changes(compare master)` before the final commit.

## Phase 0 — Baseline, source pin, and compatibility boundary

1. Pin the exact CC Switch main commit and exact multi-key branch/PR commit in
   a source manifest. Re-run schema/API extraction rather than trusting this
   planning snapshot.
2. Inspect actual `providers.db` target path/data-root rules and create a
   dedicated Rust database opener with WAL, bounded busy timeout, foreign keys,
   and backup strategy.
3. Retain and test old `cli-manager.db` provider-migration tombstones; make
   no new code read their `managed_*` tables.
4. Write the provider-domain migrations: CCS core, type common settings,
   manual `provider_api_keys`, home preferences, apply journal, import refs,
   and repair issues.
5. Add a fixture suite for CCS mainline single-key, PR multi-key, corrupt DB,
   duplicate IDs across app types, and old project/Worktree override payloads.

**Exit:** a clean app starts with prior user databases; a fresh
`providers.db` contains the target schema; no production command reads it
yet.

## Phase 1 — Domain repository, DTOs, and catalog/key commands

1. Port provider entity/config shapes and CRUD semantics from pinned CCS into a
   CLI-Manager provider module; retain composite identity everywhere.
2. Implement catalog commands: list, get editor detail, create, update,
   duplicate, delete, enable/disable, reorder, and type current state.
3. Implement manual key commands: list/create/update/delete/reorder/activate,
   enabled state, active-key partial unique index, and provider credential
   projection in the same transaction.
4. Implement provider state/reference checks and stable error codes. A global
   or scope-referenced provider cannot be deleted/disabled.
5. Implement full-document parsing and field synchronization for Claude,
   Codex auth/config, and Grok. Include endpoint and model helpers.
6. Implement type common-config persistence, merge, effective preview, and
   explicit credential reveal boundary.

**Exit:** Rust unit/integration tests prove catalog/key invariants,
configuration round trips, common inheritance, projection synchronization, and
secret-redaction defaults with no CCS file present.

## Phase 2 — Home resolver, diagnostics, and live global apply

1. Build `CliHomeResolver` for auto/manual local and WSL Home preferences,
   derived target paths, validation, and explicit-reset behavior.
2. Refactor Hook/statusline default-directory consumers and automatic history
   root consumers to use the resolver while retaining explicit per-feature
   roots with higher priority.
3. Implement provider environment inspection with masked result DTOs and
   user-selectable Home; add open-target and copy-diagnostics actions.
4. Port/implement owner-aware writers for Claude, Codex, and Grok Build:
   stage, parse, backup, replace, verify, compensate, and journal recovery.
5. Implement global preview/apply/current/repair commands; support initial
   missing files, read-only/invalid files, external-modification fingerprint
   conflicts, mid-apply failure, and restart recovery.

**Exit:** all three types can apply an eligible provider to the selected real
Home and compensate all changed files if one target fails. Hook/history
defaults match the resolver’s displayed targets.

## Phase 3 — Native project/Worktree resolver and terminal integration

1. Introduce v2 native provider-reference types and a migration/repair view
   for old CCS payloads. Preserve unmapped records rather than guessing.
2. Replace provider selection modal data calls with native catalog/selectable
   provider commands for Claude, Codex, and Grok.
3. Implement `ProviderResolver` precedence and
   `ProviderMaterializer` generated paths. Preserve shell escaping,
   environment isolation, and no-secret-in-command invariants.
4. Wire terminal create, project startup command, Worktree launch, session
   restoration, badges, and CC Connect to native resolution. Keep remote SSH
   provider injection disabled.
5. Remove normal-path `ccswitch_*` reads/prepares/resets and retain only the
   import reader/repair adapter.

**Exit:** project and Worktree switches work with `.cc-switch` absent;
Worktree > project > global is demonstrated for all local launch modes; an
existing terminal never changes in place.

## Phase 4 — CCS import, repair, backup/sync boundary

1. Build read-only snapshot adapters for local/WSL CCS paths, schema detection,
   app-type normalization, source fingerprints, and key discovery.
2. Implement import preview with key consent, conflict rows, update/no-op
   classification, current-provider candidate, and legacy override mapping.
3. Implement transactional import commit, source refs, issue persistence, and
   explicit global apply choice.
4. Implement repeat import, source-change update preview, repair of unmapped
   scope references, and clean error reporting for corrupt/missing source DB.
5. Exclude plaintext key data from default backup/sync/export; add metadata
   placeholders and a UI disclosure.

**Exit:** a user can import standard CCS and the compatible multi-key data
shape, then operate natively after CCS is removed. Repeated import is
idempotent.

## Phase 5 — Full provider-maintenance UI

1. Rebuild Provider Settings as the high-fidelity list/editor prototype:
   type tabs, global strip, drag cards, search, CCS import, environment check,
   current indicator, and add/duplicate/delete actions.
2. Build the editor shell shared by Claude/Codex/Grok with structured
   name/note/website/base URL/API URL/model controls, status, inheritance,
   unsaved-change warning, preview, validation, and global apply.
3. Build multi-key management: password entry, explicit reveal, label/note/
   tags, active selection, replacement-confirmation flow, manual reorder, and
   no automatic controls.
4. Build type-common config editor and source/effective/live-diff views.
5. Build document editors:
   Claude `settings.json`; Codex `auth.json` + `config.toml`; Grok
   `config.toml`. Preserve code editor navigation, parse errors, advanced
   fields, model test/billing panels, and model visibility.
6. Build Home/Environment screen, import preview/conflict/repair dialogs, and
   project selector migration UI.
7. Add complete `zh-CN`/`en-US` strings, ARIA labels, keyboard flows, and
   responsive setting-page behavior at 1024/1440 widths.

**Exit:** screen review matches the approved prototype and CCS editing depth;
there is no minimal-only provider form.

## Phase 6 — Cutover, hardening, and cleanup

1. Run migration from a representative existing CLI-Manager DB and a CCS
   database. Verify stale historical schema does not block startup.
2. Use GitNexus to search/trace every old `ccswitch_*` runtime dependency,
   ProviderSwitchModal path, history root resolver, Hook target, and terminal
   prepare flow. Remove unused runtime code only after native replacement.
3. Add regression tests for crash recovery, DB busy contention, live-file
   external edit, bilingual UI, WSL distributions, Worktrees, multi-pane
   terminal sessions, and explicit directory overrides.
4. Update user documentation, feature inventory, backup warnings, rules, and
   changelog with the user-supplied release version (not `[TEMP]`).

**Exit:** no reachable production path requires CCS; all acceptance gates pass.

## Verification cadence

After each backend phase:

```powershell
cd src-tauri
cargo check
cargo test
```

After each frontend phase:

```powershell
npx tsc --noEmit
```

Before handoff:

1. run focused Rust/frontend tests and the manual matrix in `acceptance.md`;
2. switch UI language to Chinese and English;
3. run `detect_changes({ scope: "compare", base_ref: "master" })`;
4. stage only task-owned files; preserve unrelated user work;
5. run Trellis quality check and update the permanent contracts with verified
   facts.

## Phase 7 — Manual UI feedback follow-up

1. Refactor `NativeProviderSettingsPage` into a catalog surface and a separate
   `CLI Home` surface without changing provider/Home backend commands.
2. Move `NativeProviderImportSection` behind an Import modal/drawer action;
   preserve preview, repair, consent, commit, error and unsaved-state behavior.
3. Add presentation-only project/Worktree name resolution to repair rows;
   keep exact IDs for repair commands and show a localized missing fallback.
4. Give the provider list/detail grid one bounded responsive height and two
   independent scroll containers. Verify loading, empty, error, many-provider,
   long-document and no-selection states.
5. Add all new action, view, repair-label, empty-state and accessibility copy
   to both `zh-CN` and `en-US`; preserve keyboard/focus behavior.
6. Run `npx tsc --noEmit`, focused frontend tests, i18n parity, `git diff
   --check`, then update `acceptance.md`, `ACCEPTANCE-CLOSEOUT.md`,
   `HANDOFF.md` and `[TEMP]` CHANGELOG evidence.

**Phase 7 exit:** Import is not permanently inline, CLI Home is a separate
surface, repair references are readable, and catalog/detail panes remain
equal-height and independently scrollable at the required widths.

### Phase 7 implementation result (2026-08-04)

Static implementation and the focused scope-label regression test are complete.
The remaining 1024px/1440px runtime layout, keyboard/focus/ARIA, language,
macOS and WSL checks remain manual/environment-blocked; this phase must not be
interpreted as full Gate 27 completion.

### Phase 7 UI editor/layout follow-up (2026-08-04)

- Added a collapsible Monaco common-config editor with JSON mode for Claude and
  TOML editing mode for Codex/Grok Build; visible Validate action is wired to a
  non-writing backend validator and shares the save validation rules.
- Moved surface navigation above the CLI type tabs and preserved the existing
  type-tab icons.
- Hardened the detail pane for 1024px-class widths: responsive info grid,
  wrapping action/key rows, `min-w-0`, and horizontal overflow guards across
  provider, key and full-document cards.
- Added four Rust regression tests for common JSON/TOML validation. Static and
  Rust checks pass; runtime UI/macOS/WSL checks remain blocked.
