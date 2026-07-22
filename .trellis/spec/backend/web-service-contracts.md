# Web Service Contracts

## 1. Scope / Trigger

- Applies to `apps/server`, `apps/web` transport calls, and `crates/web-protocol`.
- The desktop Device WebSocket adapter may run in the sibling `cli-manager-web-daemon` process. The daemon-to-Tauri loopback protocol is an internal transport; browser and server contracts remain unchanged.
- Trigger this contract when changing Web authentication, pairing, HTTP routes, WebSocket frames, SQLite tables, event sequence handling, or operation states.
- The Web service is a single-process Rust modular monolith. Desktop remains authoritative for projects, files, Git, CLI execution, Hook state, and final operation results.

## 2. Signatures

### HTTP

| Method | Route | Contract |
|---|---|---|
| GET | `/api/health` | Public service health |
| GET | `/api/auth/status` | Optional Cookie -> authentication state |
| POST | `/api/auth/login` | `{username,password}` -> session Cookie |
| POST | `/api/auth/logout` | Revokes current session Cookie |
| GET | `/api/devices` | Authenticated paired devices |
| POST | `/api/pairing/claim` | `{code}` -> claimed device |
| GET | `/api/history` | `deviceId,limit,offset` -> cached summaries |
| POST | `/api/operations` | Creates/idempotently returns an enabled conversation or management operation |
| GET | `/api/operations/{id}` | Returns one user-owned operation |

### WebSocket

- Browser: `/ws/browser?afterSequence=<i64>`; authenticated by browser session Cookie and exact Origin.
- Device: `/ws/device`; first text frame must be `DeviceToServerFrame::Hello` within 10 seconds.
- Shared JSON types are owned by `crates/web-protocol/src/lib.rs`; fields use camelCase, frame/status tags use snake_case.

### Tauri desktop adapter

| Command | Contract |
|---|---|
| `web_device_get_status` | Returns non-secret profile, connection, pairing, queue, and error state |
| `web_device_save_profile` | Saves `serverUrl`, `name`, and `autoStart`; preserves stable `deviceId` |
| `web_device_start/stop/restart` | Controls the Rust-owned device worker independently of React lifecycle |
| `web_device_create_pairing/clear_pairing` | Creates a short-lived code or revokes the credential and rotates `deviceId` |
| `web_device_take_operations` | Returns the bounded, deduplicated desktop operation queue |
| `web_device_publish_history` | Sends a full `HistorySnapshot` |
| `web_device_validate_context` | Canonicalizes native/WSL roots and rejects a `cwd` outside the registered project or Worktree |
| `web_device_operation_accepted/running/completed` | Emits device-authoritative operation state frames |

### SQLite

- Migration owner: `apps/server/migrations/`.
- Migration SQL files must use LF. Before SQLx validation, startup may rewrite an applied migration checksum only when it exactly matches the same embedded SQL with the alternate LF/CRLF representation; any other checksum mismatch must remain an error.
- Required uniqueness: browser token hash, pairing code hash, `(device_id, stream)` cursor, `(user_id, idempotency_key)` operation, browser event sequence.
- Startup must mark persisted devices offline before accepting new connections.

## 3. Contracts

### Environment

| Key | Required | Behavior |
|---|---|---|
| `CLI_MANAGER_ADMIN_PASSWORD` | Yes | No default; Argon2 hash is stored only when creating the first user |
| `CLI_MANAGER_ADMIN_USERNAME` | No | Defaults to `admin` |
| `CLI_MANAGER_WEB_BIND` | No | Defaults to `127.0.0.1:8787` |
| `CLI_MANAGER_WEB_DATA_DIR` | No | SQLite data directory |
| `CLI_MANAGER_WEB_DIST` | No | Defaults to `apps/web/dist` relative to the server manifest |
| `CLI_MANAGER_COOKIE_SECURE` | Conditional | Must be true for non-loopback bind |
| `CLI_MANAGER_WEB_ALLOWED_ORIGIN` | No | Exact credentialed CORS and Browser WebSocket Origin |

### Authentication and pairing

- Browser session Cookie is `HttpOnly`, `SameSite=Strict`, path `/`, seven-day max age; `Secure` follows configuration.
- Device tokens are random secrets; SQLite stores SHA-256 hashes only.
- Pairing codes are normalized to 6-12 ASCII letters/digits, short-lived, and single-use.
- If token delivery to the live device queue fails, the pairing claim must be rolled back; do not leave a paired device that never received its token.

### Device connection

- Validate protocol version and hello field bounds before persisting hello data.
- A paired device must prove its token before `upsert_device_hello` can mark it online.
- An unpaired device may send only pairing offers and heartbeat frames.
- Replacing a device connection shuts down the older generation; only the current connection may ingest state.
- Device send queues are bounded. Queue failure closes the connection; cleanup marks the current generation offline.
- Desktop keeps delivered operations until a server `OperationAck` confirms the state update. If the local operation queue overflows, it keeps the connection alive long enough to consume ACKs, then reconnects after capacity is recovered so the server can resend deferred operations.
- History snapshot sequence is per `(device, history)` and full snapshots replace missing sessions atomically.
- Tauri owns `/ws/device`, heartbeat, reconnect, pairing, history, and outbound queues in Rust; hiding, minimizing, or unmounting a settings component must not stop the connection.
- When `cli-manager-web-daemon` is available, it owns `/ws/device`, heartbeat, reconnect, pairing, history, and outbound queues; Tauri remains the local operation executor and keeps the existing command/event surface.
- The non-secret profile lives under stable `.cli-manager` app data. `deviceToken` lives only in the native credential store and must never enter a WebView payload, log, SQLite row, or JSON profile.
- Only loopback servers may use `ws://`; remote device servers require `wss://`.

### Browser events

- Subscribe to live broadcast before replaying SQLite events to avoid a replay/live gap.
- Persist browser events before broadcasting them.
- Replay in ascending sequence batches after `afterSequence`; ignore duplicate live sequences.
- If the client cursor exceeds the database latest sequence, replay from zero and send the lower `ready.latestSequence`.
- A lagged/slow browser receives `replay_required` and reconnects with its last successfully consumed sequence.

### Operations

```text
submitted -> waiting_device | accepted | rejected
waiting_device -> accepted | rejected
accepted -> running
running -> succeeded | failed | rejected
non-terminal -> canceled | timed_out
```

- Enabled kinds cover `conversation.*`, `ssh.*`, `file.*`, `git.*`, `worktree.*`, and `hook.*`; the selected device must advertise the matching capability.
- Offline devices reject new operations with `device_offline`; the browser must keep the draft local.
- Same `(user,idempotencyKey)` with different device, kind, or payload returns `idempotency_conflict`.
- An exact idempotency hit is returned before re-checking the device's current capability or online state.
- Only device frames update accepted/running/terminal states. Browser/UI code must never infer success.
- Browser operation payloads explicitly carry `source`, `projectKey`, `cwd`, and `prompt`; `conversation.prompt` additionally carries `sessionId`.
- Before launch, desktop must match the payload against its own history snapshot, registered project/Worktree, CLI source, installed Hook, and canonical path boundary. SSH projects remain rejected in P0.
- Desktop sends the Prompt only after the matching CLI reports `SessionStart`. `Stop` is the success authority and `StopFailure` is the failure authority.
- Pure validation failure or a desktop user denial may transition directly from `submitted/waiting_device` to `rejected`; no side effect may start first.
- `payload.confirmed=true` records browser intent only. Every management write, Git Fetch, and SSH new-host-key acceptance must also receive a native desktop confirmation that cannot be forged by the remote browser.
- Management operations execute serially in the desktop bridge. Files/Git/Worktree paths are resolved from desktop history and registered local state, not from a browser-provided root.
- Operation results use Web-specific DTOs: never return SSH credentials, identity/proxy paths, raw OpenSSH stderr, local Worktree paths, Hook config paths, or database paths.
- Hook `status/test` always use `autoRepair=false`; Web cannot choose Hook directories.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing/expired browser Cookie | HTTP 401 or Browser WS close 4401 |
| Browser WS Origin missing/mismatched | HTTP 403 `origin_required` / `origin_forbidden` |
| Wrong device protocol/token/first frame | WS policy/auth close |
| Device sequence exceeds `i64` or repeats | Reject overflow; duplicate snapshot is acknowledged without rewriting |
| Invalid/expired/used pairing code | `invalid_pairing_code`, `pairing_code_expired`, `pairing_code_used` |
| Pairing device disconnects before token queueing | Roll back claim; `device_disconnected` |
| Unknown user device | `device_not_found` |
| Offline user device | `device_offline` |
| Unsupported operation or blank prompt | `unsupported_operation_kind` / `invalid_operation_payload` |
| Missing browser intent flag for a managed write | `operation_confirmation_required` before dispatch |
| Desktop user rejects a managed write | Terminal `rejected` with no local side effect |
| Local operation queue reaches its bound | Defer excess requests, consume ACKs, reconnect after capacity recovers |
| History tuple or resume session does not match desktop history | `history_context_not_found` / `invalid_session_id` |
| Missing project/Worktree, source mismatch, SSH target, or Hook unavailable | Structured desktop rejection without launching a command |
| Canonical `cwd` escapes the registered native/WSL root | Reject before operation execution |
| Remote plaintext device URL | Reject profile/start; only loopback may use `ws://` |
| Invalid state jump | `invalid_operation_transition` |
| Applied migration checksum differs only by LF/CRLF | Rewrite to the embedded migration checksum, then run normal SQLx validation |
| Applied migration checksum differs by SQL content | Preserve SQLx `VersionMismatch`; never auto-repair |
| Unknown `/api/*` path | JSON 404; never SPA `index.html` |

## 5. Good / Base / Bad Cases

- Good: browser reconnects with sequence 42, receives persisted events 43..N, then live events without gaps or duplicates.
- Good: online operation stays submitted until desktop accepted/running/final frames arrive.
- Base: dispatch races with a disconnect; operation becomes `waiting_device` and is resent after device reconnect.
- Base: service restarts; cached history remains readable, all devices start offline, and no Redis state is required.
- Base: a Windows checkout changes an applied migration from LF to CRLF; startup repairs only that byte-level line-ending drift and continues.
- Base: the window is hidden while the Rust worker remains connected; queued operations are delivered when the WebView bridge is ready.
- Base: the renderer reloads after an operation reached accepted/running; the server resends it and desktop reports `operation_interrupted` instead of executing it again.
- Base: 129+ operations arrive; the first queue remains bounded, ACKs still drain, and deferred operations are recovered on reconnect.
- Bad: mark a paired device online before validating its token.
- Bad: return pairing success after DB claim if the device token could not enter the live queue.
- Bad: trust browser `cwd/sessionId`, build a resume command before validation, or store `deviceToken` in frontend state.
- Bad: allow `submitted -> succeeded`, trust browser-provided success, or serve SPA HTML for an unknown API route.
- Bad: treat `payload.confirmed` as authorization, expose native paths/SSH stderr in results, or remove a local operation before its server ACK.
- Bad: overwrite `_sqlx_migrations.checksum` for an unknown mismatch or rerun an already-applied migration.

## 6. Tests Required

- `cargo fmt --manifest-path apps/server/Cargo.toml --check`.
- `cargo check --manifest-path apps/server/Cargo.toml`.
- `cargo test --manifest-path apps/server/Cargo.toml` with assertions for:
  - Argon2 and Cookie flags.
  - pairing normalization.
  - strict operation transitions.
  - full history snapshot replacement.
  - newer device connection generation replacing the old one.
  - health, protected route, and JSON API fallback routing.
  - known LF/CRLF migration checksum drift is repaired while unknown drift remains `VersionMismatch`.
- `cargo test --manifest-path crates/web-protocol/Cargo.toml` to lock camelCase fields, snake_case statuses, and dotted browser event names.
- `npm run web:typecheck` and `npm run web:build`.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path src-tauri/Cargo.toml web_device` with assertions for URL TLS policy, profile/token serialization, queue bounds/deduplication, profile replacement, and native path boundary rejection.
- `npx tsc --noEmit` and `npm run build` for the desktop bridge and settings integration.
- Contract review: Rust camelCase/snake_case payloads must match `apps/web/src/domain.ts` and `webClient.ts`.
- Management contract review: server enabled kinds, desktop `MANAGEMENT_KINDS`, Web controls, capabilities, and confirmation sets must match exactly.

## 7. Wrong vs Correct

### Wrong

```rust
// Marks a paired device online before token verification and allows a direct terminal jump.
storage.upsert_device_hello(...).await?;
storage.update_operation_status(device_id, id, OperationStatus::Succeeded, ...).await?;
```

```typescript
// Wrong: browser-provided context is used directly in a shell command.
const command = `codex resume ${payload.sessionId}`;
createSession(undefined, payload.cwd, command);
```

### Correct

```rust
// Correct: repair only an exact alternate-line-ending checksum, then let SQLx validate normally.
repair_migration_line_endings(&pool).await?;
sqlx::migrate!("./migrations").run(&pool).await?;
```

```rust
let owner = storage.device_user_id(device_id).await?;
if owner.is_some() && !storage.verify_device_token(device_id, token_hash).await? {
    return Err(auth_error);
}
storage.upsert_device_hello(...).await?;
// Success is accepted only after the persisted state reached Running.
storage.update_operation_status(device_id, id, OperationStatus::Succeeded, ...).await?;
```

```typescript
// Correct: match desktop history/project state, validate the canonical root,
// then wait for SessionStart before writing the prompt.
await webDeviceApi.validateContext(project.path, payload.cwd);
// Browser intent is not sufficient for writes; obtain native desktop approval first.
await webDeviceApi.accepted(operation.id);
await webDeviceApi.running(operation.id);
```
