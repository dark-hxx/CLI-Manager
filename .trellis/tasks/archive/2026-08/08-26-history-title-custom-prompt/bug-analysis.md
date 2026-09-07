## Bug Analysis: Smart-title generation reported Provider/network failure during shared SQLite contention

### 1. Root Cause Category

- **Category**: B / D / E — cross-layer error contract, integration coverage gap, and an implicit single-writer assumption.
- **Specific Cause**: The installed app and `npm run tauri dev` are intentionally separate single-instance domains that share `cli-manager.db`. Smart-title reserve and finish opened a deferred SQLite transaction, read a row, then attempted to write with only a five-second busy timeout. A concurrent writer could make that upgrade fail with `SQLITE_BUSY` / `database is locked`; the IPC error then reached the frontend generic Provider/model/network toast.
- **Evidence**: The shared database reports WAL mode; application logs contain concurrent main-database writes that fail after approximately five seconds with SQLite code 5; the title command had the same five-second timeout and no busy-specific mapping. A successful title row/provider HTTP 200 exists independently, ruling out a blanket Provider configuration failure.

### 2. Why Fixes Failed (if applicable)

1. **Initial hypothesis — settings selection drift**: Production and development processes sharing `settings.json` made this plausible, but the current frontend maps selection drift to the Provider-selection toast, not the generic Provider/network toast reported by the user.
2. **Surface-only UI fallback**: Rewording the generic toast would have hidden the real persistence failure and left the title row transaction vulnerable; the repair therefore lands at the SQLite transaction/error boundary first.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | Use `BEGIN IMMEDIATE` for smart-title reserve/finish read-then-write mutations. | DONE |
| P0 | Runtime contract | Use the 15-second main-database busy budget and map busy/locked to `history_title_database_busy`. | DONE |
| P0 | Error UX | Render a localized local-database message rather than Provider/network guidance. | DONE |
| P1 | Regression coverage | Assert busy-code recognition, timeout value, two immediate transactions, and UI mapping. | DONE |
| P1 | Documentation | Record the supported shared production/development database behavior in the history contract and cross-layer guide. | DONE |

### 4. Systematic Expansion

- **Similar Issues**: `ssh_integration.rs` also uses a five-second main-database busy timeout, but it already maps busy failures to stable SSH metadata codes. `history.rs`, `db_repair.rs`, and other main-history write paths use a 15-second budget and/or `BEGIN IMMEDIATE` where their transaction shape needs it.
- **Design Improvement**: Future shared-main-database mutations must analyze transaction upgrade shape, not only connection timeout; use a stable local persistence code at the Rust boundary before deciding any UI copy.
- **Process Improvement**: Treat installed-plus-development concurrent use as a required scenario whenever changing app-data, settings, or main SQLite write behavior.

### 5. Knowledge Capture

- [x] Updated `.trellis/spec/frontend/history-session-contracts.md` with signatures, transaction contract, validation/error matrix, cases, tests, and wrong/correct example.
- [x] Updated `.trellis/spec/guides/cross-layer-thinking-guide.md` with the shared SQLite contention checklist.
- [x] Confirmed `src/templates/markdown/spec/` does not exist, so no template mirror needs synchronization.
- [x] Updated `CHANGELOG.md` and `docs/功能清单.md` under `V1.3.8`.
- [x] Added focused Rust/source regression coverage.

## Bug Analysis: Smart-title Provider wait froze the desktop for several seconds

### 1. Root Cause Category

- **Category**: B / E — Tauri IPC execution-context mismatch and asynchronous integration coverage gap.
- **Specific Cause**: `history_title_generate` was declared as a synchronous `#[tauri::command]` and called `tauri::async_runtime::block_on(history_title_generate_async(request))`. The helper awaits the Provider HTTP request, so a normal multi-second network wait occupied Tauri's blocking command handler instead of its async responder.
- **Evidence**: The Tauri 2.10.3 command macro emits a direct blocking response path for a synchronous command, while an `async fn` command uses `respond_async_serialized`. Local source confirms `request_title(...).await` is on the title path and the UI already invokes the command through a Promise. The project has working async command examples for model network requests.

### 2. Why Fixes Failed (if applicable)

1. **Frontend-only async appearance is insufficient**: `invoke(...)` already returns a Promise and the click handler does not await it synchronously. That cannot change the Rust macro's synchronous execution context.
2. **Changing Provider/network feedback is not a fix**: The delay is expected for a Provider request; adding a timeout or error toast at the UI layer would neither release the blocking command handler nor preserve normal slow-request behavior.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | IPC execution contract | Keep the long-running `history_title_generate` entrypoint as `async fn` and await a dedicated blocking worker for the non-`Send` internal helper. | DONE |
| P0 | UX feedback | Show Prompt Save success only after the settings write settles; prevent duplicate writes while it is pending. | DONE |
| P1 | Regression coverage | Assert the title command is async, awaits its helper, and contains no `block_on`; assert Save success follows the awaited write. | DONE |
| P1 | Durable contract | Record the Tauri execution-context and persisted-save-feedback rules in the history-session contract. | DONE |

### 4. Systematic Expansion

- **Similar Issues**: `history_title_list_providers`, `history_title_clear`, and `history_title_cancel` still use synchronous wrappers, but they do not hold a Provider HTTP request. This repair deliberately changes only generation; any future long-running command must be checked independently for its execution context.
- **Design Improvement**: Treat a WebView Promise and a Rust Tauri async command as two distinct boundaries. When an existing helper is non-`Send`, make the command await a dedicated blocking worker rather than moving `block_on` back into the synchronous IPC path.
- **Scenario Coverage**: Fast, delayed, timeout, failure, manual, automatic, duplicate-click, session switching, and installed-plus-dev shared-data cases retain the same request/queue/persistence contracts; only the command responder changes.

### 5. Knowledge Capture

- [x] Updated `.trellis/spec/frontend/history-session-contracts.md` with async command, save-feedback, validation, tests, and wrong/correct examples.
- [x] Updated `.trellis/spec/guides/cross-layer-thinking-guide.md` with the WebView-Promise versus Rust-command execution-context check.
- [x] Updated the V1.3.8 release record and feature inventory.
- [x] Added focused source-contract coverage without issuing a real Provider request.
- [x] Confirmed `src/templates/markdown/spec/` does not exist, so no template mirror needs synchronization.

## Bug Analysis: Smart-title button showed no feedback while the Provider request was running

### 1. Root Cause Category

- **Category**: B / E — renderer state-timing gap across the store-to-component boundary.
- **Specific Cause**: `generateSmartTitle` already held an internal `smartTitleRequestKinds` duplicate guard, but that `Map` is not Zustand state. The UI only rendered `generatedTitle.state === "pending"`, while the single `history_title_generate` invoke returns its metadata only after the Provider request completes. Therefore no observable state changed between the click and the terminal response.
- **Evidence**: The detail button and list row both check persisted/hydrated `generatedTitle?.state`; the store wrote that metadata only after `await invoke(...)`. The request guard was populated before the wait but was invisible to React.

### 2. Why Fixes Failed (if applicable)

1. **Making the Rust command asynchronous fixed responsiveness, not feedback**: The application could remain interactive during the wait, but no renderer-facing state described that the request was active.
2. **Waiting for backend pending metadata is insufficient**: The command deliberately preserves its single terminal IPC response and does not emit an intermediate event. Adding an optimistic generated title would misrepresent persistence and could overwrite existing title data.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Observable in-flight state | Store the accepted session key in non-persistent Zustand state before detail/candidate/Provider awaits and clear it only for the request that still owns the trigger. | DONE |
| P0 | UI feedback | Combine in-flight and hydrated pending state in list/detail; show the existing localized pending label and loading icon, set `aria-busy`, and disable duplicate generation/clear actions. | DONE |
| P1 | Race safety | Preserve the key when a manual request replaces automatic work, so an older request's `finally` cannot clear the newer loading state. | DONE |
| P1 | Regression coverage | Assert store lifecycle and both UI consumers reference the observable in-flight state. | DONE |

### 4. Systematic Expansion

- **Similar Issues**: Any one-shot IPC request that returns only a terminal result cannot use terminal metadata as its immediate loading signal. The store/action layer must expose an in-flight state when the UI needs feedback before the response.
- **Scenario Coverage**: Manual and automatic requests, slow/fast/failing Provider calls, request cancellation, a manual request taking over an automatic request, session switching, list virtualization, and duplicate clicks all use the same per-session state without changing queue or title persistence semantics.

### 5. Knowledge Capture

- [x] Updated `.trellis/spec/frontend/history-session-contracts.md` with the in-flight ownership and detail/list feedback contract.
- [x] Updated the V1.3.8 release record and feature inventory.
- [x] Added focused source-contract coverage without issuing a real Provider request.
