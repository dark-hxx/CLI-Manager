# Extensions management contracts

## 1. Scope / Trigger

Global MCP/Skills read, edit, native apply and inventory changes across React, Tauri IPC, SQLite and CLI files. Saving a canonical resource, writing a native configuration, and a running session loading it are separate states.

## 2. Signatures

- `extensions_mcp_native_status(cli) -> { homeIdentity, enabledKeys }`: read actual native entries and explicit disable flags without generating a projection or exposing secret values.
- `extensions_mcp_set_selection(items: { resourceId, enabledByCli }[], homeIdentity) -> McpResourceRedacted[]`: atomically seed displayed boolean selections before explicit toggle/edit/delete/import; reject unknown CLI keys and changed Home, preserve full stored secrets, roll back the entire batch on any failure.
- `extensions_mcp_native_preview(cli) -> { cli, format: "json" | "toml", path, fingerprint, existingKeys, enabledKeys, removedKeys, changed, content: string }`: `content` is the formatted, redacted final merged configuration, never the secret-bearing apply bytes.
- `extensions_mcp_native_apply(cli, fingerprint) -> { path, backupPath, changed }`.
- `extensions_skills_inventory() -> { entries, warnings }`; entry fields: `cli`, `name`, `path`, `sourceKind`, `status`, `linkTarget`, `importPath`, `managed`.
- `extensions_project_policy_save(request.policies)` updates only supplied `(cli, kind)` pairs. Omission preserves rows; explicit `mode: inherit` deletes that pair's override. The dialog sends only its project-configured CLI, resolved with the same provider resolver as launch; unsupported CLI has no editable fallback.
- The three extension repositories call `database::ensure_schema` before queries. It reuses migrations 38–40 and SQLx checksums; it must not fabricate empty results for failed SQL.

## 3. Contracts

- Backend derives targets from provider active Home. Renderer cannot supply arbitrary native write paths or full secret-bearing projection output.
- Claude personal MCP belongs in Home `.claude.json`; Codex/Grok use the corresponding `config.toml`.
- Codex project launch overrides must describe each managed server with its valid transport fields (`command` plus `args` for stdio, or `url` for Streamable HTTP) and its explicit `enabled` state. Never emit an enable-only table or generic `type`/`transport`; unselected SSE entries are omitted and selected SSE entries fall back with an unsupported-transport error.
- When a project-scoped Codex provider and project MCP/Skill policy are both active on a local direct Codex launch, create one CLI-Manager-owned profile under the resolved Codex config root. The profile combines the provider snapshot's non-secret overrides and the project extension overrides, and the command uses one `--profile` argument while retaining provider environment injection. WSL, non-direct commands, or profile creation failures fall back to the validated merged `-c` overrides. Claude provider settings and Skill overrides share one generated `--settings` file; Claude MCP remains a separate `--mcp-config` input because it is a distinct native CLI contract.
- `is_reserved_native_field(cli, field)` is target-specific and shared by projection validation and both native serializers. Claude-imported `startup_timeout_sec`, `tool_timeout_sec`, `http_headers`, `bearer_token_env_var` remain unknown Claude-only metadata, not canonical timeout/header support. Preserve them on Claude round-trip, do not forward them to Codex/Grok, and still reject true canonical overrides such as `command` (and Claude `timeout`). Do not use a union of all vendors' reserved keys to reject a field the source parser preserved.
- Preview fingerprints include Home/path identity, original bytes, ownership ledger and full canonical resource state. Apply recomputes them under the provider application lock.
- Only canonical/previously managed keys are replaced or removed; unmanaged MCP entries and unrelated configuration are preserved. The final ledger retains enabled keys; removed keys are relinquished.
- Native write uses private same-directory stage/backup, stale-file check, atomic replacement and readback. WSL operations run inside the selected distro. Backups are retained for recovery; running CLI sessions are not restarted.
- `editing::preserve_secrets` restores unchanged masked leaves from the full record under the repository transaction. Explicit new values and removed fields remain edits.
- Inventory uses diagnostic user roots, bounds traversal, reports partial scans, classifies external/plugin/builtin/managed, and does not recurse through directory links. Discovery is not session activation evidence. External sources must be imported before managed lifecycle operations.
- Inventory traversal includes the root in a 10,000-path budget and keeps depth 8 / 500-entry limits. Classify ordinary files before the depth cutoff; directory depth truncation preserves bounded siblings. Check hard limits before opening a directory and before every iterator advance, conservatively marking the scan incomplete at the exact limit without peeking at another item. Native `ReadDir` and WSL context-managed `scandir` stay lazy; never collect/sort a whole directory before checking the budget. WSL reuses `DirEntry` type information for ordinary files; only final aggregated inventory is presentation-sorted.
- Paths removed or changed from directory to file after enumeration are stale candidates (`NotFound`/`NotADirectory`, `FileNotFoundError`/`NotADirectoryError`): skip them and preserve other entries. Permission and other I/O failures remain errors. The WSL private `{ entries, limited }` envelope and public `extensions_skills_inventory() -> { entries, warnings }` stay unchanged; retain the 15-second / 1-MiB subprocess bounds and close directory iterators on every exit.
- Before descending into a cached WSL directory candidate, refresh its `lstat` type so a replacement symlink is inspected as a link instead of recursively traversed. Keep ordinary-file classification on the cached `DirEntry` path; do not restore per-file lexists/isdir/islink probes.
- Global loading keeps successful request results even when another request fails. Skills import defaults to `skillDirectory`.
- Skills main list must not mount/unmount a top-level partial-scan warning on every refresh. Keep per-CLI completeness and protected target inspection; detailed inventory warnings remain in the opt-in inventory panel. Removing a notice must not manufacture complete scan state.
- Import suggestions reuse saved per-CLI Hook roots and provider Home without changing either. Suggestions are unverified read-only source paths until import preview succeeds; custom/manual selections must not be overwritten by asynchronous Home resolution. Import source is not the native apply target.
- Inventory cards must retain natural height: bound scrolling on an outer block, not the flex Stack containing shrinkable Cards. Verify many entries and long paths manually; a DOM/source check alone is not visual acceptance.
- Project MCP/Skills policy dialogs must be bounded by the viewport with a flex-constrained body; the outer dialog does not scroll by default, while the resource list and preview pane own their necessary overflow so the footer remains visible.
- Project bulk selection operates on visible filtered rows and starts from the effective set, including inherited Worktree selections. It switches only the current CLI/kind draft to custom, preserves hidden IDs and already-selected same-name Skill variants, and adds at most one variant for an unselected group. Deselect removes all IDs for visible groups. Disable bulk actions during loading/saving or unsupported/global-only capability. Persist only through the existing Save action.
- Extension tabs occupy the settings header search-replacement slot, outside the content scroller. Do not reintroduce sticky tabs inside the resource list or hidden search filtering. MCP imports use the single list-toolbar dialog.
- Native preview is a read-only, on-demand dialog. The Save MCP configuration action owns writes; opening preview or saving a canonical record never writes native files.
- Native preview opens with the first available CLI and reloads on in-dialog CLI selection. Request generations prevent stale success/error/finally callbacks from replacing the current result or publishing after unmount. JSON/TOML format comes from Rust; `adapters::redact_projected_content` redacts the full merged document, including unmanaged MCP credentials and sensitive root fields, before serialization. `Plan.desired` and the fingerprint retain their original write semantics. Unsupported projections remain errors; the UI localizes known field-level codes and never renders raw IPC error text.
- Successful canonical create/edit/delete/import and CLI toggles advance per-CLI pending versions. Native save acknowledges the captured version only for the exact Home/CLI after fingerprint-protected backend success. Partial success leaves failed targets pending; editing/saving share an in-process operation guard.
- Settings close, navigation away from extensions and MCP/Skills switching share a three-way guard: apply-and-continue (only on full success), leave without applying (cancel the current Home's pending application batch, retain definitions), or stay. In-flight operations prevent navigation. The first navigation intent owns the confirmation; outside clicks cannot dismiss it. Settings backdrop clicks must check `event.target === event.currentTarget` so portal events are not navigation.
- `discardMcpChanges(home)` snapshots current revisions into a separate session-only `discarded[home]` map, returning false during edit/save. Never rewind global revisions or fabricate `applied` acknowledgements. `pendingMcpClis(revisions, applied, discarded)` compares each revision with the maximum of that Home/CLI's applied and discarded versions, consistently for rendering, navigation and saving. A later mutation prompts again; other Homes remain independent. Cancellation does not roll back definitions already saved by the editor or native writes already completed in a partial save. With pending cleared, the list returns to the actual native enabled state.
- Reopening/restarting reads native status but MUST NOT manufacture pending revisions from file differences or errors. Only explicit user mutations create pending UI state. Confirm Home identity around reads/previews and rely on the backend fingerprint again at write time. Restarted sessions display native state, not imported switch defaults.
- Before explicit CLI toggle, seed that CLI's desired selection from the displayed native baseline; edit/delete/import seed all verified CLI baselines. The backend owns a short immediate transaction and returns only redacted resources: unknown/missing records or changed Home roll back all selections. No native write occurs until explicit Save. Enabled managed services override their imported disabled flags and are removed from native disable lists; unrelated services remain untouched.
- The editor accepts exactly one `mcpServers` entry, retaining resource identity, source, revision metadata and other-CLI extension fields internally. Reject invalid/multiple entries without silently dropping any; keep its footer outside the scroll area. Do not reintroduce the basic form, capability matrix or projection-preview UI.
- The MCP Monaco editor owns one draft/resource snapshot per open resource identity. Use `defaultValue`, stable options/onChange, existing JSON worker and locale setup; background list refresh must not replace the model or snapshot. JSON markers supplement, but never replace, the existing parser and Rust semantic validation.
- Global MCP/Skill rows and project selections share the feature-local, presentation-only `ExtensionCompactRow`. Skill source variants, installation records and advanced operations expand inline; shared/blocked status notes remain visible without expanding. Detail selection does not alter installation ownership or pending MCP state.
- GitHub installation uses a bounded Modal with a scrolling body and fixed footer. Source inputs precede scanning; after scanning the candidate selection and deployment settings take priority. Cancel acknowledgement has its own `cancelling` state: it cannot clear the original scan/install `busy` flag. Controls and close remain locked until both requests settle. Partial deployment failure must not have an all-success result heading.
- Skills presentation distinguishes per-CLI installation from compatible discovery: owned active records or external native/plugin entries color that CLI icon. `agent-compatible` inventory is a direct Codex target (`.agents/skills`), but shared-only for Claude/Grok; `claude-compatible` discovery is shared-only. Shared-only discoveries have a separate note, not independent installed icons. Same-name presence never proves content identity/ownership. Unknown/protected icons open target-pinned inspection; no shortcut removal or automatic external adoption. Installation still checks the real target in Rust.
- Global Skill rows group exact names while preserving all package IDs, hashes and installation IDs. Different hashes remain selectable source variants; never delete/merge database records by name. A selected source changes installation input, not ownership of other variants.
- Skill uninstall from CLI icons or installation details calls the same guarded uninstall callback directly, without a confirmation dialog. Preserve the operation lock, owned/externalModified checks and backend `removed` result check; a refused removal is not success. Project resource names and descriptions each use a native label for the same checkbox: do not add bubbling row click handlers that toggle twice or bypass disabled state.
- Claude project snapshots reject duplicate Skill names only among selected IDs, not among unrelated imported packages. Selecting either variant produces one `on` override; unselected duplicates produce one `off` entry. Multiple selected same-name variants remain an explicit conflict, not arbitrary last-wins.
- Codex project Skill selection must materialize selected managed packages under the target project's `.agents/skills` discovery root before generating `skills.config`; an arbitrary app-data package path is not discoverable and a name rule alone cannot load it. A custom project profile disables bundled Skills, disables discovered user/project Skill paths, and enables the selected project target path last. Temporary targets are recorded with content hashes and snapshot references; release removes only the last managed, unchanged target and preserves conflicts. Failed preparation may remove only targets created by that preparation.
- Project snapshots are needed for applied non-global policy origins, including Worktree inheritance of an empty custom set. Global inheritance preserves actual CLI files rather than projecting a partial managed registry. Inherited project MCP selections override global disabled flags just like direct custom selections.
- Windows symlink failures carry numeric OS codes before localized diagnostic text. Auto fallback recognizes permission/unsupported codes, not arbitrary failures; explicit symlink still errors. Preserve target conflicts and external modifications.
- List order is presentation-only: `extension-list-order.json` under the resolved application data root, keys `mcp`/`skills`, values ordered stable ID arrays. DnD activates only from handles inside the item card beside its name, with keyboard support; failed persistence reports failure and restores the visible prior order. It never changes MCP pending state.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Old database has no extension tables | Apply existing domain migrations before querying |
| Migration checksum changed | `extensions_schema_initialization_failed`, no empty-success fallback |
| Home, resource or target changed after preview | `extensions_native_preview_changed`; preview again |
| Unsupported target projection | `extensions_projection_unsupported`; no native write |
| Native preview contains root or unmanaged MCP credentials | Redact before returning `content`; retain full private apply bytes |
| Older CLI preview completes after switching tabs or closing | Discard its success/error/completion state updates |
| GitHub cancel acknowledgement precedes original completion | Keep operation lock; only the original operation releases `busy` |
| Claude unknown key happens to be a Codex reserved field | Preserve under Claude only; do not report a canonical collision |
| Unresolved secret reference | `extensions_secret_reference_unresolved`; no placeholder written |
| File differs during final write check | Preserve live file and backup; discard own stage |
| Empty projected TOML MCP set | Missing `mcp_servers` is valid; never index it blindly |
| Unreadable/incomplete inventory root | Preserve collected entries and add warning |
| Enumerated path disappears or an ancestor becomes a file | Skip the stale candidate and continue bounded siblings; do not fail the WSL subprocess |
| Inventory reaches an exact path/entry limit | Keep allowed results, report incomplete, and do not open/advance another directory iterator |
| Native differences with no explicit user action | No unsaved-change dialog |
| Leave without applying, then navigate/reopen with no further edit | No repeated prompt for the discarded Home/batch; no native write |
| New edit after discarding, or navigation for another Home | Compare against that Home's own applied/discarded versions |
| External same-name Skill | Colored protected presence, no ownership/deletion inferred |
| Shared-only compatible Skill discovery | Separate visibility note, no independent installed icon |
| Unknown/protected Skill icon clicked | Open inspection with that CLI pinned, preserve external target |
| Unselected duplicate Skill name in project registry | Do not fail snapshot generation |
| Two selected Skill IDs have the same name | `extensions_project_skill_name_conflict` |
| Codex project MCP has no valid command/url transport | `extensions_project_codex_mcp_definition_invalid`; do not emit an enable-only table |
| Codex project selects SSE MCP | `extensions_project_codex_transport_unsupported`; preserve global state for that MCP policy |
| Codex provider and project extensions are both scoped | Local direct launches use one generated combined profile; WSL/non-direct/profile-write fallback uses merged `-c` overrides |
| Project policy save omits another CLI | Preserve its configuration and revision |
| Windows symlink error 1314 in auto mode | Copy package; do not depend on English OS text |

## 5. Good/Base/Bad Cases

- Good: edit a masked resource's name without changing its token; only the name changes.
- Base: preview one CLI, confirm, verify its file, then report that new sessions use the result.
- Bad: report the global switch as applied merely because SQLite changed.
- Bad: use an unrelated checkout's running binary or mocked browser IPC as desktop acceptance evidence.
- Good: preview Codex shows redacted TOML and leaves desired native bytes intact; switching back to Claude cannot show an old Codex response.
- Bad: release the install lock when the cancellation request returns, allowing a new scan while the old install is still completing.

## 6. Tests Required

- Old database upgrade, repeated/concurrent reads, checksum drift and existing-data preservation.
- JSON/TOML preserve unmanaged entries and auth/model settings, and remove managed entries including the last table.
- Import-to-project-projection regression with Claude `startup_timeout_sec`; same-CLI round-trip and cross-CLI non-propagation. Canonical `command` conflict remains rejected for every CLI. Opt-in `saved_project_mcp_projection_read_only` uses `EXTENSION_AUDIT_DB` and `EXTENSION_AUDIT_PROJECT` to read existing selections/definitions via read-only SQLx without migrations, native writes, CLI launches or secret output.
- Codex project launch regression covers stdio and Streamable HTTP transport fields, explicit disabled entries, unresolved secret references, selected SSE rejection, valid combined profile content/cleanup, discovered Skill path filtering/materialization, and the merged provider/project `-c` fallback.
- Real temporary file publication verifies backup contents, final bytes and conflict protection.
- Masked edit preserves old token; explicit replacement/removal changes it.
- Inventory covers native, nested plugin/builtin and linked/missing sources.
- `extensionsInventory.test.mjs` executes the real WSL script with observable filesystem iterators: 10,000 ordinary files permit 9,999 advances after the root, no full `listdir`, no repeated path-type probes, and balanced iterator closes. Cover exhausted child-directory opening, 500-entry early exit, deletion/replacement between enumeration and processing, and genuine permission errors. Native inventory tests cover stale candidates, retained siblings and the final allowed Skill at an exact budget. Record wide-directory benchmark environment separately from real WSL transport acceptance.
- Common JSON sample, hidden-metadata/secret-mask round trip, malformed/multi-server rejection, fixed footer and removed UI controls.
- Native preview serialization test covers all three CLIs, formatted JSON/TOML, unmanaged entries, root/managed/unmanaged credentials and unchanged full apply bytes. `scripts/extensionsManagementUi.test.mjs` executes real preview/cancel closures with deferred IPC to cover stale responses, invalidated generations and cancellation success/failure without premature unlock; it is not desktop acceptance.
- No-mutation navigation, native disable flags, per-CLI scan completeness, external presence/protection, handle-only ordering and actual temporary auto deployment.
- `extensionsMcpSaving.test.mjs`: discard preserves monotonic revisions and real apply acknowledgements, isolates Homes, survives view re-entry, re-arms on new edits, preserves edits on Stay, respects operation locks, and does not retry discarded partial failures. Verify one continuation per confirmation, no outside dismissal, and a genuine settings-backdrop origin check.
- Group different-hash same-name packages without deleting IDs; Codex shared installation colors only Codex; pinned inspection target; unsupported project CLI has no Claude fallback. SQL in-memory regression preserves omitted CLI rows and deletes explicit inherit only. Snapshot regressions cover unselected duplicates, either selected variant, selected-name conflict, global inheritance and inherited empty project set.
- Opt-in installed-CLI smoke test reads generated files under a disposable Home. Desktop acceptance is human-performed on this checkout per frontend quality guidelines; do not launch the desktop app for automated UI verification. Record real IPC evidence separately from visual acceptance and Windows/macOS/WSL gaps explicitly.

## 7. Wrong vs Correct

Wrong: `setEnabled()` succeeds → show “CLI applied”.

Correct: save desired state → preview native target → confirm with fingerprint → private backup/replacement/readback → show “configuration written; new session required”.

Wrong: serialize `Plan.desired` into the preview response. Correct: serialize only `adapters::redact_projected_content(cli, desired_text)` as `content`; never reuse that redacted text for apply.

Wrong: `sorted(os.listdir(path))` followed by a path-limit check, or an uncaught missing-child error that discards all WSL results. Correct: budget-checked iterator advancement, cached entry classification and skipping stale candidates while preserving genuine access errors.
