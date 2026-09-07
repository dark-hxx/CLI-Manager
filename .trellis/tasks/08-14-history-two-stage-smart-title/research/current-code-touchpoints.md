# Current code touchpoints

## History title and user metadata

- `src-tauri/src/commands/history.rs` and `src-tauri/history-core/src/lib.rs` derive source titles from source transcripts. This source title remains reconstructable and must not become the generated-title truth.
- `src/stores/historyStore.ts:1416` currently calculates `displayTitle = alias.trim() || summary.title`.
- `src/stores/historyStore.ts:1487-1700` loads `session_meta`, joins it to summaries/details, and hydrates favorite snapshots.
- `src/stores/historyStore.ts:2030-2046` has defensive frontend creation of `session_meta` and indexes.
- `src/stores/historyStore.ts:3059-3082` updates alias/tags/starred metadata.
- `src/components/HistoryWorkspace.tsx:646-653` saves the current alias and tags.
- `src/components/history/HistoryListPane.tsx` owns list-row title rendering and context menu actions.
- `src/components/history/SessionDetailPane.tsx` owns detail header/view rendering and is an intended manual-title action surface.
- `src-tauri/src/lib.rs:738-778` registers historical `session_meta` migrations. Current planning evidence reports the latest project migration as v29; implementation must verify current HEAD and append only the next unused version.

## Persistence boundary

- `cli-manager.db` / `session_meta` is user-authored metadata and survives history catalog rebuilds.
- `.cli-manager/history-cache*/history-catalog.db` is derived and rebuildable. `.trellis/spec/backend/history-index-contracts.md:17-28` forbids treating it as user-authored truth.
- Existing alias/tags/starred/favorite metadata is not currently included in WebDAV backup/restore. Smart title metadata should follow that existing boundary in this task unless sync is separately designed.
- SSH `config_alias` is unrelated to history-session alias.

## Stable identity constraints

- Local session keys currently combine source/session/path-oriented information in the frontend history layer.
- V2/remote contracts expose `HistorySessionRef`: `sourceId`, `sourceInstanceId`, `sourceSessionId`, `transportKind`, and raw pointers.
- SSH smart-title ownership must at minimum bind `(sourceId, sourceInstanceId, sourceSessionId)`; host ID or file path alone is insufficient.
- Worktree cwd/path is location metadata, not a durable cross-instance identity.
- Remote cached summaries do not contain complete messages. Automatic generation for SSH therefore requires an online detail fetch or a future remote-agent candidate contract; it must not infer text from the summary title.

## Provider domain

- Tauri commands are registered in `src-tauri/src/lib.rs:1421-1462`; provider catalog commands live in `src-tauri/src/commands/provider.rs`.
- Provider storage and secrets are backend-owned in `src-tauri/src/provider/`; the frontend must not request/reveal an active key for title generation.
- Composite provider identity is `(provider_id, app_type)` per `.trellis/spec/backend/ccs-provider-domain-contracts.md`.
- `src-tauri/src/provider/models.rs` already resolves active keys and performs model-list calls through `provider::network_client`.
- `src-tauri/src/provider/runtime.rs` and provider-specific parsers derive effective runtime endpoint/protocol/model fields.
- `src-tauri/src/provider/network_client.rs` centralizes the CLI-Manager outbound proxy/TLS client configuration.

## Existing auxiliary LLM request code

- `src-tauri/src/commands/command_suggestion.rs` supports OpenAI Chat Completions and Responses, timeout, body cap, response parsing, usage extraction, and shared network-client use.
- That command currently accepts `base_url`, plaintext `api_key`, and `model` from the frontend (`CommandSuggestionGenerateRequest`), so its public command contract is not safe to reuse for smart titles.
- Its low-level protocol request/response helpers are candidates for extraction into a backend-only shared auxiliary text-generation module after GitNexus impact analysis.
- Anthropic Messages/provider-domain effective config support must be mapped from the Native Provider runtime rather than assumed from the command-suggestion OpenAI-only paths.

## UI and settings

- `src/stores/settingsStore.ts` owns persisted app settings and already contains history sidebar preferences and the `native-providers` tab id.
- `src/components/SettingsModal.tsx` maps setting tabs/pages; planning requires a formal “Session History” settings surface or extension of the existing history-source/history settings area based on current UI information architecture.
- `src/components/HistoryWorkspace.tsx` owns the history top toolbar and is the required quick toggle location.
- `src/lib/i18n.ts` is the single translation source; all added labels, descriptions, disabled reasons, aria labels, toasts, and failure messages require zh-CN/en-US and existing zh-TW compatibility.

## Required pre-edit analysis

Before implementation edits, run GitNexus impact analysis for every modified function/class/method, especially:

- history metadata initialization/hydration/update functions in `historyStore.ts`;
- title/view construction helpers;
- `HistoryWorkspace` and `HistoryListPane` handlers;
- settings load/normalization/save functions;
- provider repository/runtime resolution functions;
- extracted protocol request helpers from `command_suggestion.rs`;
- Tauri command registration and migration additions.

Run `gitnexus_detect_changes()` before commit.