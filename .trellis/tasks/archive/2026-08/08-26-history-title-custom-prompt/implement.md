# 历史会话智能命名自定义 Prompt · Implementation Plan

## Pre-development gate

- [x] Release-note version confirmed: `V1.3.8`.
- [x] Ran `trellis-before-dev`, loaded the relevant frontend/backend contracts, and re-checked the current diff for overlapping `history_title.rs` or settings work.
- [x] Ran GitNexus upstream impact analysis before code edits and used contract + `rg` fallback for symbols unavailable in the stale graph.
- [x] Warned and paused for the CRITICAL `HistorySmartTitleSettings` impact result before the user explicitly approved continuation.

## Slice 1 — local settings and editor

- [x] Added `customPrompt: string` to `HistorySmartTitleSettings` in `src/lib/types.ts`.
- [x] Added the empty default and a 4096-UTF-8-byte migration/normalization rule in `src/stores/settingsStore.ts`.
- [x] Extended `HistorySourceSettingsPage.tsx` with a local draft `Textarea`, byte/NUL validation, Save, and Restore default controls while preserving Provider/model/switch behavior.
- [x] Added all visible labels, help, buttons, validation, and accessible field copy to both language maps in `src/lib/i18n.ts`.
- [x] Confirmed `src/lib/syncSettings.ts` remains unchanged with `historySmartTitle: "excluded"`.

Rollback point: an empty prompt preserves current behavior and the settings change can be reverted without touching generated title data.

## Slice 2 — backend effective-prompt selection

- [x] Added the bounded custom-prompt setting reader and replaced the positional settings tuple with a named snapshot in `src-tauri/src/commands/history_title.rs`.
- [x] Snapshot settings once per `history_title_generate_async` call and reuse it for initial Provider selection validation, automatic enablement validation, and effective prompt choice; retain the existing fresh completion guard for in-flight result suppression.
- [x] Passed the effective prompt into `request_title` while retaining candidate framing, protocol selection, timeouts, response validation, output sanitizer, and redacted logging.
- [x] Did not add a request field, command registration, database migration, or change to `provider::auxiliary_text.rs`.

Rollback point: clearing the setting selects the existing built-in prompt.

## Slice 3 — tests and contract records

- [x] Added Rust unit coverage for blank/custom/oversized/NUL settings values, exact UTF-8 byte boundaries, and built-in fallback selection.
- [x] Extended focused Node source-contract coverage for the settings default/migration, editor controls, backend-owned prompt selection, and unchanged IPC request shape.
- [x] Updated the smart-title portion of `.trellis/spec/frontend/history-session-contracts.md` with the global/local custom-prompt and default-fallback contract.
- [x] Updated `CHANGELOG.md` under `V1.3.8` and the relevant History Sessions section in `docs/功能清单.md`.

## Slice 4 — shared production/development SQLite writes

- [x] Root-cause finding: installed production and `npm run tauri dev` intentionally share `cli-manager.db`; existing WAL mode is active, but title persistence used a 5-second deferred read-then-write transaction and could exhaust with `database is locked` during concurrent activity.
- [x] Changed title reserve and finish persistence to `BEGIN IMMEDIATE` and the existing 15-second main-database write budget, so the write slot is obtained before the title row is read.
- [x] Normalized SQLite busy/locked errors to `history_title_database_busy`, retained safe redacted backend logs for database-boundary failures, and mapped manual UI feedback to a localized local-database message instead of Provider/network guidance.
- [x] Corrected the shared database busy hint to state that production and development builds may run together.
- [x] Extended Rust and focused source-contract coverage; documented the persistent cross-process contract in `history-session-contracts.md`.

## Slice 5 — persisted save feedback and non-blocking Provider wait

- [x] Confirmed the Prompt Save action awaits the existing Tauri Store write and identified the correct post-persistence success boundary.
- [x] Confirmed `history_title_generate` is the only long-running smart-title command that wraps the async Provider request in a synchronous `block_on`; list/clear/cancel do not perform Provider HTTP work.
- [x] Added localized save success/failure feedback and a short in-flight Save guard without changing the stored Prompt shape.
- [x] Converted only `history_title_generate` to a Tauri `async fn` that awaits a dedicated blocking worker, preserving its command name, request/response payload, provider timeout, queue behavior, and generated-title persistence.
- [x] Added source-contract regression coverage that requires the async command to dispatch the non-`Send` title helper on the dedicated worker and verifies Save feedback occurs after the awaited setting write.
- [x] Added a non-persistent per-session in-flight state as soon as title generation is accepted; list/detail combine it with persisted pending metadata, show a loading indicator, expose `aria-busy`, and block repeated generation until the active request settles.

## Validation

- [x] `npx tsc --noEmit`
- [x] `node --test scripts/historySmartTitleIpc.test.mjs`
- [x] `cd src-tauri && cargo fmt -- --check`
- [x] `cd src-tauri && cargo test history_title --lib`
- [x] `cd src-tauri && cargo check`
- [x] `npm run build`
- [x] `git diff --check`
- [x] Ran `trellis-check` after code changes and `gitnexus_detect_changes()` reported LOW risk with no affected execution flow (the index remains partially stale, so contracts/source review remains authoritative).
- [x] Re-ran `npx tsc --noEmit`, focused Node source-contract tests, `cargo fmt -- --check`, `cargo test history_title --lib`, `cargo check`, `npm run build`, and `git diff --check` after Slice 5. `gitnexus_detect_changes()` reported LOW risk and no affected process, while per-symbol impact remained `UNKNOWN` because FTS cannot resolve smart-title symbols; source/contract fallback remains the authority.
- [x] Re-ran focused Node source-contract tests, `npx tsc --noEmit`, `npm run build`, and `git diff --check` after adding immediate per-session loading feedback. `gitnexus_detect_changes()` reported LOW risk with no affected process; direct impact remains `UNKNOWN` because the FTS index still cannot resolve these symbols.
- [ ] Human manual desktop check: keep the installed app running, launch `npm run tauri dev`, save a custom prompt and verify its success toast, restore default and verify its feedback, then generate a manual title while continuing to switch/filter history for at least three seconds. Confirm the detail button immediately switches to the localized loading icon/label, its list row also shows pending, and a second click is blocked. Also enable automatic naming for a new session and verify `zh-CN`/`en-US` labels plus 24-hour time behavior. The project quality guide prohibits agents from launching the desktop app or making an unapproved real Provider call solely as a test.

## Expected file ownership

| File | Responsibility |
| --- | --- |
| `src/lib/types.ts` | Settings shape |
| `src/stores/settingsStore.ts` | Default and migration validation |
| `src/stores/historyStore.ts` | Smart-title request lifecycle and observable in-flight state |
| `src/components/settings/pages/HistorySourceSettingsPage.tsx` | Prompt editor interaction |
| `src/components/HistoryWorkspace.tsx`, `src/components/history/HistoryListPane.tsx`, `src/components/history/SessionDetailPane.tsx` | In-flight title feedback across the detail action and list row |
| `src/lib/i18n.ts` | Localized copy |
| `src-tauri/src/commands/history_title.rs` | Backend-owned effective prompt selection |
| `scripts/historySmartTitleIpc.test.mjs` and/or focused new test | Regression coverage |
| `.trellis/spec/frontend/history-session-contracts.md` | Durable history-title contract |
| `CHANGELOG.md`, `docs/功能清单.md` | Delivery records |

## Risks and controls

- **Overlapping active work:** inspect live diffs before editing `history_title.rs`; preserve unrelated async/UA changes.
- **Prompt injection / malformed settings:** keep the user message separate, enforce a bounded backend reader, preserve title sanitization, and never log prompt contents.
- **Provider compatibility:** reuse the existing system-instruction parameter rather than branching protocol-specific prompt construction.
- **Settings drift:** make Rust read the same persisted setting the UI writes, instead of trusting a new IPC prompt argument.
