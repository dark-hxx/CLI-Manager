# 历史会话两阶段智能命名 · Implementation Plan

## Delivery strategy

One complete task delivers manual and automatic smart titles. Implement in vertical slices so each slice remains testable and rollback-safe. Do not run `task.py start` until the user approves the planning artifacts.

## Phase 0 · Pre-development gate

- [x] Run `trellis-before-dev` and load current phase context.
- [x] Re-run `git status --short`, `git fetch --prune`, and upstream divergence; repository is aligned with upstream before implementation.
- [ ] Remove or isolate research checkout directories currently visible as untracked: `.research-cherry-proxy/`, `.research-cherry/`, `.research-cherry2/`, `.tmp-openai-codex/`. These were research artifacts and must never enter the task commit. Ask before deleting if ownership is uncertain.
- [x] Verify current highest Tauri SQL migration version and append the next unused version; do not assume v30 without checking HEAD.
- [x] Run GitNexus repository/context freshness check.
- [x] Run `gitnexus_impact(..., direction: upstream)` before editing every function/class/method. Report direct callers, affected processes and risk; warn before any HIGH/CRITICAL edit.
- [ ] Run GitNexus concept queries for: history metadata hydration/update/delete; history index ready flow; provider runtime resolution; command suggestion text request; settings normalization; history toolbar/context menu.

## Phase 1 · Persistence and pure title resolution

### 1.1 Migration

- [x] Add additive migration creating `history_generated_titles` and indexes per `design.md`.
- [x] Add migration registration tests ensuring old migrations remain unchanged and the new migration is uniquely ordered.
- [x] If the frontend defensive DB initializer mirrors application migrations, add `CREATE TABLE IF NOT EXISTS` only as compatibility repair; the Tauri migration remains authoritative.

### 1.2 Frontend data types and normalization

- [x] Add generated-title/failure/state types to `src/lib/types.ts` or the existing history type module.
- [x] Add DB-row normalizer with strict state/failure parsing and safe defaults.
- [x] Add one pure `resolveHistoryDisplayTitle(alias, generated, source, sessionId)` helper.
- [x] Replace all ad hoc `alias || title` display calculations with the helper/precomputed `displayTitle`; search after edits for missed title precedence paths.

### 1.3 Hydration and deletion

- [x] Load generated-title rows together with `session_meta` without N+1 queries.
- [x] Overlay generated metadata on local summaries, remote cached summaries and favorite snapshots without changing `summary.title`.
- [x] Extend session delete, batch delete and metadata cleanup to delete generated-title rows.
- [x] Verify catalog reset/rebuild does not touch the new table.

### Validation

- [ ] Unit/pure tests: alias > generated > source > ID; empty/whitespace values; provider deletion retains generated title.
- [ ] DB tests: migration, round-trip state, delete cleanup, stuck pending normalization.
- [x] `npx tsc --noEmit`.

Rollback point: UI still behaves exactly as today when no generated rows exist.

## Phase 2 · Settings and provider readiness

### 2.1 Settings state

- [x] Add normalized `historySmartTitle` setting with default disabled.
- [x] Implement atomic setters for selection and enable transition; false -> true sets `enabledAt`, true -> false invalidates automatic queue ownership.
- [x] Ensure settings import/load handles missing, malformed and legacy values.

### 2.2 Backend readiness

- [x] Add redacted provider-option/readiness query through provider repository/runtime.
- [x] Validate composite `(appType, providerId)`, enabled status, active key, effective endpoint, supported protocol and model.
- [x] Return stable reason codes only; never return active key or raw effective documents.
- [x] Register new Tauri command(s) in `src-tauri/src/lib.rs`.

### 2.3 Formal settings UI

- [x] Add/extend “Session History” settings surface.
- [x] Render auto switch, provider selector, model selector/editable model ID, readiness, privacy/cost disclosure and link to Native Provider settings.
- [x] Prevent enabling without a ready selection; preserve invalid saved selection visibly for repair.
- [x] Add zh-CN/en-US and zh-TW compatibility strings, help and aria labels.

### 2.4 History toolbar quick switch

- [x] Add persistent top-toolbar switch bound to the same setting.
- [x] Configured: toggle directly. Unconfigured/unready: stay off, explain and open Settings -> Session History.
- [x] Verify no duplicated local switch state.

### Validation

- [ ] Settings normalization tests if existing store tests support it; otherwise pure helper tests.
- [ ] Provider readiness Rust tests with missing/disabled/keyless/unsupported/ready providers.
- [ ] Manual UI checks in zh-CN and en-US, 24-hour time unchanged.
- [ ] `npx tsc --noEmit`; `cd src-tauri && cargo test <provider/readiness tests>`; `cargo check`.

Rollback point: switches can remain disabled while metadata/display support is harmless.

## Phase 3 · Shared candidate extraction

- [x] Extract/reuse conversation classification logic so title candidate selection and Conversation view cannot drift.
- [x] Implement pure candidate selector for structured parts and legacy flat messages.
- [x] Produce stable candidate identity and SHA-256 fingerprint from normalized complete text.
- [x] Add UTF-8-safe truncation helper for model-visible input without changing the full fingerprint.
- [x] Explicitly reject system/developer injections, AGENTS/skills/permissions/environment blocks, tools, reasoning, metadata, empty/attachment-only/image-only messages.
- [x] Map local/WSL/V2/SSH detail identities; document any compatibility fallback.

### Validation fixtures

- [ ] Claude first user text.
- [ ] Codex user record with prefixed injected context before/after real text.
- [ ] Old snapshot without parts.
- [ ] Multi-text-part message.
- [ ] CJK, emoji, combining characters and >4096-byte input.
- [ ] Attachment-only/system-only session returns no candidate.
- [ ] Same session ID on two SSH source instances yields distinct identity.

Rollback point: candidate helper is pure and can ship unused until model command is ready.

## Phase 4 · Backend auxiliary text generation

### 4.1 Safe shared module

- [ ] Impact-analyze low-level command-suggestion protocol helpers and provider runtime functions.
- [ ] Extract backend-only auxiliary text generation abstractions; keep existing command-suggestion public behavior/signatures unchanged.
- [x] Route provider credentials/effective endpoint/model entirely in Rust.
- [x] Use provider network client/proxy/TLS policy.

### 4.2 Protocol adapters

- [x] Anthropic Messages adapter: text-only, no tools, thinking disabled.
- [x] OpenAI Responses adapter: text-only input/instructions, no tools, normal response parsing.
- [x] OpenAI Chat Completions adapter: system+user messages, no tools, supported completion cap.
- [x] Grok/effective protocol mapping only through explicit runtime config.
- [x] Reject unsupported/OAuth external-CLI-only routes that cannot make app-side requests.

### 4.3 Request policy and sanitization

- [ ] Implement fixed system prompt and JSON framing.
- [x] Apply input byte cap, output token cap, timeout and response body cap.
- [x] Implement title sanitizer: quotes/newlines/Markdown wrappers/ANSI/OSC/CSI/control/bidi/invisible removal, whitespace collapse, UTF-8-safe max bytes.
- [x] Map HTTP 429, timeout, cancellation, unsupported finish, tool call, empty/invalid/oversized response to stable failure codes.
- [x] Add safe structured logging without prompt/output/key.

### Validation

- [ ] Request-body snapshots per protocol prove no tools/reasoning/source-agent config.
- [ ] Response fixtures: valid, multiple text blocks, tool call, max tokens, malformed JSON, empty text, 429, 5xx, oversized body.
- [ ] Sanitizer tests for CJK/emoji/control/bidi/ANSI/quotes/multiline.
- [ ] Existing command-suggestion tests remain green.
- [x] Targeted Rust tests + `cargo check`.

Rollback point: backend generation is not yet automatically triggered.

## Phase 5 · Reservation, CAS and manual operations

### 5.1 Repository/service state machine

- [x] Implement transactional reservation, monotonic revision and pending state.
- [x] Revalidate source identity/fingerprint and current provider settings before dispatch.
- [x] Commit success/failure with guarded revision/state/identity update.
- [x] For automatic trigger, check alias remains empty in the commit transaction.
- [x] For manual trigger, allow alias and save generated fallback without changing alias.
- [x] Implement clear: increment/invalidate revision, clear title/state safely, preserve source title, and persist automatic suppression for the current fingerprint; explicit manual generation clears suppression.
- [x] Implement startup/history-load stuck-pending recovery without redispatch.

### 5.2 Tauri commands

- [x] Add generate/regenerate/clear/cancel/readiness command signatures.
- [x] Commands accept stable identity and expected candidate metadata, never secrets/base URL.
- [x] Register commands centrally in `lib.rs`.

### 5.3 Manual UI

- [ ] Add shared action-model helper.
- [x] Add actions to list context menu and detail title area.
- [x] Show pending state; prevent duplicate click; preserve alias priority.
- [x] Manual result updates only matching session/title and preserves current UI state.
- [x] Manual errors use localized safe toast; success/clear feedback follows existing toast conventions.

### Concurrency tests

- [ ] Generate -> manual alias -> late success: stale, alias unchanged.
- [ ] Generate revision N -> regenerate N+1 -> N returns last: N rejected.
- [ ] Generate -> clear/delete -> late success: rejected; clear suppresses future automatic work for that fingerprint until explicit manual generation.
- [ ] Two manual clicks: one reservation/request.
- [ ] Manual generate with alias: result saved but hidden until alias cleared.
- [ ] Crash/restart pending: no automatic retry.

Rollback point: complete manual smart-title feature works before automatic queue is enabled.

## Phase 6 · Automatic new-session queue

### 6.1 Trigger integration

- [ ] Use GitNexus to choose the existing new/updated-session detail/candidate-ready boundary without reparsing all histories.
- [x] Never schedule from list summary title alone.
- [x] Eligibility: enabled, `createdAt/firstObservedAt >= enabledAt`, candidate ready, no alias, no prior auto attempt or user-clear suppression for fingerprint, provider ready.
- [x] Persist enough first-observed/attempt state that catalog rebuild does not backfill old sessions.

### 6.2 Queue service

- [x] Implement application-lifetime queue singleton with concurrency 1 and bounded length.
- [x] Dedupe by sessionKey + fingerprint.
- [x] Manual work has priority but shares reservation/CAS.
- [x] Disable switch clears queued automatic tasks and invalidates active automatic revisions.
- [x] Session delete/provider invalidation/app exit cancels or makes work stale.
- [x] Closing History UI does not destroy or duplicate queue state.

### 6.3 Remote behavior

- [x] Local/WSL generation only after trusted detail/candidate availability.
- [x] SSH online detail can qualify; summary-only/offline cache cannot.
- [x] Never write remote files.
- [x] Confirm parent/child and same-ID/different-instance isolation.

### Automatic tests

- [ ] Default disabled: zero requests.
- [ ] Enable watermark: existing sessions skipped, later session handled.
- [ ] Repeated index ready/list reload: one request.
- [ ] Switch off before start: no request; during request: stale/no commit.
- [ ] Failed automatic task remains manual-retry-only.
- [ ] Provider becomes invalid between queue and dispatch: safe failure, no secret leakage.
- [ ] Window minimize/tray/history close does not duplicate work.

Rollback point: disabling shared setting immediately returns behavior to manual/source-title only.

## Phase 7 · Cross-layer integration and documentation

- [x] Verify favorite snapshot overlays generated title without mutating source title.
- [x] Verify no WebDAV schema/backup change; document smart titles as local metadata.
- [x] Verify delete/bulk delete/tree delete cleanup.
- [x] Verify search, filters, grouping, resume labels, prompt list and confirmations use display precedence.
- [x] Update `.trellis/spec/frontend/history-session-contracts.md` with smart-title display/action contract.
- [x] Update `.trellis/spec/backend/history-index-contracts.md` or add a focused history-title contract documenting catalog separation, identity, queue/CAS and provider secret boundary.
- [x] Update `CHANGELOG.md` under `V1.3.6` with `Refs #184`.
- [x] Update `docs/功能清单.md`.

## Phase 8 · Quality gate

- [x] Run `trellis-check`.
- [x] Run `npx tsc --noEmit`.
- [x] Run targeted Rust tests for migration/repository/candidate/protocol/CAS/queue.
- [x] Run `cd src-tauri && cargo test --lib`; 1033 passed, 1 ignored.
- [x] Run `cd src-tauri && cargo check`.
- [ ] Manually verify zh-CN and en-US; zh-TW fallback; 24-hour time.
- [ ] Manually verify provider setup, toolbar/form synchronization, old-session manual generation, alias pin, automatic new session, failure and clear.
- [ ] Verify no API Key, prompt body or raw output in logs/network payloads exposed to WebView.
- [ ] Run `gitnexus_detect_changes()` and confirm only expected symbols/flows.
- [x] Review `git diff --check`, `git status`, and ensure research checkout directories are not staged.

## Bug follow-up · manual smart-title failure feedback

- Root cause: the history list/detail action discarded the typed `history_title_*` error code and always showed the generic failure toast; with no persisted Provider/model selection this masked the expected `history_title_provider_not_selected` state.
- Fixed `HistoryWorkspace` error handling to map provider, candidate, remote, pending/cancelled and request failures to safe localized messages; provider configuration failures open Settings → Session History.
- Verified on the current local data: `settings.json` has no `historySmartTitle` selection, while the Provider database has configured entries; no secret values were read or emitted.

## Bug follow-up · Provider-compatible smart-title request

- Child task: `.trellis/tasks/08-14-fix-provider-title-generation/`（已完成）。
- Root cause: history title duplicated the Responses request and sent a structured `input_text` array, while the existing compatible Provider path uses a plain string `input`; the configured `/v1` Responses gateway rejected the divergent shape.
- Fix: added the shared `provider::auxiliary_text` protocol boundary, routed command suggestions and history titles through it, kept Responses `store=false`/non-streaming/no tools, and retained title CAS/tool/finish validation.
- UI: stable timeout, rate-limit, HTTP, network and response-format errors now map to safe zh-CN/en-US messages; raw response and credentials remain hidden.
- Verification: `cargo check`, `cargo test --lib`（1038 passed，1 ignored）、targeted helper/history/command-suggestion tests and `npx tsc --noEmit` passed. No real Provider request was issued; manual click verification remains for the user’s configured endpoint.

## Expected primary files/modules

Exact files may change after GitNexus exploration; likely touchpoints:

### Frontend

- `src/stores/historyStore.ts`
- `src/stores/settingsStore.ts`
- `src/lib/types.ts`
- `src/lib/i18n.ts`
- `src/components/HistoryWorkspace.tsx`
- `src/components/history/HistoryListPane.tsx`
- `src/components/history/SessionDetailPane.tsx`
- `src/components/SettingsModal.tsx`
- new focused smart-title settings/action components and pure helpers

### Rust/Tauri

- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/history.rs` or a focused `commands/history_title.rs`
- `src-tauri/src/commands/command_suggestion.rs` only for safe helper extraction/compatibility
- `src-tauri/src/provider/repository/*`
- `src-tauri/src/provider/runtime.rs`
- `src-tauri/src/provider/network_client.rs`
- new focused `provider/auxiliary_text.rs` and history-title repository/service modules

### Docs/tests

- `.trellis/spec/frontend/history-session-contracts.md`
- `.trellis/spec/backend/history-index-contracts.md` or new contract
- `CHANGELOG.md`
- `docs/功能清单.md`
- related Rust tests and any existing frontend pure-helper test location

## Commit traceability

Suggested commit subject when implementation is complete:

```text
feat(history): add two-stage smart session titles
```

Commit body/trailer should include:

```text
Refs #184
```

Do not use a closing keyword unless the user explicitly requests closing the issue.
