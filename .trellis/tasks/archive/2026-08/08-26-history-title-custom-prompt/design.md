# 历史会话智能命名自定义 Prompt · Technical Design

## 1. Scope and decisions

This task delivers one global, local-only custom system prompt for History Session Smart Naming.

| Decision | Chosen behavior |
| --- | --- |
| Scope | One global prompt inside `historySmartTitle`; it is not per Provider. |
| Trigger coverage | Both manual and automatic title generation use the same effective prompt. |
| Replacement semantics | A non-empty custom value fully replaces the built-in title instruction. Empty/cleared means built-in. |
| Message framing | The prompt is a system instruction only. The first valid user message stays a separately framed user input; no `{{message}}` variables are supported. |
| Persistence | Stored locally in `settings.json`; `historySmartTitle` remains excluded from settings sync. |
| Bounds | Trim outer whitespace; reject NUL; limit a non-empty value to 4096 UTF-8 bytes. |
| Extra calls | No preview/test request and no new Provider request endpoint. |

The task remains one vertical slice rather than a parent/child tree: the setting, UI, and request selection are one behavior that cannot be independently accepted without the other layers.

## 2. Data flow and boundaries

```text
Settings textarea draft
  → settingsStore.historySmartTitle.customPrompt
  → local settings.json (existing Tauri Store)
  → history_title_generate
  → Tauri async command responder
  → Rust reads/snapshots historySmartTitle
  → effective built-in/custom system instruction
  → auxiliary_text protocol adapter
  → selected Provider
```

The existing `HistoryTitleGenerateRequest` remains unchanged. `historyStore.generateSmartTitle` continues sending session identity, candidate hash/text, trigger, Provider and model only. The Rust command already reads `settings.json` to validate the selected Provider; it will read the custom prompt from the same snapshot. This prevents a renderer-side IPC caller from substituting a different prompt at request time.

The candidate text boundary is unchanged:

- `extractHistoryTitleCandidate` selects the first visible, non-injected user text.
- Candidate text remains independently UTF-8 bounded and hashed.
- Provider protocols receive it as the user/input field, never interpolated into a custom instruction.

The explicit Save control waits for the existing `settingsStore.update(...)` persistence Promise. Only a fulfilled write updates the draft and produces a localized success toast; a rejected write leaves the last persisted prompt authoritative and produces a localized failure toast. A local `saving` flag disables repeated Save/Restore interactions while the write is in flight.

The frontend `invoke("history_title_generate", ...)` already returns a Promise, but the Rust command must also be declared `async`. Its asynchronous responder immediately dispatches the owned request to Tauri's dedicated `spawn_blocking` worker, where the existing non-`Send` SQLx/provider helper can finish through `block_on` without occupying the synchronous IPC handler. The IPC name, request payload, response payload, queue ownership, and provider timeout stay unchanged; the only removal is the synchronous handler's nested `block_on`.

## 3. Settings contract

Extend `HistorySmartTitleSettings` with:

```ts
customPrompt: string; // empty string = use built-in prompt
```

`DEFAULTS.historySmartTitle.customPrompt` is `""`. `migrateHistorySmartTitleSettings` keeps a string only when its trimmed UTF-8 byte length is at most 4096 and it contains no NUL; otherwise it returns `""`. This makes missing legacy values backward compatible and prevents a hand-edited settings file from making automatic generation unsafe or unbounded.

The frontend uses the same 4096-byte limit before saving. A draft that is empty/whitespace-only is valid and saves as `""`; an oversized or NUL-containing draft remains unsaved and displays a localized field error.

No SQLite migration, WebDAV format, settings-sync classification, Provider schema, or IPC registration changes are required.

## 4. Settings UI

`HistorySourceSettingsPage` extends its existing Smart History Session Naming card:

- Add a locally controlled Mantine `Textarea` for the custom instruction.
- Show that leaving it empty uses the built-in instruction and that the session's first real user message is added separately; do not advertise unsupported template variables.
- Show byte-limit validation, an accessible label/description/error association, and a local draft so disk is not written on each keystroke.
- Add an explicit Save button and a Restore default button. Save stores the trimmed value; Restore default stores `""` and clears the draft without an extra Provider call.
- Do not change the automatic naming switch, Provider selection, model selection, queue ownership, or the History toolbar quick toggle.

New visible copy uses `src/lib/i18n.ts` keys for `zh-CN` and `en-US` (with the project’s existing `zh-TW` fallback behavior). The editor must not introduce hard-coded copy.

## 5. Backend resolution and request safety

The current built-in instruction becomes the immutable `BUILTIN_PROMPT` fallback. Add a small typed settings snapshot rather than extending the existing positional tuple indefinitely:

```rust
struct HistoryTitleSettingsSelection {
    enabled: bool,
    app_type: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    custom_prompt: Option<String>,
}
```

`settings_selection()` reads `customPrompt`, trims/validates it, and treats invalid or blank input as `None`. `history_title_generate_async` reads this snapshot once, uses it for the initial Provider/automatic validations, then computes:

```text
effective_prompt = selection.custom_prompt.unwrap_or(BUILTIN_PROMPT)
```

It passes that value to `request_title`, which passes it unchanged to `provider::auxiliary_text::post_text_request`:

| Provider protocol | Existing field that receives the effective prompt |
| --- | --- |
| Anthropic Messages | `system` |
| OpenAI Chat Completions | `messages[role=system]` |
| OpenAI Responses | `instructions` |

`provider::auxiliary_text` itself is unchanged; it already accepts a protocol-neutral system instruction. Existing response validation and `sanitize_title` remain mandatory even when the user intentionally configures a looser prompt. Logging must continue to contain only metadata, never custom prompt text, candidate text, credentials, or unsanitized model output.

Changing the setting affects requests that start after the new settings snapshot is read. A request already sent to a Provider finishes with its captured prompt and continues to use the existing revision/CAS protections; changing a prompt neither cancels nor rewrites completed titles.

The existing completion guard deliberately reads a fresh settings snapshot after a Provider response. It continues to reject a result when the selected Provider/model changed or automatic naming was disabled while the request was in flight; this guard does not alter the prompt already sent.

## 6. Compatibility, failure behavior, and rollback

- Old settings files omit `customPrompt` and therefore preserve exact built-in behavior.
- An old frontend can continue calling the unchanged IPC command; the new backend falls back to built-in prompting when the setting is missing.
- Malformed/local-hand-edited prompt settings fall back safely to the built-in prompt. The normal UI prevents invalid saves and explains the limit locally.
- Automatic failures remain silent under the existing contract; manual generation retains its existing safe localized Provider/error handling.
- Clearing the custom setting is the rollback path. No generated-title records need deletion and no database migration is introduced.
- Existing in-progress async/CLI-UA work also touches `history_title.rs`; before implementation, inspect the live diff and integrate only against its current request path, never overwrite unrelated changes.

## 7. Out of scope

- Per-Provider, per-project, or per-session prompt profiles.
- Prompt variables, hand-authored user-message request bodies, prompt preview, and test-generation requests.
- Syncing the prompt to WebDAV/cloud settings.
- Changing source candidate extraction, title output sanitization, Provider credentials, request protocol selection, queue scheduling, or generated-title persistence.

## 8. Shared production/development database contention

The installed app and `npm run tauri dev` intentionally use the same app-data root, settings store, and main SQLite database. This is a supported development mode, so title generation must not interpret a concurrent local writer as an invalid Provider, model, or network.

`history_title_generate` has two short read-then-write persistence phases: it reserves a pending generation before the Provider request and persists the terminal result after it. Both phases use `BEGIN IMMEDIATE`, which reserves the SQLite write slot before reading the row and avoids a WAL snapshot-upgrade race with another process. The connection uses a 15-second bounded busy timeout, matching existing main-history writes. If the bound is still exhausted, Rust returns `history_title_database_busy`; the UI maps that stable code to a localized local-database-busy toast. It never exposes raw SQLite details or redirects the user to Provider configuration.

## 9. Responsiveness and save feedback

- Provider requests may legitimately take several seconds. `history_title_generate` is a Tauri async command that awaits a dedicated `spawn_blocking` worker. That worker runs the existing non-`Send` SQLx/provider helper, so the slow HTTP wait no longer occupies the synchronous IPC handler.
- The existing generated-title pending/duplicate guard remains authoritative. The change does not start a second queue, event channel, Provider request, or optimistic title update.
- The renderer adds the accepted request's session key to an in-memory in-flight set before detail loading, candidate extraction, or the Provider wait. Detail and list UI combine this transient state with hydrated database `pending` state, immediately show the existing localized pending label/loading icon, and disable a duplicate click. The key is removed only by the request that still owns the session trigger, so a manual request replacing automatic work cannot lose its feedback. The set is not persisted and does not optimistically write a title.
- Save feedback describes only the local `settings.json` write. It does not imply that a Provider request was made, accepted, or will use the value for a request already in flight.
- An older frontend still sends the same invoke request and remains compatible. A rollback can restore the synchronous wrapper if necessary, but no persisted data or IPC shape changes need reversal.
