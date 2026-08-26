# History Session Contracts

## Scenario: Conversation View and Structured Message Parts

### 1. Scope / Trigger

- Trigger: changing history message parsing, V2 catalog materialization, SSH detail payloads, favorite snapshots, session detail tabs, search jumps, or list-row open behavior.
- Goal: make the default conversation review readable without weakening the complete transcript/audit path.

### 2. Signatures

- Frontend message field: `HistoryMessage.parts?: HistoryMessagePart[]`.
- Part kinds: `text | tool_call | tool_result | reasoning | system | metadata | unknown`.
- Part fields: `kind`, `content`, optional `tool_name`, optional `call_id`.
- Local/WSL Rust payload: `HistoryMessage.parts` serialized as camel-case and omitted only when empty.
- SSH payload: `RemoteHistoryMessage.parts` defaults to an empty list during deserialization for protocol compatibility.
- V2 catalog: `history_message_parts(message_id, part_index, kind, text_content, tool_call_id, tool_name, ...)` preserves parsed parts beside `history_messages.display_content`.

### 3. Contracts

- Keep `HistoryMessage.content` and original message indices stable. Search, edit, conversion, snapshots, file-change/tool-event links, and the Transcript tab still use the flat message contract.
- The Conversation tab is the default. It displays only non-empty `text` parts from `user`/`assistant` messages as bubbles; system/developer injections, tool records, reasoning, metadata, and other roles are omitted from this view.
- The Transcript tab remains the complete audit path for omitted non-text parts. The Conversation view must not fabricate a placeholder or empty bubble when a message has no visible text.
- The Transcript tab remains independent and complete, including long-message folding and local message edit/delete/insert actions.
- Every visible Conversation row exposes the same message action toolbar as Transcript. Copy uses the original message's editable text when available (otherwise flat content); edit, insert, and delete are exposed only when the original message satisfies the existing local-editability predicate.
- When existing batch-selection mode is active, Conversation hides its single-message toolbar just as Transcript does; it must not create a competing mutation path.
- Conversation edit/insert must first pass the existing edit-warning gate. Only after approval may the view switch to Transcript, where the original message index opens the existing edit/insert form. A rejected gate keeps the Conversation view active. Delete remains on the existing confirmation/mutation path without a forced view switch.
- Search scans both flat `content` and part `content`. A hit in a collapsed part, or a jump from Timeline/Changes/Tools/Subtasks, switches to Conversation, opens the relevant detail section, and keeps the original message index as the coordinate.
- When `parts` is absent or empty, the frontend conservatively maps user/assistant to `text`, tool to `tool_result`, system/injected prompts to `system`, and other roles to `unknown`.
- Prompt injection detection must inspect the whole normalized content, not only its first line. Codex/agent user records can start with ordinary headings such as `SKILLS` and contain `<skills_instructions>`, `<permissions instructions>`, `<environment_context>`, `<collaboration_mode>`, `[workflow-state:...]`, or `### Available skills` later in the same block; these markers classify the part as `system`.
- Local, WSL, and SSH use the same kind names. SSH remains read-only and this view contract never routes remote messages into local mutation commands.
- V2 catalog writes every parsed part and rehydrates it in `part_index` order. Old catalog rows without part records fall back from role/content; parser version changes must invalidate/rebuild derived rows when classification changes.
- Outside batch selection, the complete session row is one keyboard-accessible open target. Tree toggles, selection checkboxes, delete, and other explicit actions stop propagation. The existing detail request sequence remains the last-request-wins boundary.
- Every virtualized Conversation row must expose the configured index attribute (`data-index`) on the same node passed to `measureElement`; otherwise expanded details keep the estimate height and overlap or leave blank gaps. Conversation rows reuse the Transcript avatar/stack/bubble layout so visible text and detail sections share the same geometry.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| New payload contains valid non-empty parts | Normalize and render exact kinds in source order |
| Unknown/empty/malformed part | Ignore malformed part; if no valid parts remain, use role fallback |
| Old favorite snapshot has no parts | Render through role fallback; never show an empty conversation |
| Old V2 catalog row has no `history_message_parts` | Rehydrate one fallback part from role/content |
| Search matches only hidden reasoning/tool/system text | Mark the original message index, expand the detail section, and center it |
| Rapidly click two session rows | Select/load the second target; the first response cannot replace it |
| Click tree toggle/delete/selection checkbox | Perform only that explicit action; do not open the session |
| Conversation action targets a non-editable, SSH, or snapshot message | Show copy only; never expose a local mutation action |
| Conversation edit/insert warning is rejected | Keep Conversation selected and do not create an edit/insert form |
| Conversation edit/insert warning is approved | Switch to Transcript and open the existing form at the original message index |

### 5. Good/Base/Bad Cases

- Good: one assistant record contains reasoning, visible text, and a tool call; Conversation shows the answer and one expandable details section while Transcript stays byte-for-byte compatible at the message level.
- Base: an old snapshot has only `role="user"` and `content`; Conversation displays it as ordinary text.
- Good: consecutive system/tool/reasoning records disappear from Conversation while the same records remain available in Transcript.
- Good: a visible local assistant row offers four actions; copy uses the original message content, while edit/insert switches to the existing Transcript form only after the warning is approved.
- Base: a visible SSH or favorite-snapshot row offers copy but no mutation action.
- Bad: derive Conversation only from role after structured parts exist, because mixed reasoning/tool content would remain merged into the visible answer.
- Bad: remove or filter messages in the backend, because message-index links from Diff/Tools would shift.
- Bad: classify only a user block whose first line says `Agents.md instructions for ...`; this leaks injected context that begins with a normal heading into the visible conversation.
- Bad: render every `user`/`assistant` record as visible text without checking its parts; embedded system/developer context then appears as a user prompt.
- Bad: measure a virtualized Conversation row without its `data-index`, or render detail-only rows outside the avatar/stack wrapper; expansion then produces stale heights or a layout unlike the Transcript tab.
- Bad: render a second editing form in Conversation, which duplicates the established Transcript mutation path and risks index/form behavior drift.

### 6. Tests Required

- Rust parser tests: Claude/Codex mixed blocks classify text, tool call/result, reasoning, and injected system content while preserving flat content.
- Rust parser tests: embedded Codex context markers and `developer` response messages classify as `system` for both local and SSH parsers.
- SSH history-core tests: exact kind parity and missing-parts deserialization compatibility.
- V2 catalog test: write/read `history_message_parts` in order and fall back for rows without parts.
- Frontend regression: default Conversation plus independent Transcript, adjacent-detail grouping, old snapshot fallback, hidden search/jump expansion, whole-row click, and action propagation; verify the shared toolbar exposes copy for every visible row, limits mutations to local editable rows, and switches to the original-index Transcript form only after gate approval.
- Run `npx tsc --noEmit`, focused Node history tests, `cargo test history --lib`, `cargo fmt -- --check`, and `cargo check`.
- Manual desktop verification: Local/WSL/SSH, main checkout/Worktree, parent/subagent tree, batch selection, rapid row switching, keyboard opening, and `zh-CN`/`zh-TW`/`en-US` copy with 24-hour time.

### 7. Wrong vs Correct

#### Wrong

```typescript
// Hides tool/reasoning by deleting messages and shifts every message-index link.
const conversation = messages.filter((message) => message.role !== "tool");
```

#### Correct

```typescript
// Preserve message coordinates; classify parts only in the render projection.
const rows = buildConversationRows(messages);
const targetRow = rows.find((row) => row.messageIndices.includes(messageIndex));
```

#### Correct conversation-action transition

```typescript
const started = await startEditMessage(row.messageIndex, row.message);
if (started) {
  onDetailViewChange("transcript");
}
```

## Scenario: Two-stage local smart history titles

### 1. Scope / Trigger

- Trigger: changing history session display titles, aliases, generated-title actions, history settings, search-hit labels, prompt-library labels, or automatic title scheduling.
- Goal: keep the parser source title immediately available while layering an optional local generated title without mutating the source summary.

### 2. Signatures

- Renderer settings retain `HistorySmartTitleSettings`, extended with `customPrompt: string`; an empty string means the built-in system instruction.
- The IPC name remains `history_title_generate(request: HistoryTitleGenerateRequest)`, but its Rust entrypoint is `pub(crate) async fn history_title_generate(...)`. `HistoryTitleGenerateRequest` must not gain a prompt field.
- There is no SQLite migration or Provider protocol signature change. The Rust command reads `historySmartTitle.customPrompt` from local `settings.json` and calls the existing `post_text_request(..., system_prompt, candidate, ...)` adapter.

### 3. Contracts

- `displayTitle` precedence is exactly `alias.trim() > generatedTitle.trim() > source title.trim() > session id`.
- Generated-title metadata is hydrated from `history_generated_titles` together with session metadata and overlaid on local summaries, favorite snapshots, cached remote summaries, search hits, and prompt-library labels. `summary.title` remains the source title.
- Manual generation is allowed for old sessions and sessions with an alias. Alias remains the visible pin; a successful manual result is retained as the hidden fallback until the alias is cleared.
- SSH sessions dispatch only after an online trusted detail is loaded; read-only local snapshots, summary-only cache, and offline detail never dispatch. Candidate extraction requires the first visible user text part and shares the Conversation classifier; injected context, tools, reasoning, metadata, empty, and attachment-only records do not qualify.
- Automatic work is disabled by default, uses the persisted `enabledAt` watermark, is deduplicated by session key plus full candidate fingerprint, and is scheduled through one bounded FIFO queue. Disabling the setting cancels queued ownership and invalidates active automatic revisions.
- The list toolbar and Settings -> History Sessions switch read and write the same persisted `historySmartTitle` object. Re-enabling records a new watermark; it does not reuse the previous one.
- `historySmartTitle.customPrompt` is one global, local-only system instruction. The UI trims it before saving; missing, blank, NUL-containing, or over-4096-UTF-8-byte values normalize to `""`. The `historySmartTitle` sync classification remains `excluded`.
- Prompt Save waits for the existing persisted settings update before showing its localized success toast. While that write is pending, Save/Restore cannot race; a write failure shows a localized failure toast and never reports success.
- Rust snapshots settings at request start to validate the selected Provider/automatic state and select either the normalized custom prompt or the unchanged built-in fallback. The candidate remains a separate user/input field for Anthropic, Chat Completions, and Responses; it is never interpolated into the prompt. The completion guard takes a fresh snapshot only to preserve the existing provider-selection/automatic-disable result suppression.
- `history_title_generate` must remain a Tauri async command and await a dedicated `spawn_blocking` worker for the existing non-`Send` title helper; do not wrap the Provider request in `tauri::async_runtime::block_on` inside a synchronous command. A slow Provider request must leave the renderer able to process normal interaction while the existing pending/duplicate guard remains authoritative.
- `historyStore` records an in-memory `smartTitleInFlightSessionKeys` entry immediately after it accepts a manual or automatic generation request, before opening details, candidate extraction, or the Provider IPC wait. It removes that entry only when the same trigger still owns the session in `finally`, so a manual request replacing an automatic request cannot clear the newer loading state. This ephemeral set never changes persisted generated-title metadata or optimistically supplies a title.
- Installed production and `npm run tauri dev` deliberately share the main SQLite database. Generated-title reserve and finish transactions must acquire the write lock with `BEGIN IMMEDIATE` before their read/write sequence and use the shared 15-second write-busy timeout. A remaining SQLite busy/locked result maps to the stable `history_title_database_busy` category, never to a Provider/network category.
- All generated-title actions use `useI18n()` keys for `zh-CN`/`en-US`; existing `zh-TW` fallback remains valid. List and detail pending state combines persisted `generatedTitle.state === "pending"` with the in-flight set. The detail action shows the existing localized pending label with a loading icon, sets `aria-busy`, and disables repeat generation (and title clearing) without changing selection, filtering, or scroll position.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| No generated row or generated request fails | Show alias/source/session-id fallback immediately; automatic failures are silent |
| Manual title action has no/invalid Provider or model | Preserve the source fallback, show a localized actionable reason, and open Session History settings; never expose raw provider errors |
| Manual title request fails after dispatch | Map the stable backend failure category to a localized safe toast; do not discard the error category or expose response/config content |
| Shared SQLite is busy while production and development builds both run | Wait at the title persistence boundary; if the bounded wait is exhausted, retain source/alias fallback and show a localized local-database-busy toast rather than Provider/network guidance |
| Alias saved while a request is pending | Cancel/invalidate ownership; late result cannot become visible or overwrite the alias |
| Generated title cleared | Remove visible generated text, preserve source title, and suppress automatic work for the current fingerprint until explicit manual generation |
| Search or Prompt Library contains a titled session | Use the same display precedence as the list/detail view |
| Provider/model selection is invalid | Keep the saved selection diagnosable, prevent enabling when off, and allow disabling when already on |
| `customPrompt` is missing, blank, manually malformed, contains NUL, or exceeds 4096 UTF-8 bytes | Save/use `""` and fall back to the built-in instruction; never send the malformed value |
| Prompt draft is malformed in Settings | Keep it unsaved, show a localized field error, and leave the last persisted effective prompt intact |
| Prompt Save succeeds or fails | Show success only after the setting write fulfills; while it is pending disable repeat actions; on failure leave the persisted prompt unchanged and do not show success |
| Prompt changes while a request is in flight | The sent request uses its start snapshot; the existing completion guard may still suppress the result if provider selection/automatic state changed |
| Provider request takes several seconds | Keep normal desktop interaction responsive; immediately show the localized loading state in the detail button and matching list row, then clear it when the active request settles; duplicate generation stays blocked |
| Locale changes | New title/settings copy changes language without changing time formatting |

### 5. Good / Base / Bad Cases

- Good: a saved 4096-byte-or-smaller custom prompt becomes the Provider system/instructions field while the first valid user message remains the separate candidate input.
- Good: installed production and development builds both write the shared SQLite database; a short competing write clears within the 15-second bound and the title reservation/result persists without a second Provider request.
- Base: an old settings file without `customPrompt`, or the user restoring default, produces the exact built-in behavior.
- Bad: passing the prompt through `HistoryTitleGenerateRequest`, synchronizing it, or concatenating it with candidate text breaks renderer trust boundaries and protocol framing.
- Bad: starting a deferred read transaction and then upgrading it to a write while another process writes; this can return SQLite busy/snapshot errors and must not be reported as a Provider, model, or network misconfiguration.

### 6. Tests Required

- Frontend type-check after store/component changes.
- Rust unit tests for trim, blank, NUL, over-limit, custom selection, and built-in fallback; no real Provider call is required.
- Source-contract test verifies the unchanged IPC request shape, settings migration/default, prompt editor controls, and backend-owned system prompt selection.
- Source-contract test verifies the Tauri title-generation entrypoint is async and dispatches its non-`Send` helper with `spawn_blocking`; it also verifies Prompt success feedback follows the awaited settings write and an accepted title request creates/removes its local in-flight loading state.
- Rust/source coverage verifies SQLite busy-code recognition, the 15-second bounded title-write wait, `BEGIN IMMEDIATE` write reservation, and the localized busy mapping.
- Pure candidate/display tests for alias/generated/source/id precedence, Unicode-safe input truncation, injection markers, attachment-only records, old flat messages, and distinct source instances.
- Manual desktop check for save/restore, settings/toolbar synchronization, old-session manual generation, alias pin, clear suppression, automatic watermark, pending/restart behavior, and Chinese/English copy.

### 7. Wrong vs Correct

#### Wrong

```ts
invoke("history_title_generate", { request: { ...request, customPrompt } });
```

#### Correct

```rust
let selection = settings_selection();
let prompt = effective_prompt(selection.as_ref());
request_title(&runtime, prompt, request.candidate_text.trim()).await;
```

#### Wrong shared-database persistence

```rust
let mut transaction = connection.begin().await?;
let row = read_title_row(&mut transaction).await?;
write_title_row(&mut transaction, row).await?;
```

#### Correct shared-database persistence

```rust
let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
let row = read_title_row(&mut transaction).await?;
write_title_row(&mut transaction, row).await?;
```

#### Wrong long-running command wrapper

```rust
#[tauri::command]
pub(crate) fn history_title_generate(request: HistoryTitleGenerateRequest) -> Result<HistoryGeneratedTitleMeta, String> {
    tauri::async_runtime::block_on(history_title_generate_async(request))
}
```

#### Correct long-running command wrapper

```rust
#[tauri::command]
pub(crate) async fn history_title_generate(
    request: HistoryTitleGenerateRequest,
) -> Result<HistoryGeneratedTitleMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(history_title_generate_async(request))
    })
    .await
    .map_err(|error| format!("history_title_task_failed: {error}"))?
}
```

## Scenario: SSH Remote History Workspace

### 1. Scope / Trigger

- Trigger: opening History for an SSH project, changing remote pagination/search/detail behavior, or changing offline cache state.

### 2. Contracts

- SSH projects reuse the existing history workspace and source IDs (`claude` / `codex`); they do not introduce `ssh-claude` or `ssh-codex`.
- The project supplies one Host/source/config-root/project-path context. Lists use cached catalog summaries first, then the Agent bridge; the first fetch requests 21 rows and displays 20.
- A non-empty cached page renders immediately and starts one background forced refresh. A known remote identity with no cached rows still awaits a non-forced Agent page, so an already-published Agent index can answer without a scan. Manual refresh is forced; load-more is non-forced.
- If the first non-forced Agent page still leaves an SSH project with no visible cached rows, the workspace may run one forced remote refresh to recover from a stale empty published index. This fallback is scoped to the active remote context and must not loop indefinitely.
- Identical result-affecting sync inputs share one Promise even across different UI consumers. The RPC uses a request-owned bridge consumer rather than the first window's consumer, and releases it after settlement.
- Load-more consumes cached rows first and only then advances the Agent `generation:offset` cursor. A generation change reloads from the first page instead of appending incompatible offsets.
- Remote search requires the existing three-character minimum. Online search uses the Agent index; failure falls back only to cached summary matching and marks freshness stale/error.
- Full messages, tool calls, sub-Agent records, and Diff are fetched on demand and retained only in the backend LRU. Offline detail is unavailable unless a separate explicit favorite snapshot exists.
- Remote sessions are read-only: edit/delete are rejected, and remote paths never route to local file/Git/provider commands.
- SSH remote lists must not merge local `session_favorite_snapshots` as missing-session fallbacks. Remote rows may apply ordinary `session_meta` display state, but the row set must come only from the remote source instance and remote project scope.
- Local favorite metadata keys may differ by Windows path normalization such as `C:\...` vs `\\?\C:\...`; unfavoriting a local session must clear snapshots and starred state by source + session id, not only by the visible session key.
- Resume first checks current SSH tabs by Host/source-instance/session identity. Otherwise it runs Agent preflight, offers only same-Host/source/config-root SSH projects, or an explicit original-remote-location option when no project matches.
- The resume command is returned by Rust after validating structured Agent args; the WebView never interpolates a session ID into shell syntax. Project startup commands are replaced, normal project environment plus canonical `CLAUDE_CONFIG_DIR`/`CODEX_HOME` are retained, and provider overrides remain disabled.
- Open/list/load-more/search/detail requests are generation-guarded. Results from a previous SSH project, filter, query, or selected session must not overwrite the current consumer, and stale `finally` handlers must not clear current loading state.
- Opening a history workspace for an SSH project must resolve the maintained project to `remote_path` even when the caller supplies the desktop-local `project.path` or only a project id.
- The History workspace refresh button must not open the external local Claude/Codex project-sync dialog while `remoteContext` is active. For SSH projects it means "refresh remote history", not "find local syncable projects".

### 3. Tests Required

- Run `npx tsc --noEmit`.
- Manually switch rapidly between two SSH projects and between sessions while list/search/detail requests are in flight; only the latest context may render.
- Verify exact project resume, multiple same-Host project selection, original remote location, current-client Tab jump, active-elsewhere refusal, missing source/cwd, custom config root, and Hook-not-installed behavior.
- Disconnect after a successful sync and verify cached summaries remain visible with stale/offline state while uncached detail stays unavailable.

## Scenario: SSH History Capability Aligns With the Remote Bridge

### 1. Scope / Trigger

- Trigger: changing SSH project capabilities, supported remote history CLI sources, or a project/terminal history entry point.
- Goal: prevent an unsupported SSH CLI from reaching `buildSshAgentHistoryContext()` and exposing its internal `history_remote_source_required` guard to the user.

### 2. Signatures

- SSH source resolver: `resolveSshToolSource(command: string | null | undefined): SshToolSource | null`.
- Capability gate: `projectSupportsCapability(project, "history"): boolean`.
- UI reason helpers: `isSshHistorySourceUnsupported(project)` and `isSshGrokHistoryUnsupported(project)`.
- Defensive bridge guard: `buildSshAgentHistoryContext(project)`.

### 3. Contracts

- SSH `history` is available only when `resolveSshToolSource(project.cli_tool)` resolves to the currently bridge-supported Claude or Codex source.
- SSH Grok Build, another unsupported SSH CLI, and an SSH project without a configured CLI all have `history=false`; this does not alter `statistics` or unrelated project capabilities.
- Local and WSL Kimi Code keep native history (list/delete/resume/realtime stats under `$KIMI_CODE_HOME` / `~/.kimi-code`). SSH Kimi uses the generic unsupported SSH-history prompt.
- Local and WSL Grok Build keep their native history capability. Do not infer remote support from the local history-source registry.
- Sidebar and terminal-toolbar history entry points must stop at the capability gate. Grok uses the localized `remoteCapabilities.grokHistoryUnsupportedTitle`; another unsupported SSH CLI uses the generic SSH-history title and description.
- `history_remote_source_required` remains a defensive bridge error for non-UI callers. Normal UI interactions must not reach it.
- `HistoryWorkspace` must derive its selectable project list from `projectSupportsCapability(project, "history")`; do not add a second Grok-only filter.

### 4. Validation & Error Matrix

| Condition | Capability / UI result |
| --- | --- |
| SSH Claude or Codex command | `history=true`; existing remote bridge opens |
| SSH Grok Build command | `history=false`; show Grok localized unavailable toast; do not open the bridge |
| SSH unsupported or empty CLI command | `history=false`; show generic SSH CLI unavailable toast |
| Local or WSL Grok Build | `history=true`; retain existing native history flow |
| Direct invalid bridge caller | `history_remote_source_required` remains a defensive error |

### 5. Good / Base / Bad Cases

- Good: the sidebar and terminal toolbar both show the same Grok-specific toast and leave the current workspace unchanged.
- Base: an unsupported SSH OpenCode project receives the generic message instead of being mislabeled as Grok.
- Good: SSH Claude/Codex and local/WSL Grok continue to pass the same capability API.
- Bad: leave `SSH_CAPABILITIES.history=true` for every SSH project and catch `history_remote_source_required` separately in each caller.
- Bad: disable every Grok history flow, including local/WSL, because the SSH bridge has not implemented Grok.

### 6. Tests Required

- Run `node --test scripts/projectCapabilities.test.mjs` and assert SSH Claude/Codex allow history, SSH Grok/unsupported/empty CLI deny it, local/WSL Grok remain allowed, and SSH Grok statistics remain unchanged.
- Assert both project history entry components use the shared helper and i18n keys.
- Run `node --test scripts/sshRemoteFileContext.test.mjs`, `npx tsc --noEmit`, and `npm run build`.
- Manually verify both sidebar and terminal-toolbar entries in `zh-CN` and `en-US`; no raw internal error may be shown.

### 7. Wrong vs Correct

#### Wrong

```typescript
const SSH_CAPABILITIES = { history: true };
await buildSshAgentHistoryContext(project);
```

#### Correct

```typescript
if (capability === "history" && isSshHistorySourceUnsupported(project)) return false;
```

## Scenario: Favorite Session Snapshots

### 1. Scope / Trigger

- Trigger: changing history session favorites, session metadata storage, or behavior when original Claude/Codex history JSONL files are missing.

### 2. Signatures

- SQLite table: `session_meta`
  - `session_key TEXT PRIMARY KEY`
  - `starred INTEGER NOT NULL DEFAULT 0`
  - `alias TEXT NOT NULL DEFAULT ''`
  - `tags_json TEXT NOT NULL DEFAULT '[]'`
- SQLite table: `session_favorite_snapshots`
  - `session_key TEXT PRIMARY KEY`
  - `source TEXT NOT NULL`
  - `session_id TEXT NOT NULL`
  - `project_key TEXT NOT NULL`
  - `file_path TEXT NOT NULL`
  - `detail_json TEXT NOT NULL`
- Store action: `historyStore.updateMeta(sessionKey, { starred })`
- Backend detail command still remains the source-of-truth read path while the JSONL exists: `history_get_session`.

### 3. Contracts

- `session_meta.starred` is the favorite flag used for sorting and UI state.
- `session_favorite_snapshots.detail_json` stores a normalized `HistorySessionDetail` snapshot taken when the user favorites a session.
- Favoriting a session must save both the metadata flag and the snapshot.
- Unfavoriting a session must remove the snapshot.
- The history list should prefer live scanned JSONL sessions, then add favorite snapshots only for sessions missing from the scanned result.
- Opening a session should prefer `history_get_session`; if that fails and a favorite snapshot exists, the UI may show the snapshot as read-only historical content.

### 4. Validation & Error Matrix

- Source JSONL exists -> load via backend and ignore snapshot for freshness.
- Source JSONL missing + favorite snapshot exists -> show snapshot.
- Source JSONL missing + no snapshot -> keep existing backend error behavior.
- Snapshot JSON is malformed -> log a warning and do not show that snapshot.
- Project/source filter is active -> include only snapshots matching the same source and project filter.

### 5. Good/Base/Bad Cases

- Good: user favorites a session, deletes the original JSONL, reopens history, and can still open the saved transcript.
- Base: source JSONL still exists; live backend parsing is used and the snapshot is only a fallback.
- Bad: favorite stores only `session_meta.starred`, because deleted JSONL files make the favorite invisible.
- Bad: snapshot rows are shown without checking `session_meta.starred`, because canceled favorites would come back.

### 6. Tests Required

- Run `npx tsc --noEmit` after frontend store/type changes.
- Run `cd src-tauri && cargo check` after adding or changing migrations.
- Manual desktop check:
  - Favorite one Claude or Codex history session.
  - Confirm it remains listed after the original history JSONL is moved away.
  - Open it and verify the saved transcript appears.
  - Cancel favorite and verify the snapshot item disappears.

### 7. Wrong vs Correct

#### Wrong

```typescript
await db.execute("UPDATE session_meta SET starred = 1 WHERE session_key = $1", [sessionKey]);
```

#### Correct

```typescript
await updateMeta(sessionKey, { starred: true });
// updateMeta writes session_meta and session_favorite_snapshots together.
```

## Scenario: External History Project Sync Prompt

### 1. Scope / Trigger

- Trigger: changing how Claude/Codex history projects are detected, prompted, or materialized into the maintained project list.

### 2. Signatures

- Store action: `externalSessionSyncStore.openInitialDialog()`
- Store action: `externalSessionSyncStore.openManualDialog()`
- Store action: `externalSessionSyncStore.syncProjectCandidates(keys: string[])`
- History refresh caller: `HistoryWorkspace.handleRefreshSessions()`

### 3. Contracts

- Startup detection is only for empty maintained-project installs. `openInitialDialog()` must load project state first and return without scanning when `projectStore.projects.length > 0`.
- Manual detection is user-triggered from the history session list refresh action. It must still run when maintained projects exist.
- Manual detection should prompt only for history candidates whose project path/source is not already represented by a maintained project.
- No-candidate manual scans should use a toast and keep the sync dialog closed.
- Candidate and dialog copy must use `useI18n()` / `translateCurrent()` in `zh-CN`, `zh-TW`, and `en-US`.

### 4. Validation & Error Matrix

- Startup + projects exist -> mark initial prompt handled, no scan, no dialog.
- Startup + no projects + candidates exist -> show initial sync dialog with all candidates selected.
- Startup + no projects + no candidates -> mark initial prompt handled, no dialog.
- Manual refresh + missing project candidates exist -> refresh history list, then show manual sync dialog.
- Manual refresh + no missing project candidates -> refresh history list, show no-candidates toast, keep dialog closed.
- Scan failure -> clear scanning state and show scan-failed toast for manual scans; log warning for startup scans.

### 5. Good/Base/Bad Cases

- Good: a user with an existing project list clicks history refresh and only sees a sync prompt when history contains a new, unmaintained project.
- Base: a fresh install with no projects still gets the first-run detection prompt.
- Bad: startup scans every launch even though the user already maintains projects.
- Bad: history refresh opens an empty sync dialog when there are no missing projects.

### 6. Tests Required

- Run `npx tsc --noEmit` after frontend store/component changes.
- Manually verify the history refresh button reloads sessions and opens the sync dialog only when missing projects exist.
- Manually verify Settings -> General language switching updates the sync dialog, tooltips/aria labels where visible, and toasts across `zh-CN`, `zh-TW`, and `en-US`.

### 7. Wrong vs Correct

#### Wrong

```typescript
void useExternalSessionSyncStore.getState().openInitialDialog();
```

#### Correct

```typescript
await ensureProjectStoreLoaded("startup");
if (useProjectStore.getState().projects.length > 0) {
  set({ initialSyncPromptHandled: true, scanningProjects: false, projectCandidates: [] });
  await persistCurrentState(get());
  return;
}
```

## Scenario: User-Owned Synced Project Layout

### 1. Scope / Trigger

- Trigger: changing startup materialization of previously synced history projects, project grouping, or the persisted project ignore list.

### 2. Signatures

- Persisted store fields: `syncedSessions`, `ignoredProjectKeys`.
- Store action: `externalSessionSyncStore.syncProjectCandidates(keys: string[])`.
- Startup materialization: `ensureProjectsForSyncedSessions(sessions)`.

### 3. Contracts

- A successful project sync must merge each selected candidate's `project.key` into `ignoredProjectKeys` and persist it with the sync state.
- `syncProjectCandidates` must return immediately while `syncingProjects` is already true. The dialog's disabled button is presentation feedback, not the concurrency boundary; the Store guard prevents rapid clicks or programmatic callers from starting a second write.
- Loading existing `syncedSessions` must backfill their stable project keys into `ignoredProjectKeys` without scanning or deleting history files.
- Startup materialization may create a missing project, but must not rename, move, or regroup an existing project based on its history source.
- The user's saved project name and `group_id` are authoritative after the initial sync.
- Removing automatic context injection must not create or update `.cli-manager/synced-history-context` files.

### 4. Validation & Error Matrix

- Selected project sync succeeds -> project key is persisted in the ignore list and is filtered from later scans.
- Project sync is already running -> repeated invocation is a no-op; success or failure clears `syncingProjects` through the existing completion paths so a later deliberate retry remains available.
- Existing synced state loads -> missing ignore keys are merged once; old files remain untouched.
- Existing project is renamed or moved to the root -> startup leaves its name and group unchanged.
- Missing project with synced history -> startup may recreate the initial project/group structure.
- Any Claude/Codex launch path -> use the original command without hidden history-context arguments.

### 5. Good/Base/Bad Cases

- Good: user renames an imported project and moves it out of its folder; restart preserves both changes.
- Base: first sync creates the expected project and group, then records the candidate key as ignored.
- Good: an upgrade with old `syncedSessions` backfills ignore keys without touching the generated legacy files.
- Bad: startup sees an ungrouped project and automatically renames it to `Claude` or `Codex`.
- Bad: a new terminal writes a context Markdown file solely to inject prior conversation text.

### 6. Tests Required

- Static regression asserts the context module and launch references are absent.
- Static regression asserts startup materialization contains no existing-project update and sync persists `ignoredProjectKeys`.
- Type-check with `npx tsc --noEmit`.
- Manual desktop check: rename/move an imported project, restart, sync again, and confirm layout remains user-owned and the project is not listed again.

### 7. Wrong vs Correct

#### Wrong

```typescript
await useProjectStore.getState().updateProject(existingProject.id, {
  name: sourceLabel(group.source),
  group_id: externalGroup.id,
});
```

#### Correct

```typescript
if (existingProject && matchesProjectSource(existingProject, group.source)) continue;
```

## Scenario: Resume History Session With Project CLI Arguments

### 1. Scope / Trigger

- Trigger: changing the history detail/list resume action, project matching, or resume command construction.

### 2. Signatures

- Project candidates: `findHistoryProjects(session, projects): Project[]`.
- Source-agnostic directory candidates: `findLocalHistoryCwdProjects(session, projects): Project[]`.
- Command builder: `appendResumeCliArgs(baseCommand, source, project): string`.
- Terminal creation keeps the existing `terminalStore.createSession(...)` contract.

### 3. Contracts

- Both the detail action and list context-menu action must enter the same resume flow.
- The detail action may resume only when the loaded detail identity matches the currently selected history view. Local/WSL history uses source, session id, and file path; SSH history uses source, session id, and the complete stable `session_ref` tuple (`sourceId`, `sourceInstanceId`, `sourceSessionId`, `transportKind`) because remote summaries and details intentionally expose no local `file_path`.
- Match maintained projects by history `cwd` first, then by `project_key`, and require the project's CLI type to match the history source.
- One candidate resumes directly; multiple candidates require explicit selection; cancel creates no terminal.
- The selected project supplies `cli_args`, provider overrides, environment variables, shell, and Worktree overrides.
- Existing session-selection fragments in project `cli_args` must be removed before the selected history session's resume command is built; ordinary CLI arguments and Provider overrides remain in effect.
- When no source-compatible project exists but the history `cwd` exactly matches one local/WSL maintained project, resume immediately with `Use New Window` semantics. The matched directory is identity evidence only: do not inherit that other CLI's project id, CLI arguments, environment variables, provider overrides, or Agent metadata. Its Shell type may be reused only to preserve the local/WSL runtime boundary.
- Otherwise, zero matching candidates must show all maintained projects plus a localized `Use New Window` option instead of stopping with an error. Duplicate exact-`cwd` projects still require explicit selection.
- `Use New Window` creates an unscoped internal terminal with the resolved history working directory as PTY `cwd`, then runs the bare resume command without project CLI arguments.
- If no working directory can be resolved, stop with a localized error and create no terminal.

### 4. Validation & Error Matrix

- Invalid session ID or unsupported source -> localized error, no terminal.
- Missing or stale detail whose identity differs from the selected view -> keep resume disabled and create no terminal. An SSH detail with an empty local file path is valid only when both sides carry the same complete SSH `session_ref`; missing, mixed-transport, or changed remote references remain rejected.
- Zero compatible project candidates + one exact local/WSL `cwd` project -> resume directly with the bare source command and no project launch configuration.
- Zero compatible project candidates + zero/multiple exact `cwd` projects -> show all projects plus `Use New Window`; cancel -> no terminal.
- `Use New Window` + valid history working directory -> create an unscoped terminal in that directory, then run the resume command.
- `Use New Window` + missing history working directory -> localized error, no terminal.
- One compatible candidate -> create the terminal with its launch configuration.
- Multiple compatible candidates -> show the searchable grouped picker; cancel -> no terminal.
- Worktree match -> use the owning project configuration plus Worktree path/provider overrides.

### 5. Good/Base/Bad Cases

- Good: two Claude project records match one history directory; the user selects one and its `cli_args` appear after `claude --resume <id>`.
- Good: a Claude session converted to Codex has only one Claude project at the same `cwd`; Codex resumes directly in that directory without receiving Claude launch configuration.
- Base: one Codex project matches exactly and resumes without an extra prompt.
- Bad: project lookup uses `find()` and silently chooses the first duplicate.
- Bad: zero matching projects immediately produce an error without offering a manual project choice.
- Bad: `Use New Window` starts in the application default directory and only then tries to recover the intended cwd.

### 6. Tests Required

- Run `npx tsc --noEmit`.
- Run `node scripts/resumeCliArgs.test.mjs`.
- Run `node scripts/historyResumeProject.test.mjs`.
- Run `node scripts/historySessionIdentity.test.mjs` and `node scripts/historyConversionState.test.mjs`.
- Manually verify detail and context-menu resume for Claude/Codex, one/multiple/no candidates, picker cancel, Local/WSL/Bash, and main project/Worktree.
- Switch between `zh-CN`, `zh-TW`, and `en-US` and verify picker, aria labels, and errors.

### 7. Wrong vs Correct

#### Wrong

```typescript
const project = projects.find(matchesHistoryProject);
const command = appendResumeCliArgs(baseCommand, source, project);
```

#### Correct

```typescript
const candidates = findHistoryProjects(session, projects);
const cwdProjects = findLocalHistoryCwdProjects(session, projects);
if (candidates.length === 0 && cwdProjects.length === 1) {
  return resumeWithoutProject(session, { shell: cwdProjects[0].shell });
}
if (candidates.length === 0) return openProjectPicker(projects, { allowNewWindow: true });
if (candidates.length > 1) return openProjectPicker(candidates);
return resumeWithProject(session, candidates[0]);
```

## Scenario: Activate a Newly Converted Session

### 1. Scope / Trigger

- Trigger: changing Claude/Codex conversion results, `historyStore.addConvertedSession`, or detail request state.
- Goal: a converted target session is usable immediately without waiting for the rebuildable history catalog.

### 2. Contracts

- `history_convert_session` returns a target summary plus a target detail already parsed by the backend.
- `addConvertedSession(summary, detail)` verifies their source/session id/file path identity, invalidates any older detail request, and sets the list row, active key, and active detail in one Store update.
- `openSession` and `openSearchHit` clear the previous `activeSession` before awaiting another detail; request sequence guards still prevent stale results and stale `finally` handlers from winning.
- Conversion success does not immediately invoke `history_get_session`; ordinary later opens still use the indexed read path.

### 3. Validation Matrix

- Target catalog row is not ready -> converted detail renders from the conversion response; no `session_file_not_indexed`.
- A later ordinary open of a converted Claude session -> the summary project key matches the backend inventory key, including an existing Windows directory's actual casing.
- An older detail request completes after conversion -> request sequence mismatch prevents overwrite.
- A new detail request fails without a favorite snapshot -> active detail remains empty; resume cannot use the previous session.
- Summary/detail identity differs -> reject with `history_conversion_detail_mismatch` and do not activate it.

### 4. Tests Required

- Run `node scripts/historySessionIdentity.test.mjs`.
- Run `node scripts/historyConversionState.test.mjs`.
- Run `npx tsc --noEmit`.

## Scenario: Background History List Refresh

### 1. Scope / Trigger

- Trigger: changing history-index ready events, manual history refresh, remote cached refresh, list pagination, or the history loading state.
- Goal: refreshing an already rendered list must preserve its scroll geometry and loaded range instead of replacing it with one loading row.

### 2. Signatures

- Store action: `loadSessions(options?: { background?: boolean }): Promise<void>`.
- Automatic local refresh: `history-index-status` with a new ready generation calls `loadSessions({ background: true })`.
- Manual local/remote refresh calls `loadSessions({ background: true })` after the index or remote cache is updated.

### 3. Contracts

- Background mode is active only when the Store already has sessions. An empty list falls back to foreground loading so the initial state remains explicit.
- Background mode keeps `loadingSessions=false` and leaves the current rows mounted while the request is in flight.
- The request limit is `max(SESSION_PAGE_SIZE, sessionListOffset) + 1`; refresh must reload every source row already paged into the list and use the extra row to recompute `hasMoreSessions`.
- Foreground loads caused by initial open or source/project filter changes may reset pagination and show the blocking loading row.
- Request-sequence and remote-consumer guards remain authoritative; a stale refresh cannot replace a newer filter, remote context, or pagination result.
- `visibleSessionCount` resets only when the visible filter/query changes, not when `loadingSessions` changes.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Ready generation changes while rows are visible | Refresh in background; keep list height and scroll position |
| Manual refresh while more than one page is loaded | Reload the current loaded range; do not shrink to 20 rows |
| Background option is requested with an empty Store | Use foreground loading and fetch the first page |
| Source or project filter changes | Use foreground loading and reset the source offset |
| Older refresh completes after a newer list request | Ignore the stale result through `sessionListRequestSeq` |
| Refreshed active session is no longer present | Select the first remaining session and clear stale detail |

### 5. Good / Base / Bad Cases

- Good: the user scrolls midway through 60 sessions; an index-ready event refreshes 60 rows without moving the viewport to the top.
- Good: manual refresh preserves the rows already loaded and then reruns an active global search.
- Base: opening history with no cached rows still displays the existing loading state.
- Bad: set `loadingSessions=true` for every ready event; the virtualizer collapses to one 56 px row and the browser clamps `scrollTop` to zero.
- Bad: background refresh always requests 21 rows; a user who loaded later pages loses them after every index update.

### 6. Tests Required

- Run `node --test scripts/historyListRefreshState.test.mjs` and assert automatic/manual refresh use background mode, the loaded offset determines the fetch limit, and loading does not reset visible rows.
- Run `npx tsc --noEmit`.
- Manually scroll a multi-page local and SSH history list, trigger automatic and manual refresh, and verify the viewport and loaded range remain stable.

### 7. Wrong vs Correct

#### Wrong

```typescript
set({ loadingSessions: true, sessionListOffset: 0 });
await get().loadSessions();
```

#### Correct

```typescript
await get().loadSessions({ background: true });
```

## Scenario: Local Pi History Resume

### 1. Scope / Trigger

- Trigger: changing local history resume commands, CLI source matching, or project selection.
- Goal: reopen the exact Pi transcript without binding an unrelated project or creating a new session.

### 2. Signatures

```typescript
buildHistoryResumeCommand(session, project?): string | null;
stripPiResumeCliArgs(cliArgs): string;
selectLocalHistoryResumeProject(session, projects, worktree, projectIdFilter): LocalHistoryResumeSelection;
```

### 3. Contracts

- Local Pi resume uses `pi --session <session-id>`; `--session-id` is forbidden because it may
  create a new session instead of reopening the selected transcript.
- Pi project arguments are cleaned by a dedicated helper. Remove `-c`, `-r`, `--continue`,
  `--resume`, `--session`, `--session-id`, `--fork`, their inline/separate targets, and preserve
  ordinary arguments such as `--session-dir` and model selection.
- Do not change shared Claude/Codex/Grok `stripResumeCliArgs` or `appendResumeCliArgs` semantics.
- Source matching first uses `resolveCliToolHistorySourceId`; provider switching is only the fallback
  when the registry cannot resolve a source.
- Local selection order is exact Worktree project, source plus cwd/project-key candidates, current
  `projectIdFilter` when it belongs to those candidates, unique candidate, then explicit dialog.
  A current project with the wrong source must never be bound automatically.
- Pi advertises local resume as supported. SSH Pi resume remains unsupported until the remote
  identity/preflight protocol explicitly adds Pi.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Invalid/whitespace session ID | Return `null`; do not launch |
| Pi project contains old resume selectors | Remove selectors and targets before appending ordinary args |
| Current project is not in the matched candidate set | Do not auto-bind it |
| Several same-source cwd candidates remain | Open the explicit project dialog |

### 5. Good / Base / Bad Cases

- Good: an exact Worktree project wins even when the main cwd has duplicate Pi projects.
- Base: one Pi project matches cwd and resumes directly with its normal model/session-dir args.
- Bad: build `pi --session-id ...`, or use the currently filtered Codex project for a Pi session.

### 6. Tests Required

- Run `node --test scripts/resumeCliArgs.test.mjs scripts/historyResumeProject.test.mjs`.
- Cover exact `pi --session`, every conflicting argument, preserved normal arguments, duplicate cwd
  selection, wrong-source rejection, Worktree priority, and Claude/Codex/Grok regressions.

### 7. Wrong vs Correct

```typescript
// Wrong: --session-id can select/create the wrong Pi session.
const command = `pi --session-id ${sessionId}`;

// Correct: the dedicated builder strips stale selectors and uses exact resume.
const command = buildHistoryResumeCommand(session, project);
```

## Scenario: History File Change Records

### 1. Scope / Trigger

- Trigger: changing history JSONL file-operation parsing, the history Changes view, or history Diff rendering.

### 2. Signatures

- Backend detail field: `HistorySessionDetail.file_changes: HistoryFileChangeSummary[]`.
- File operation location: `message_index`, `operation_group_index`, and `timestamp` on `HistoryFileChangeOperation`.
- Shared renderer: `GitDiffViewer({ diffText, filePath, fileName, status })` with no discard callback for history.

### 3. Contracts

- The session JSONL is the source of truth; do not infer historical content from the current workspace file.
- Decode escaped Codex apply-patch text before extracting paths and line counts.
- Changes view rows use `getMaterialFileIcon()` like the file explorer.
- Changes view rows show Added/Modified/Deleted semantic tags; additions use success color and deletions use danger color.
- Left click opens a read-only `GitDiffViewer`; right click jumps to `message_index` when present.
- Convert Apply Patch blocks to standard unified diff before rendering so the viewer keeps split mode.
- History must not pass `onRequestDiscard`, so file/hunk/line revert actions stay disabled.

### 4. Validation & Error Matrix

- Structured operations exist -> prefer `file_changes` over message-text fallback.
- Missing `message_index` -> keep the change visible and disable the jump menu item.
- Apply Patch input -> synthesize unified headers and hunk ranges, then render through split mode.
- Unsupported patch after normalization -> `GitDiffViewer` falls back to the read-only Monaco diff editor.
- No parsed changes -> show the history empty state.

### 5. Good/Base/Bad Cases

- Good: escaped Codex patch shows the real file icon/path and opens the shared read-only Diff viewer.
- Base: a legacy message-only unified diff remains available through the worker fallback.
- Bad: reading the current workspace file to fabricate an old baseline.
- Bad: maintaining a second history-only Diff renderer with different highlighting behavior.

### 6. Tests Required

- Rust regression: Claude tool input and escaped Codex apply-patch input produce paths, groups, additions, and deletions.
- Frontend: run `npx tsc --noEmit` after changing row props, context menus, or shared Diff viewer props.
- Manual: verify left-click Diff, right-click conversation jump, disabled jump without message index, and file icons in both languages.

### 7. Wrong vs Correct

#### Wrong

```tsx
<FileCode2 />
<HistoryOnlyDiff patch={operation.patch} />
```

#### Correct

```tsx
<img src={getMaterialFileIcon(fileName)} alt="" />
<GitDiffViewer filePath={path} fileName={fileName} status={status} diffText={patch} />
```
