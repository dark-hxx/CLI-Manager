# CCS-Compatible Provider Domain UI Contracts

> Planned frontend contract for task `08-02-key`. It replaces the removed
> minimal native-provider form and is intentionally a complete configuration
> experience.

## Screen structure

The Provider Settings page is a master/detail workspace:

1. CLI type tabs: Claude Code, Codex, Grok Build.
2. Global-current strip: selected Home, current provider, active key state,
   preview/apply action.
3. Catalog pane: search, import CCS, environment check, add, reorderable
   provider cards, current/draft/disabled/reference badges.
4. Editor pane: provider metadata, endpoint/API request URL, model/model
   provider, status, multi-key, type-common inheritance, raw documents,
   effective/live diff, advanced panels and save/apply actions.

Provider cards always show provider name, base URL, selected model, key count/
active label and state. The drag handle is the first control in each row and
remains visible; only secondary actions use hover/focus reveal. The initial
form must not hide URL, key or model in a generic configuration textarea.

## Complete editor contract

- Claude has a full `settings.json` editor.
- Codex has independent full `auth.json` and `config.toml` editors,
  including MCP/hooks/projects/features/unknown config. Typed helper controls
  include API base/request URL, `model`, `model_provider` and provider
  fields.
- Grok Build has a full `config.toml` editor with endpoint and selected model.
- All types have Name, Note, Website, enable/current state, model visibility,
  advanced settings, validation, effective configuration and live diff.
- Helper field changes and raw-document changes round-trip only through
  backend parser/patch results. A syntax error retains the local draft and
  blocks destructive overwrite; a server-side parse/secret-edit error is
  rendered by the active document editor and associated with its field.
- Common config opens from the current **type**, not selected provider. The
  provider’s inherit switch identifies its origin and effective precedence.
- The UI includes source/common/provider/effective/live-diff labels and
  communicates provider-over-common field precedence.

## Key interaction contract

- A key row exposes label, note/tags, enabled state, masked hint, active badge,
  and explicit actions: add, edit, reveal, activate, disable/delete, reorder.
- Manual activation is the only selection mechanism. The screen contains no
  auto-switch, health, validity, quota, retry, cooldown, rotation or failover
  wording/control.
- Key creation/replacement input is local component state, password-masked,
  cleared after every terminal action and never persisted in Zustand/local
  storage.
- Plaintext database storage is disclosed. Explicit reveal/auth-document view
  may show the selected credential as a product choice, but the resulting
  response must not become a durable store snapshot, toast, analytics payload
  or debug log.
- Deleting/disabling active key needs a replacement/explicit draft confirmation.
  Do not select another key optimistically.

## Global, scope, Home, and import interactions

- Global apply is an explicit preview -> confirmation -> progress -> verified
  result flow. It tells users it writes the selected Home’s real CLI files and
  applies to new CLI processes only.
- The sidebar provider quick-switch uses the same global preview -> confirmation
  -> apply flow against the active CLI Home. It must not create or mutate a
  project or Worktree override. Existing overrides are intentionally left
  untouched because this pre-release product does not require migration or
  cleanup of those records. The quick-switch header shows a localized local/WSL
  icon and, for WSL, the selected distribution.
- The project/Worktree selector lists eligible Claude/Codex native providers
  and visibly resolves Worktree > project > global. Reset means follow the
  next lower scope. Grok Build is a direct localized unsupported state: do not
  load a catalog, write an override, or call global preview/apply; historical
  Grok overrides remain backend-compatible but are not editable from this UI.
- Home selection offers auto, choose folder, paste absolute path and reset.
  The chooser remains enabled for local and WSL environments in both modes,
  and uses the current Home as its initial directory. A successful selection
  changes the draft to manual mode before storing the selected path;
  cancelling leaves both mode and path unchanged. Disable the chooser only
  while a Home action is busy.
  It shows derived Claude/Codex/Grok live/config/history/Hook paths and warns
  if a feature has an explicit root not following Home. It never performs an
  unrequested Hook install/uninstall/move.
- In WSL mode, the environment selector lists installed distributions from the
  read-only `provider_wsl_list_distros` command. Preserve the current selected
  distribution when it still exists; otherwise select the first returned item.
  Local mode keeps the reserved `host` identity.
- Switching environment or WSL distribution only changes the draft selection:
  preserve the last successfully loaded Home/diagnostic snapshot and do not
  call Home detection or environment inspection until the user explicitly
  refreshes, saves, or resets. WSL draft changes must not trigger the Home
  preview probe; local manual-path previews remain allowed.
- The WSL distribution list may load automatically on entering WSL because it
  is only an enumeration request; list failure/empty results remain retryable
  and must not block local mode.
- Home adoption passes the selected CLI config root to the history binding
  synchronizer; Grok derives its single `.grok/sessions` history root there,
  so the UI must not pass an already-derived `sessions` path.
- Environment check renders status, reason, remedy and safe open/copy actions.
  It never displays environment variable values.
- CCS import is a wizard: source selection, scan, key-consent, conflict/
  mapping preview, commit, global-apply option, and repair issue view.
  CCS absence is an import-state message, not a provider-page failure.

## State, errors, accessibility, i18n

- Server snapshots/mutations live in focused domain stores/hooks. Search,
  selection, unsaved raw-document drafts and dialogs are local UI state.
- Do not subscribe the whole settings modal to provider data. Preserve
  selection after list refresh, reorder, mutation or type switch.
- Use `useAppConfirm` for destructive/apply/key-replacement confirmation;
  do not use browser prompt/confirm.
- Every busy mutation disables duplicate submission and preserves the last
  successful snapshot on error. Stable error codes map to localized actionable
  messages; raw backend payloads are never displayed.
- Keyboard order follows screen order; cards, tabs, key rows, code editors and
  dialogs have visible focus and accessible names. Delete returns focus to a
  logical neighboring card.
- Provider cards use a focusable selection control inside a non-interactive
  group; reorder, enable, duplicate and delete controls must not be nested
  inside an element with `role="button"`.
- Type tabs use roving `tabIndex`: only the active tab is in the tab sequence;
  Arrow keys and Home/End select the corresponding type. If selection awaits an
  asynchronous unsaved-change confirmation, accepted selection moves focus to
  the new tab, while cancellation or rejection restores focus to the previous
  active tab. Focus movement must happen after the state transition so the
  active tab remains the single tabbable element.
- Add each string in `zh-CN` and `en-US`, including ARIA, import conflicts,
  Home alignment, apply/journal recovery and key workflow. Verify English
  keeps 24-hour time.

## Review checklist

- Compare the supplier list/editor against task prototype and supplied CCS
  screenshots. The final screen must visibly contain global selection,
  base URL, active key/multi-key, models, full raw config, type common config,
  effective config and save/apply—not just provider CRUD.
- Test 1024px/1440px widths, Chinese/English, keyboard-only use, long
  configuration documents, unsaved changes, empty type, and provider import
  errors.

## Acceptance closeout boundary (2026-08-03)

- Static i18n parity and TypeScript checks are necessary but do not replace runtime language switching, 24-hour display, keyboard/focus, ARIA, or 1024px/1440px layout checks.
- When the application cannot be started under the closeout constraints, those UI checks remain `BLOCKED`; source inspection must not be promoted to a visual PASS.

## UI follow-up contract (2026-08-04)

- The native-provider page exposes two local surfaces: `catalog` and `cliHome`.
  The catalog owns provider type tabs, common config and master/detail editing;
  the Home/environment/global-apply section is rendered only by `cliHome` and
  continues to use the existing Home hook and mutation guards.
- CCS import is secondary UI. The catalog owns an explicit Import action and
  mounts the source picker, preview, consent, repair and commit workflow only
  in the opened modal/drawer. Closing it must remove the temporary preview from
  the catalog DOM.
- Import repair labels are presentation-only resolution:
  `scopeKind + scopeId -> project/Worktree display name -> localized missing
  label + stable ID`. Repair commands must continue to submit exact IDs and
  must never perform name-based matching.
- The catalog/detail shell supplies one bounded responsive viewport height.
  The list pane and detail pane each own vertical scrolling; the outer page
  must not grow with provider count or long raw documents. Loading, empty,
  error and no-selection states must use the same pane contract.
- The static contract does not replace manual 1024px/1440px, keyboard/focus,
  ARIA, runtime language or macOS verification; those remain BLOCKED when the
  application cannot be started in the closeout environment.

## Common editor and detail layout contract (2026-08-04)

- The common configuration editor is collapsible and keeps an accessible
  editor label, expanded state and parse-error association. Claude uses JSON;
  Codex/Grok Build use TOML.
- Validate is a non-writing action. It must report backend validation errors
  without changing the stored common configuration or discarding the draft;
  Save uses the same validation contract before writing.
- Provider detail, key and raw-document cards must use `min-w-0`/responsive
  wrapping at narrow widths. Long values must remain reachable through the
  card's scroll context rather than being clipped by an inner fixed-width row.

## Native provider large-screen detail follow-up (2026-08-04)

- The catalog detail pane exposes four stable views in this order: Basic
  information, Effective config, API keys, and Complete config. Basic
  information is the default and changing provider or CLI type resets to it.
- The catalog basic view reuses the existing global preview → confirmation →
  apply flow, but the explicit Preview click is optional: Apply performs the
  same fresh preflight before confirmation when no preview is present. It must
  not write Home files directly or bypass locks, fingerprints, compensation,
  journal recovery, or post-apply refresh.
- The catalog master/detail grid uses one bounded responsive viewport height;
  the provider list and detail pane share that height and own independent
  vertical scrolling. A long provider list or document must not make the outer
  settings page grow indefinitely on large screens.
- Codex and Grok Build use the same maintenance hierarchy and shared
  components for metadata, keys, raw documents, effective configuration and
  global state. Only app-specific document kinds, formats and target paths
  differ. Claude-only API format/auth/full-URL/model-mapping controls remain
  Claude-only.

## Runtime feedback fixes (2026-08-04)

- Monaco-based provider editors pass a stable `path`, but collapsible editors
  must not set `keepCurrentModel`. Closing the common editor unmounts and
  disposes its model; reopening creates a fresh model from the controlled
  draft value. Retaining the model across `Collapse` unmounts can reuse a
  disposed Monaco instantiation service and throw on the second expansion.
- Claude, Codex and Grok common editors default to collapsed and reset to
  collapsed when the app type changes.
- Effective provider/effective previews use a code-editor surface. Claude
  displays JSON; Codex and Grok Build unwrap the stored JSON envelope and
  display the nested `config` document as TOML. The source-documents view may
  remain a mixed read-only text view because Codex contains both auth JSON and
  config TOML.
- The create/edit provider form exposes the provider-specific document for all
  three app types. The frontend stores the Codex/Grok TOML document inside the
  existing JSON envelope; the backend preserves key-manager-owned JSON/TOML
  secrets while applying the non-secret draft.
- Global current-state detection must prefer an exact match between the
  materialized target files and a provider plan, then fall back to the
  database current flag for drift/key-missing reporting. A database flag alone
  is insufficient after importing an existing Home configuration.
- Detail actions do not include a duplicate button; duplication remains a
  catalog-card action so the detail header stays focused on inspection and
  editing.

## Global apply feedback fix (2026-08-04)

- The global confirmation path must display the app-specific CLI config root:
  Claude uses `Home/.claude`, Codex uses `Home/.codex`, and Grok Build uses
  `Home/.grok`; displaying the Home parent alone is misleading even when the
  backend plan targets the correct directory.
- The Apply button must be usable without a prior explicit Preview click. The
  frontend obtains a fresh preview/fingerprint at apply time and passes it to
  the existing guarded apply command, preserving conflict detection and the
  write/recovery journal contract.

## Codex/Grok advanced provider maintenance (2026-08-04)

- Codex and Grok Build share one advanced maintenance section. It exposes the
  upstream/wire API, manual model mappings, User-Agent, JSON object header/body
  overrides, Goal mode and remote compression. All labels and validation errors
  require `zh-CN` and `en-US` entries.
- Advanced values are stored in the existing provider settings JSON envelope
  under `advanced`. They are UI/provider metadata and must not be copied into
  unsupported official TOML keys or take ownership of API secrets.
- When the nested provider document is empty or absent, the form generates a
  CLI-specific seed from typed fields: Claude JSON, Codex TOML, or Grok TOML.
  This generated document is refreshed while the form remains automatic; once
  the user edits the raw document, it becomes manual and unknown fields are
  preserved.
- Header/body overrides must be JSON objects and every model mapping must have
  non-empty source and target values. Invalid advanced state disables save and
  keeps the draft visible; backend key-manager fields remain authoritative.

## Provider model discovery and key status contract (2026-08-05)

- Claude, Codex and Grok edit forms expose the same fetch-model action. It is
  available only for a persisted provider because the backend resolves the
  active key by provider identity; fetched IDs remain form-local until Save.
- Claude role targets and Codex/Grok mapping targets become searchable selects
  after discovery succeeds. Manual text input remains available before any
  list has been fetched.
- `key.isActive` means current request key, not enabled state. Render it as
  “Current key” independently from the always-visible Enabled/Disabled badge.
  The current key cannot be disabled until another enabled key is activated.
- Provider-card enable switches control whether the provider may participate
  in global/project/Worktree resolution. Current or referenced providers may
  not be disabled, and their stable backend errors require localized feedback.
  Both `provider_referenced_cannot_disable` and
  `provider_referenced_cannot_delete` must render the actionable project/
  Worktree-reference message rather than a generic operation failure.
  Provider reordering also maps stale-list and database errors to actionable
  refresh feedback instead of the generic operation failure.

## Provider routing page memory and active-channel contract (2026-08-09)

- Reopening the provider settings page restores the last app type, surface
  (catalog/Home/routing), detail tab, selected provider, and outer page scroll
  position from the in-memory page cache.
- `selectedProviderId` remains the detail/cache identity, not a permanent list
  selection. The catalog may render its selected card style and `aria-current`
  only while that provider's detail dialog is open; closing the dialog must
  remove the visual state without clearing the cached selection.
- Failover queue rows render `isCurrent` as an explicit localized “In use”
  badge with the primary color, so the channel currently selected by routing is
  distinguishable from merely queued or ready providers.
- The “In use” badge uses a filled, high-contrast style rather than a light
  status pill so it remains legible among queue membership and health badges.

## CLI Home persisted active-state restore contract (2026-08-11)

- On CLI Home mount, the frontend calls `provider_home_active_get` and uses its
  returned identity, mode and Home path as the initial editor state. It must
  not default the editor to `local:host` by calling `provider_home_get`.
- The initial mount must not await `provider_global_current`, environment
  inspection, or WSL Home validation. The cached Home state must render first;
  WSL distribution enumeration may run as a non-blocking auxiliary request.
- Restoring an active WSL Home may separately load the WSL distribution list;
  that list request must not perform Home `$HOME` detection. The selected
  persisted distro remains preferred when it is still installed.
- Explicit refresh, save and reset continue to use the current draft identity
  and update the editor from the backend result. Current-provider feedback must
  use that returned identity rather than a stale pre-action closure.
- If the active-state read fails, show the existing localized Home preference
  error and keep the page recoverable through the existing explicit actions.
- Switching the Claude/Codex/Grok Build type tab must not rerun the active Home
  load, WSL distribution enumeration, Home detection, or environment inspect.
  The Home target cards and environment diagnostics shown below the tabs must
  be filtered to the selected app type; stale app-specific diagnostics are
  cleared until the user explicitly refreshes.
- Local and WSL are separate Home identities. When the environment selector
  changes, restore only the selected identity's cached Home state; on a cache
  miss clear the previous Home/path/diagnostic display. Never show local paths
  under WSL or WSL paths under local merely because detection was deferred.
- Saving or resetting Home updates only the selected Home state and clears
  stale current-provider/diagnostic output. It must not automatically invoke
  `provider_global_current` or `provider_environment_inspect`; the explicit
  top refresh action owns that full follow-up.

## Provider key visual clarity contract (2026-08-07)

- `enabled` means "in the candidate pool, allowed to be activated." Render it
  as **Candidate** (候选), never as "Enabled" (已启用) which collides with
  "in effect." Multiple keys may be candidates simultaneously.
- `isActive` means "the one key actually materialized into config files."
  Exactly one key per provider per app type. Render it as **Current · In effect**
  (当前密钥·生效中).
- The enable/disable Switch controls candidate-pool membership ONLY. It
  MUST sit alongside a visible "Candidate" (候选) text label so users never
  misread it as an in-effect toggle. The active key's Switch uses `readOnly`
  (not `disabled`) to preserve the checked visual; `disabled` on Mantine
  Switch greys the track even when `checked=true`, accidentally conveying
  "stopped."
- The reveal action uses the `KeyRound` icon (not `Eye`) because `Eye` reads
  as a visibility/on-off toggle — a false affordance adjacent to the Switch.
- The **Activate** button is the primary action on a non-active key row. It
  uses a filled `color="cliPrimary"` button with a `Zap` icon, visually
  dominant over the candidate-pool Switch. For the current provider
  (`isCurrent`), activation silently applies the global configuration
  (no confirmation modal); failure toasts an error without rolling back the
  activation that the backend already committed.
- A key that is `!enabled && !isActive` is **Archived** (已封存). Its row
  should be visually de-emphasized and the Activate button disabled.

## Manual hot-switch queue presentation (2026-08-09)

- When automatic failover is disabled, present the queue as a single-selection
  control. Selecting a ready provider calls `routing_set_failover_queue` with
  one provider ID and uses the backend result to update the In use indicator.
- Hide priority badges and every reorder affordance in manual mode; automatic
  mode keeps queue switches, priority arrows, and dnd-kit drag handles.
- `routing_get_failover_queue` polling treats `providers` as server-owned state:
  both Settings and the terminal quick panel accept the latest provider array so
  `sortIndex` and queue membership synchronize across surfaces. Settings merges
  `providers`, `circuit`, and `circuits` into the previous snapshot while
  preserving its local `config` draft; the quick panel may replace the complete
  failover snapshot because it has no editable parameter draft.
- Bad: merge only `circuit` / `circuits`; a reorder from the other surface then
  remains stale indefinitely. Good: preserve only locally editable config while
  accepting the server's ordered provider array.

## Terminal provider quick-switch panel (2026-08-10)

- The terminal action rail exposes a right-side `providers` panel in both
  merged and independent-panel layouts. It reuses the native provider
  catalog/current/global preview commands; provider maintenance remains in
  Settings via the panel footer.
- The panel renders the shared `TerminalPanelHeader` above the CLI-type
  selector, using the Providers title, `ArrowLeftRight` icon, and provider
  accent. Do not replace it with a provider-specific title row or treat the
  outer merged-tab strip as a substitute for the content header.
- The panel resolves its app type from the active terminal session/project
  (`claude`, `codex`, or `grokbuild`) and provides keyboard-roving tabs. It
  polls `routing_get_failover_queue` only while open and preserves the last
  successful snapshot when auxiliary routing reads fail.
- Treat the daemon listener and the current CLI Home takeover as distinct
  states. The local-routing switch and the panel's user-facing routing status
  represent the current Home takeover; report routing as running only when
  that takeover exists and the daemon service is running. Runtime capability
  gates may continue to use daemon service/connection state directly, because
  disabling one Home takeover intentionally leaves the shared daemon running.
- Automatic failover renders queue membership and priority arrows; manual
  failover renders a single-select queue and sends exactly one provider ID to
  `routing_set_failover_queue`, allowing an active local takeover to hot-switch
  without a global confirmation dialog. While automatic failover is enabled,
  provider-row activation is non-switching: queue membership and priority
  controls are the only provider-selection path, and row activation must never
  enter global preview/confirm/apply. Outside automatic mode, global switches
  still require the existing preview/confirm/apply flow.
- In automatic mode, provider rows in both the quick panel and Settings expose
  the same dnd-kit drag-and-drop reorder affordance. Drop order is submitted as
  the complete app-type provider ID list through `provider_catalog_reorder`;
  the existing arrow controls remain available for keyboard and precision
  adjustments. Both surfaces derive the same display order: queued providers
  first, ordered by `sortIndex`, followed by non-queued providers ordered by
  `sortIndex`. Manual mode renders the ungrouped catalog order. This grouping is
  display-only and must not become a second persisted failover-order array.
- The quick panel is a vertical sortable surface. `SortableProviderRow` must
  apply the dnd-kit transform with `x: 0` while preserving `y`, scale, and the
  shared sortable transition. Pointer drift must not expand the panel's
  vertical scroll container into a horizontal scrolling range. Do not treat
  `overflow-x: hidden` as the primary fix because that leaves the card moving
  off-axis and only masks the resulting scrollbar.
- The Settings Catalog surface is also a failover consumer while automatic
  failover is enabled. It polls `routing_get_failover_queue`, renders queued
  providers first with `#N`, and exposes queue toggle plus priority up/down
  actions on each catalog card. When automatic failover is disabled, those
  queue affordances disappear and the catalog returns to its normal presentation.
- Settings and the terminal quick panel are independent Hook instances. Every
  successful failover read or mutation publishes the returned
  `NativeProviderFailoverState` through the module-local failover sync channel;
  subscribers immediately apply it, and newly mounted subscribers replay the
  latest successful snapshot. Polling remains the authoritative backend
  reconciliation path rather than the only cross-surface synchronization path.

## Failover ordering persistence (2026-08-13)

- `routing_get_failover_queue` is the authoritative complete snapshot for a
  CLI app type: consumers must apply its `providers` collection, including
  `inFailoverQueue` and `sortIndex`, after successful mutations and polling.
- `provider_catalog_reorder` persists the complete provider ID list through
  `providers.sort_index`; do not introduce a second frontend-only failover
  ordering array. Queue grouping is display derivation only.
- The terminal quick panel hides duplicate per-row up/down buttons while
  automatic failover is enabled. It keeps the dnd-kit drag handle and keyboard
  sensor as the precision reorder affordance. Settings may retain dedicated
  up/down controls.
- Disabling automatic failover changes the mode only. It must not rewrite an
  existing non-empty queue or directory order; enabling failover may seed an
  empty queue with the current ready provider.

### Good / Bad

```typescript
// Good: apply the returned snapshot after a successful reorder or poll.
setSnapshot((current) => ({ ...current, failover: next }));

// Bad: keep only circuit fields and retain stale providers after another
// surface has changed sortIndex or queue membership.
setSnapshot((current) => ({
  ...current,
  failover: current.failover && { ...current.failover, circuit: next.circuit },
}));
```

### Required regression checks

- Side panel automatic mode has no up/down buttons, while drag/keyboard
  ordering remains available.
- Pointer dragging a quick-panel provider sideways keeps the card on the
  vertical axis and does not create a bottom scrollbar; vertical auto-scroll
  and keyboard ordering remain available in merged and independent panels.
- A queue/order mutation made in either side panel or Settings is visible in
  the other consumer after the next snapshot publication or poll.
- Toggling automatic failover off and on preserves an existing queue and its
  `sortIndex` order; empty queue seeding remains covered separately.
