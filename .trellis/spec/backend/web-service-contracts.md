# Web Service Contracts

## 1. Scope / Trigger

- Applies to `apps/server`, `apps/web` / `apps/web-tap` transport calls, shared browser primitives under `src/shared`, and `crates/web-protocol`.
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
| GET | `/tap/` or `/tap/s/{sessionId}` | Optional Tap SPA; session links never bypass authenticated inventory |

`terminal.transcript` is a read-only operation with capability `terminal.transcript`:

```typescript
// POST /api/operations with the usual owned deviceId and idempotencyKey
{ kind: "terminal.transcript", payload: { projectId, worktreeId?, sessionId, before? } }
// result (PTY sessionId is not the CLI's conversation ID)
{ available: boolean, reason?: "unbound" | "missing" | "unsupported",
  cliSessionId?: string, start: number, total: number,
  messages: Array<{ id: string, role: "user" | "assistant", text: string,
    truncated?: boolean, at?: string, model?: string }> }
```

`terminal.transcript_events` is the read-only structured transcript behind the Tap conversation view, with capability `terminal.transcript_events`. `terminal.transcript` stays for older servers and pages:

```typescript
{ kind: "terminal.transcript_events", payload: { projectId, worktreeId?, sessionId, cursor? | before? } }
// cursor/before: mutually exclusive byte offsets (0..=2^40) into the CLI's own transcript file
// result: field names are owned by `src-tauri/transcript-core` (`Transcript`, `Event`)
{ parser: number, available: boolean, reason?: "unbound" | "missing" | "unsupported",
  agentSessionId?: string, start: number, cursor: number, size: number, reset?: boolean,
  more: boolean, partial?: boolean, events: Array<{ kind: string, ... }> }
```

### WebSocket

- Browser: `/ws/browser?afterSequence=<i64>`; authenticated by browser session Cookie and exact Origin.
- Device: `/ws/device`; first text frame must be `DeviceToServerFrame::Hello` within 10 seconds.
- Shared JSON types are owned by `crates/web-protocol/src/lib.rs`; fields use camelCase, frame/status tags use snake_case.

### Tauri desktop adapter

| Command | Contract |
|---|---|
| `web_device_get_status` | Returns non-secret profile, connection, pairing, queue, and error state |
| `web_device_save_profile` | Saves `serverUrl`, `name`, and `autoStart`; preserves the channel-specific stable `clientId` |
| `web_device_start/stop/restart` | Controls the Rust-owned device worker independently of React lifecycle |
| `web_device_create_pairing/clear_pairing` | Creates a short-lived code or revokes the credential and rotates `clientId` |
| `web_device_take_operations` | Returns the bounded, deduplicated desktop operation queue |
| `web_device_publish_history` | Publishes bounded history summaries plus a workspace snapshot; `workspace` contains desktop groups, projects, Worktrees, and their display cwd for authenticated device owners. IDs remain opaque |
| `web_device_validate_context` | Canonicalizes native/WSL roots and rejects a `cwd` outside the registered project or Worktree |
| `web_device_operation_accepted/running/completed` | Emits device-authoritative operation state frames |
| `web_server_get_status` | Returns managed Web service state, effective URL, Origin, and network exposure flag |
| `web_server_save_config` | Persists startup mode, validated local-interface bind, port, Origin, and admin username; optional password is stored in the native credential store |
| `web_server_start/stop/restart` | Manually controls the embedded Web service without requiring `npm` or a visible console |

### SQLite

- Migration owner: `apps/server/migrations/`.
- `devices.workspace_snapshot_json` stores the latest accepted `WorkspaceSnapshot` as one atomic JSON document. Project/Worktree cwd is retained for terminal identification, but only authenticated users with ownership of the requested device can retrieve it; the snapshot must not contain environment variables, startup commands, SSH credentials, identity paths, or provider secrets.
- `devices.id` remains the connection key and stores the effective software `clientId`; `devices.machine_id` groups software instances on one computer and `devices.client_kind` distinguishes `development` from `release`.
- Migration SQL files must use LF. Before SQLx validation, startup may rewrite an applied migration checksum only when it exactly matches the same embedded SQL with the alternate LF/CRLF representation; any other checksum mismatch must remain an error.
- Required uniqueness: browser token hash, pairing code hash, `(device_id, stream)` cursor, `(user_id, idempotency_key)` operation, browser event sequence.
- Startup must mark persisted devices offline before accepting new connections.
- Finished `terminal.transcript` and `terminal.transcript_events` operations, with their `operation.updated` browser events, are deleted two minutes after completion; events are selected by the IDs of the operations being deleted, so a transcript operation still waiting or running keeps all of its events. Pruning runs when a new transcript operation arrives, at most once per 30 seconds; other operation kinds keep their existing retention.

## 3. Contracts

### Optional Tap client and native transcript

- `/` remains Classic Web; `/tap/` has its own Vite app and SPA fallback. `/tap/assets/*` misses return 404, never either client's HTML. Unknown `/api/*` remains JSON 404. `web:build` builds Classic first, then Tap to `apps/web/dist/tap`; Tauri/portable consume that same dist root. A Classic-only workspace build deletes nested output, so packaging must use the root script.
- Tap sidebar and session picker preserve workspace group hierarchy (`parentId`/`groupId`) and mixed sibling `sortOrder`; same-name projects keep distinct IDs and display paths for disambiguation. Search retains ancestor groups and matching projects without sessions. Orphan groups fall back to root, cyclic parent edges are broken without losing registered projects, and collapse state is scoped to account/device. Session ownership and start requests remain keyed by project/worktree IDs, never display names or cwd.
- Tap sidebar defaults to expanding only live-terminal projects and their ancestor groups, while keeping the currently viewed session reachable. Empty inventory defaults to collapsed; explicit user expansion choices survive status refresh, and search expansion is temporary. Project icons/arrows/counts must not shrink or inherit text truncation; long names/paths only truncate inside their own label container.
- Both clients reuse the Cookie, device ownership/mobile scope, existing PTY and operation state machine. Shared browser HTTP/socket/types/stream/image primitives live in `src/shared`; Classic compatibility exports retain its directory-cache and file-operation side effects. No client imports the other's app model or view components.
- Tap sends registered project/Worktree IDs to `project.start`, then attaches the returned native PTY ID. Chat submission stays PTY input, not `conversation.start/prompt`; native permissions remain in the CLI. Browser detach and mounted-terminal eviction never close the process. Close confirmation freezes the account/device/session ID and displayed title when opened; a late project start or session switch must not retarget it.
- Transcript host resolves the current local project/Worktree and PTY tuple. SSH, remote handoff and non-PTY sessions are rejected. Only the exact host-owned `cliSessionId` may be read; match history source/CLI ID/canonical cwd, then revalidate the binding and root after asynchronous history I/O. Never substitute the latest session in a directory. Only Claude/Codex is supported in this operation.
- Legacy `terminal.transcript` pages cover at most 40 source messages, `before` is a nonnegative integer ≤10,000,000, and message text is capped at 4000 UTF-16 code units with an explicit truncation marker. If the boundary splits a surrogate pair, omit its trailing high surrogate so Rust JSON remains valid. Only canonical `parts.kind=text` for user/assistant without tool/call metadata crosses the boundary. Tool arguments/results, reasoning, flattened internal content and system messages do not. Existing operation result byte limits still apply.
- Transcript is demand-loaded and refreshed only while visible in response to terminal output. Older pages are explicit and preserve scroll anchor. Unbound/missing/unsupported is an honest read result, not a fabricated conversation. No queue, Push, history-resume or menu automation is implied.
- `terminal.transcript_events` keeps the same binding rules. The desktop resolves the transcript file once per PTY and CLI session ID from the history catalog summary (exact ID, source and canonical cwd), caches it (a cache hit must still match the current project root, so a moved project never reads its old transcript), and backs off 5 seconds (counted from when the lookup finishes) after a miss before refreshing the catalog again; a failing lookup is reported as `transcript_lookup_failed`, never as a new conversation. The native command `history_live_transcript_read` accepts only a file that passes `validate_session_file_ref` and whose file name contains the bound CLI session ID; when a brand-new file is not yet in the 60-second session-file cache (`session_file_not_indexed`), it rescans that source once with `validate_session_file_ref_rescanned`. The desktop revalidates the binding after I/O. It never reuses the general history parser, which drops tool-only and thinking-only lines.
- Reads are byte windows over complete lines, bounded by output rather than raw size: the latest window and `before` pages scan up to 4 MiB of raw transcript and keep only the newest lines whose events fit 512 KiB of JSON (`start` is then the first kept line); `cursor` reads up to 8 MiB of new lines and stops before the line that would exceed 512 KiB, setting `partial` so the client reads again at once. Falling more than 8 MiB behind returns the latest window with `reset`. At least one line is always kept, so reads always advance; a single line whose events alone exceed the budget is degraded first (diffs and ANSI dropped, long text cut to 4000 characters, results marked `truncated`, task lists cut to 30 items with 200-character subjects), and if it still does not fit, only its leading events that fit are kept (possibly none), followed by a `notice` with code `line_truncated`, so a page never exceeds the 512 KiB event budget. A `cursor` that falls inside a line is realigned to the next line start. Every event field has a cap (constants in `transcript-core`), and the desktop still rejects a result above 650 KiB as `transcript_too_large`. Clients discard held events when `parser` or `agentSessionId` changes.
- Events carry user/assistant text, recorded thinking, bounded tool inputs/outputs and diffs, plans/tasks, slash commands and output, errors and notices. Notices may carry a stable `code` that clients localize; parsers never emit UI-language text. Events that have a `uuid` field but no value get a positional key `pos:<line offset>:<index>`, so client keys stay stable across paging and rereads. An unavailable page never resets a held cursor, and repeated failures while content is held show a retry notice instead of freezing silently. Images are counts only, and per-turn cost, statusLine, queue and menu automation are absent in this phase. Tap polls only while the chat view is visible: about every 1.2 seconds while the session runs, once for an ended session.
- Tap keeps at most three terminal mounts. Adjacent same-grid frames coalesce up to 256 KiB of encoded data without crossing reset/grid boundaries. A document-wide scheduler starts one batch per animation frame, yields after three visible batches to waiting hidden work and uses a hidden/stalled-rAF timer fallback. Rendered cursor advances only after xterm's write callback and the final fragment. The browser mirror never answers host terminal queries or resizes a desktop-owned grid. A bounded render queue failure disables that session's input and offers explicit replay. Retry remounts only the failed renderer, never cached siblings; never silently drop output or retry input.
- Draft/selection storage is local and scoped by account/device/session. Account/device changes cancel operations and clear sockets, subscriptions and mounted sensitive content. Delayed input/resize/close callbacks retain their captured account/device/auth generation, even if opaque terminal IDs collide. A disposed workspace HTTP flight must ignore all errors, including a 401 whose headers arrived before aborting its body; it cannot expire a newer scope. Drafts remain local after logout, documented for shared browsers. A session URL is validated against current inventory before restoring; manual reconnect resets selection restoration without resubmitting input.
- Mobile tokens are scrubbed from URL to memory and require explicit confirmation before redemption, including same-document hash navigation. Canceling an authorization screen restores the draft and replays into the remounted terminal instead of reusing its old renderer cursor. Cancellation is disabled during redemption. Native approval is never synthesized from such a token.
- Sheets ignore composing, repeated and default-prevented Escape in the bubble phase. Leaving direct input restores the coarse-pointer textarea readOnly/inputMode policy; failed optional font loading keeps a resident font and must not reject terminal setup.

### Managed Windows lifecycle and terminal recovery

- All synchronous Web device IPC work (control sockets, credentials, lifecycle waits) runs through `spawn_blocking`, not the UI thread or an async worker doing blocking I/O. Direct native conversation callers retain their blocking implementations on existing background execution paths.
- Loopback control connect uses explicit IPv4 and a 200ms deadline. Failed connects are cooled down for 3 seconds keyed by the complete discovery identity; replacement discovery bypasses old failure state. Never transparently retry a request after writing it, or cache a business error as a connect failure.
- Disconnected/unpaired desktop bridges pause fast operation/terminal polling; a non-overlapping status probe every 3 seconds detects reconnection independently of settings visibility. Cleanup ignores pending status results; slow operations must not block terminal polling.
- PID liveness alone cannot establish helper identity after reboot. Startup treats an observable non-Web-daemon executable as stale discovery, but preserves unknown/inaccessible identities and never kills an unrelated process.
- Test embedded Web networking with `src-tauri/Cargo.lock`, not only the standalone server lock. The desktop must retain mio 1.2.2 or a newer version containing atomic `WSA_FLAG_NO_HANDLE_INHERIT` socket creation; inheritable listener/client/accepted sockets leak into helpers launched after the service starts and can retain a port after successful thread shutdown.
- Managed start/stop/restart/config application is serialized. A timed-out stop retains its worker handle, reports `stopping`, and forbids another start until cleanup completes. UI status refresh must not overwrite unsaved connection configuration.
- Desktop Web server/device forms initialize from status only before editing. Background events, polling, failed actions and lifecycle results update runtime status without replacing drafts. Successful saves reconcile only the submitted draft revision; newer edits survive. Non-loopback HTTP/WS setup exposes the relevant advanced settings and localized guidance; listener/device trust remain separate explicit opt-ins, never inferred from LAN/overlay addresses.
- Terminal bridges split individual large frames before encoding, preserve original byte order/dimensions and ACK only after the final fragment of the original output frame has been queued. Detached/retired output queues cannot ACK newer attaches.
- `invalid_terminal_output` is a recoverable session output failure: notify the browser with terminal error status and retain the device connection. Diagnostics contain bounds/size/dimensions, never terminal contents. Authentication and other protocol rejection remain fatal. Local Web helper protocol 6 supports restricted inspection/shutdown upgrades from 1–5.

### Environment

| Key | Required | Behavior |
|---|---|---|
| `CLI_MANAGER_ADMIN_PASSWORD` | Yes | No default; Argon2 hash is stored only when creating the first user |
| `CLI_MANAGER_ADMIN_USERNAME` | No | Defaults to `admin` |
| `CLI_MANAGER_WEB_BIND` | No | Defaults to `127.0.0.1:8787` |
| `CLI_MANAGER_WEB_PORT` | No | Overrides only the port in the bind address; valid range is 1-65535 |
| `CLI_MANAGER_WEB_BIND_FILE` | No | Optional TOML file path; defaults to `<data-dir>/web-server.toml` |
| `CLI_MANAGER_WEB_DATA_DIR` | No | SQLite data directory |
| `CLI_MANAGER_WEB_DIST` | No | Defaults to `apps/web/dist` relative to the server manifest |
| `CLI_MANAGER_COOKIE_SECURE` | Conditional | Must be true for non-loopback bind unless trusted-network mode was explicitly enabled |
| `CLI_MANAGER_WEB_TRUSTED_NETWORK` | No | Explicitly allow non-loopback HTTP on a trusted network; defaults to false |
| `CLI_MANAGER_WEB_ALLOWED_ORIGIN` | No | Exact credentialed CORS and Browser WebSocket Origin |

The server also accepts `--bind host:port` and `--port number`. Precedence is command line > environment > `web-server.toml` > defaults. The final value is parsed as a `SocketAddr`; invalid or zero ports fail startup. Management result payloads are bounded before crossing the device WebSocket so oversized file previews and diffs fail with a stable error instead of disconnecting the device.

### Authentication and pairing

- Browser session Cookie is `HttpOnly`, `SameSite=Strict`, path `/`, seven-day max age; `Secure` follows configuration.
- Device tokens are random secrets; SQLite stores SHA-256 hashes only.
- Pairing codes are normalized to 6-12 ASCII letters/digits, short-lived, and single-use.
- Desktop status clears an expired pairing code in both the in-process and helper-daemon paths; the settings UI refreshes at the expiry boundary and never presents an expired code as usable.
- If token delivery to the live device queue fails, the pairing claim must be rolled back; do not leave a paired device that never received its token.

### Device connection

- Validate protocol version and hello field bounds before persisting hello data.
- New clients send stable `clientId`, shared `machineId`, and `clientKind`. They also mirror `clientId` into legacy `deviceId`, so older servers still treat Dev and installed builds as separate connections. Servers accept an older hello without the new fields by using `deviceId` as the effective client identity.
- A paired device must prove its token before `upsert_device_hello` can mark it online.
- An unpaired device may send only pairing offers and heartbeat frames.
- Replacing a device connection shuts down the older generation; only the current connection may ingest state.
- Device send queues are bounded. Queue failure closes the connection; cleanup marks the current generation offline.
- Desktop keeps delivered operations until a server `OperationAck` confirms the state update. If the local operation queue overflows, it keeps the connection alive long enough to consume ACKs, then reconnects after capacity is recovered so the server can resend deferred operations.
- Workspace publication reuses the per-device history sequence and sends bounded history summaries plus the desktop workspace snapshot (groups, projects, and Worktrees). The server stores both atomically with the accepted sequence; `/history` returns the latest summaries and workspace separately. Legacy frames without `workspace` remain valid.
- Tauri owns `/ws/device`, heartbeat, reconnect, pairing, history, and outbound queues in Rust; hiding, minimizing, or unmounting a settings component must not stop the connection.
- When `cli-manager-web-daemon` is available, it owns `/ws/device`, heartbeat, reconnect, pairing, history, and outbound queues; Tauri remains the local operation executor and keeps the existing command/event surface.
- The non-secret installed profile is `.cli-manager/web-device.json`; Dev uses `.cli-manager/web-device.dev.json`. Both share `.cli-manager/machine-id`, while each profile owns a distinct stable `clientId`. `deviceToken` is keyed by `clientId` in the native credential store and must never enter a WebView payload, log, SQLite row, or JSON profile.
- Device connections outside loopback require HTTPS/WSS unless the user explicitly enables that profile's trusted-network HTTP/WS mode. Public browser HTTP origins use the same device-profile opt-in; the managed listener has a separate trusted-network flag.
- The embedded desktop Web service defaults to loopback and manual startup. A non-loopback bind must be a current local-interface IP or an explicit unspecified address, and must use an exact browser Origin; `autoStart` remains independent from the Web device connection's `autoStart`.
- When an Origin is still the automatically derived URL of the previous concrete listener, changing bind/port updates it to the new listener. Explicit custom domains, reverse-proxy Origins and Origins paired with unspecified binds remain authoritative.

### Browser events

- Subscribe to live broadcast before replaying SQLite events to avoid a replay/live gap.
- Persist browser events before broadcasting them.
- Replay in ascending sequence batches after `afterSequence`; ignore duplicate live sequences.
- If the client cursor exceeds the database latest sequence, replay from zero and send the lower `ready.latestSequence`.
- A lagged/slow browser receives `replay_required` and reconnects with its last successfully consumed sequence.
- Historical `history.updated` events below the initial replay high-water sequence are invalidations, not data: skip them because `ready` triggers the current HTTP snapshot. Retain the high-water event to let clients advance their cursor. Conversation/operation events remain ordered and replayable.
- Browsers coalesce invalidations into one request pair per device plus at most one delayed follow-up. Selection does not own WebSocket lifetime. `heartbeat` is emitted every 15 seconds; after ready, 45 seconds without frames triggers reconnection. Handshake/ready is bounded to 10 seconds.
- Managed shutdown explicitly cancels upgraded browser/device WebSocket handlers, including replay and first hello waits. Dropping the HTTP serve future alone is not considered socket cleanup.

### Operations

#### Read-only Web Git panel (1.4.1)

- `git.repositories`, `git.history`, `git.commit_detail`, `git.commit_diff` use `git.management`; they do not require write confirmation. Existing Git writes retain both browser intent and native confirmation.
- Browser sends registered project/worktree IDs, optional `repository` (root is empty), full commit OIDs/cursor and repository-relative paths. `git.status` / `git.diff` also accept the same optional repository. Desktop resolves nested repositories from bounded discovery, validates canonical context on every read, and never returns absolute repository paths.
- History uses the existing 50-item cursor page; detail and Diff are fetched only when selected. Rename Diff carries both path and oldPath. No automatic Fetch, mutations, SSH fallback or desktop Git Store changes.
- Browser renders a complete bounded snapshot text preview, not a second parsed/editable Diff implementation; importing the desktop Viewer would pull desktop settings/terminal-theme dependencies into the standalone Web app. Large/binary Diff is an explicit error, never silently truncated.
- Directory cache remains memory-only and bounded (96 directories/~4MiB), fresh 30s and retained 10min. Background refresh with existing data and speculative prefetch must not show a loading spinner; failures keep stale data plus explicit error. Hover/focus prefetch is idle-only, 180ms delayed, capped at six directories per mounted panel and never recursive.

```text
submitted -> waiting_device | accepted | rejected
waiting_device -> accepted | rejected
accepted -> running
running -> succeeded | failed | rejected
non-terminal -> canceled | timed_out
```

- Enabled kinds cover `conversation.*`, `project.tree.reorder`, `ssh.*`, `file.*` (including `file.read_text` and `file.read_image`), `git.*` (including `git.diff`), `worktree.*`, and `hook.*`; the selected device must advertise the matching capability.
- Offline devices reject new operations with `device_offline`; the browser must keep the draft local.
- Same `(user,idempotencyKey)` with different device, kind, or payload returns `idempotency_conflict`.
- An exact idempotency hit is returned before re-checking the device's current capability or online state.
- Only device frames update accepted/running/terminal states. Browser/UI code must never infer success.
- Browser conversation payloads carry `source`, the opaque registered `projectId`, optional `worktreeId`, and `prompt`; `conversation.prompt` additionally carries `sessionId`. They never carry a local path or project key.
- The project tree is the browser's single authoritative project/Worktree selector. The desktop header only displays that context; project/Worktree quick-start synchronizes it before later conversation or management requests.
- Before launch, desktop matches the registered project/Worktree, CLI source and canonical path boundary. `conversation.prompt` additionally matches desktop history and rejects sessions owned by a live terminal. Rust owns the child process, structured handshake, approval and completion; Hook installation and renderer visibility are not prerequisites. SSH conversations remain rejected.
- `conversation.history` resolves a locally indexed session and sends only user/assistant text after source/session/cwd validation. It does not launch a CLI or upload tool arguments. History is uploaded only when selected, not in background workspace snapshots.
- Device `conversation_event` frames carry operation/session/project/source IDs, a per-operation sequence starting at 1, kind, optional message ID/text and timestamp. Storage commits the event and `conversation.updated` replay item atomically before an exact-sequence `conversation_ack`. Device outboxes retain message and operation frames until ACK, and replay unacknowledged frames after reconnect.
- GET `/api/conversations?deviceId=...` lists synchronized conversations; GET `/api/conversations/{sessionId}?deviceId=...` returns persisted events. Queries validate the current account, device owner and optional mobile device scope. Message storage has no automatic expiry, matching browser replay retention; deleting the service database removes this cache.
- `/api/mobile/tickets` creates single-use short-lived tokens for logged-in accounts. `/api/mobile/redeem` exchanges a token for an HttpOnly browser Cookie limited to one device. `/api/mobile/sessions` lists authorizations and DELETE `/api/mobile/sessions/{id}` revokes them and signals open sockets to close. Mobile sessions cannot mint tickets, bind devices or access another device.
- Desktop `/api/mobile/device-ticket` and `/api/mobile/device-ticket/revoke` require the current device Bearer credential and matching deviceId; credentials remain in native storage. QR URLs contain only short-lived tokens in the fragment. Local daemon protocol 2 prevents reuse of pre-conversation helpers, and upgrades only helpers with no pending operation.
- Pure validation failure or a desktop user denial may transition directly from `submitted/waiting_device` to `rejected`; no side effect may start first.
- `payload.confirmed=true` records browser intent only. Dangerous management writes, Git Fetch, and SSH new-host-key acceptance must also receive a native desktop confirmation that cannot be forged by the remote browser. `project.tree.reorder` is the only confirmation-free metadata write: desktop validates the complete sibling ID set and group ancestry before persisting it.
- `project.tree.reorder` carries `itemType`, `itemId`, nullable `targetParentId`, and the complete `orderedIds` for that level. Desktop is authoritative, rejects stale/missing/duplicate/colliding IDs and group cycles, then reuses the existing project Store move/reorder actions. Worktrees are never draggable.
- Web project-tree context menus use two management kinds:
  - `project.start`: `{targetType, targetId?, targetIds?, launchMode, direction?}` where `targetType` is `project|worktree|group|selection`, `launchMode` is `internal|external|split`, and `direction` is `horizontal|vertical` for split launch only. A single project/worktree/group quick-start button defaults to `internal`.
  - `project.action`: `{action, targetType, targetId, confirmed?}`. The action prefix must match `targetType`; supported actions are the project/group/Worktree actions exposed by the desktop Sidebar, including directory/files/history/provider, rename/edit, clone, group creation/add/batch/focus/stop, Worktree dependency install/finish/discard, and delete actions.
- `project.start` returns `{launched, sessionIds?, launchMode, direction?}`. `external` returns no session IDs; `split` accepts exactly one target. The desktop resolves every ID from its current Store, applies Worktree provider overrides, and only then creates an internal terminal or opens an external Windows Terminal.
- Management operations execute serially in the desktop bridge. Files/Git/Worktree paths are resolved from registered desktop project/Worktree state, not from history presence or a browser-provided root.
- The Web client sends IDs and display intent only; it may render the read-only cwd supplied by the authenticated workspace response, but never sends that cwd back as operation authority. Environment variables, startup commands, provider credentials, and native confirmation state never cross from the browser. File and Git paths are relative to the selected registered context. `project.action` is dispatched through the desktop Web action bus so existing Sidebar handlers remain the behavior authority.
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
| Invalid project launch target/mode, missing ID, empty selection, or invalid split direction | `invalid_operation_payload` |
| Project/group/Worktree ID is stale or Worktree is missing | `project_not_found` / `group_not_found` / `worktree_not_found` / `worktree_missing` |
| Split launch contains more than one target | `invalid_operation_payload`; no session is created |
| External launch targets an SSH project | `ssh_project_unsupported`; no terminal is opened |
| Project action prefix does not match target type or action is not allowlisted | `invalid_operation_payload` / `unsupported_operation_action` |
| Stale/invalid project tree order or group cycle | `project_tree_conflict` / `invalid_operation_payload`; no partial reorder |
| Missing browser intent flag for a managed write | `operation_confirmation_required` before dispatch |
| Desktop user rejects a managed write | Terminal `rejected` with no local side effect |
| Local operation queue reaches its bound | Defer excess requests, consume ACKs, reconnect after capacity recovers |
| History tuple or resume session does not match desktop history | `history_context_not_found` / `invalid_session_id` |
| CLI exits before emitting `session_started` | Fail only the operation; do not publish a conversation event under the temporary operation ID and do not list it as a resumable session |
| A legacy conversation contains only failure events and no `session_started` | Exclude it from `/api/conversations`; clear a browser-selected session when it is absent from the refreshed resumable set |
| A valid resume session is absent from the desktop UI's current history page | Query by session ID, source, and canonical project cwd; force-refresh the history catalog once before returning `history_context_not_found` |
| Missing project/Worktree, source mismatch, or SSH target | Structured desktop rejection without launching a command; Hook availability does not gate structured conversations |
| Project startup arguments contain a terminal `resume` selector | Strip the terminal selector; use only the validated operation `sessionId` for `thread/start` or `thread/resume` |
| Managed server restarts while browser/device WebSockets are active | Bound graceful shutdown, close remaining connections, release the old SQLite pool, join the old server thread, then bind the replacement |
| Conversation event races with an operation-status writer | Reserve the SQLite writer with `BEGIN IMMEDIATE`; do not upgrade a stale deferred read transaction |
| Canonical `cwd` escapes the registered native/WSL root | Reject before operation execution |
| Remote plaintext device URL | Reject profile/start; only loopback may use `ws://` |
| Invalid state jump | `invalid_operation_transition` |
| Workspace snapshot exceeds item/string bounds or contains an unknown source/environment/status | Reject the whole frame as `invalid_history_snapshot`; do not advance the history sequence |
| Applied migration checksum differs only by LF/CRLF | Rewrite to the embedded migration checksum, then run normal SQLx validation |
| Applied migration checksum differs by SQL content | Preserve SQLx `VersionMismatch`; never auto-repair |
| Unknown `/api/*` path | JSON 404; never SPA `index.html` |
| Tap session deep link is not in authenticated inventory | Do not attach it; show the normal workspace selection |
| Missing transcript project/session IDs, control characters, or fractional/negative/oversized cursor | `invalid_operation_payload` before dispatch |
| `terminal.transcript_events` with both `cursor` and `before`, a non-integer offset, or an offset above 2^40 | `invalid_operation_payload` before dispatch |
| Structured transcript file is outside the history roots or not named after the bound CLI session | Native read fails; no events are returned |
| Transcript PTY belongs to another project/Worktree, is SSH/handoff/non-PTY, or was removed during I/O | `history_context_not_found`; no text returned |
| No exact CLI binding, missing/mismatched history, or unsupported CLI | `available=false` with `unbound`, `missing` or `unsupported`; do not guess |
| CLI binding or project root changed during history I/O | Revalidate and withhold the old content |
| Missing `/tap/assets/*` file | HTTP 404; never Classic or Tap index |
| Tap switches device while an old HTTP 401 body is pending | Ignore the disposed flight; keep the new authenticated scope |
| Tap project start finishes while close confirmation is open | Close only the originally displayed terminal if confirmed |
| Tap cancels mobile authorization or retries one renderer | Restore/replay the affected mount without resending input or unmounting cached siblings |

## 5. Good / Base / Bad Cases

- Good: browser reconnects with sequence 42, receives persisted events 43..N, then live events without gaps or duplicates.
- Good: online operation stays submitted until desktop accepted/running/final frames arrive.
- Good: a desktop project with no history session still appears in the Web tree because project navigation comes from `workspace.projects`, not from `history_sessions`.
- Good: a CLI process that exits during initialize fails its operation without creating a resumable conversation; an old failure-only row is invisible after upgrade.
- Good: restoring a valid session older than the first desktop history page succeeds after an exact catalog lookup and one forced refresh, while source and canonical cwd are still verified.
- Good: Classic Web project navigation never renders session rows; dragging a project or group writes through the desktop Store and the next workspace snapshot confirms the final order. Optional Tap instead groups live PTY sessions beneath registered projects without changing native ordering.
- Good: right-click quick-start sends only a project/group/Worktree ID, and the desktop returns the created session IDs after resolving the current native project state.
- Good: a dangerous context-menu action carries browser intent plus native confirmation; denial produces a terminal rejection without deleting or stopping anything.
- Good: desktop groups and Worktrees preserve their IDs and hierarchy while only safe display/launch context fields cross the device boundary.
- Good: installed and Dev clients run concurrently on one machine with different `clientId` values and the same `machineId`; reconnecting either client does not replace the other connection or workspace snapshot.
- Base: dispatch races with a disconnect; operation becomes `waiting_device` and is resent after device reconnect.
- Base: service restarts; cached history remains readable, all devices start offline, and no Redis state is required.
- Base: an older desktop sends `HistorySnapshot` without `workspace`; the server accepts it and the Web client may fall back to legacy history-derived contexts.
- Base: a Windows checkout changes an applied migration from LF to CRLF; startup repairs only that byte-level line-ending drift and continues.
- Base: the window is hidden while the Rust worker remains connected; queued operations are delivered when the WebView bridge is ready.
- Base: the renderer reloads after an operation reached accepted/running; the bridge checks native conversation ownership and does not execute a live turn again. An interrupted non-running operation is reported instead of blindly replayed.
- Base: 129+ operations arrive; the first queue remains bounded, ACKs still drain, and deferred operations are recovered on reconnect.
- Bad: mark a paired device online before validating its token.
- Bad: return pairing success after DB claim if the device token could not enter the live queue.
- Bad: trust browser `cwd/sessionId`, build a resume command before validation, or store `deviceToken` in frontend state.
- Bad: allow `submitted -> succeeded`, trust browser-provided success, or serve SPA HTML for an unknown API route.
- Bad: treat `payload.confirmed` as authorization, expose native paths/SSH stderr in results, or remove a local operation before its server ACK.
- Bad: overwrite `_sqlx_migrations.checksum` for an unknown mismatch or rerun an already-applied migration.
- Bad: derive the Web project tree from history rows, or upload full desktop `Project` records containing `env_vars`, startup commands, credential references, or provider overrides.
- Bad: let the browser send `cwd`, shell text, environment variables, or a direct delete command; the desktop must resolve the target ID and reuse the native Sidebar action handler.
- Bad: accept a browser-provided partial sibling list, persist Web-only ordering, allow Worktree dragging, or move a group into itself/its descendants.
- Good: Tap reads an exact bound Claude/Codex transcript, keeps input on the same PTY, and exposes native permission menus through terminal keys.
- Good: Tap follows the structured transcript by byte cursor, so each poll parses only new lines and the server drops the result two minutes after it finishes.
- Base: old devices lack `terminal.transcript_events` (or `terminal.transcript`), or a new CLI has no binding yet; Tap explicitly reports unavailable chat or asks to update the desktop, and keeps terminal usable.
- Bad: use a recent-by-cwd conversation as a terminal's chat, expose tool/internal log fields, or export a stale binding after asynchronous I/O.

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
  - active-connection shutdown releases the listener/database, and conversation events wait for a concurrent writer without `SQLITE_BUSY_SNAPSHOT`.
- `cargo test --manifest-path crates/web-protocol/Cargo.toml` to lock camelCase fields, snake_case statuses, and dotted browser event names.
- Protocol tests must assert that legacy history frames omit `workspace`, current frames serialize `workspace.updatedAt/groupId` in camelCase, and no sensitive desktop project fields exist in the DTO.
- Server storage tests must assert that an accepted snapshot persists the workspace atomically and that a newer snapshot replaces it without changing history pagination semantics.
- `npm run web:typecheck` and `npm run web:build`.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path src-tauri/Cargo.toml web_device` with assertions for URL TLS policy, profile/token serialization, queue bounds/deduplication, profile replacement, and native path boundary rejection.
- `npx tsc --noEmit` and `npm run build` for the desktop bridge and settings integration.
- Contract review: Rust camelCase/snake_case payloads must match `src/shared/types/webBrowser.ts`, the shared browser transports and Classic compatibility entries.
- Management contract review: server enabled kinds, desktop `MANAGEMENT_KINDS`, Web controls, capabilities, and confirmation sets must match exactly.
- Project-tree contract tests must assert that `project.start` accepts ID-only project/group/Worktree/selection payloads, rejects SSH external launch and multi-target split launch, and returns session IDs only for internal/split launches.
- Project-action contract tests must assert target/action prefix matching, allowlist rejection, native confirmation for destructive actions, and reuse of the desktop Sidebar behavior through the action bus.
- Tap: `npm run tap:typecheck`, `npm run tap:test`; shared renderer queue and host transcript unit/integration tests; `apps/server/tests/tap_static.rs` for both SPA roots, deep links, static asset and JSON API isolation.
- Transcript tests assert canonical text-only export, pagination/Unicode-safe truncation, exact source/CLI/cwd/context, missing binding and rejection after PTY/root changes during I/O. Server tests assert required IDs/cursor bounds/capability and forbidden cwd/root payload fields.
- `cargo test --manifest-path src-tauri/transcript-core/Cargo.toml` locks the event schema, byte windows, rewind branches, per-event caps and the result budget. `src/features/terminal/lib/webTranscriptEvents.integration.test.mjs` asserts exact binding, path caching and miss backoff, cursor validation and withholding after a binding change during I/O. Server tests assert `terminal.transcript_events` offsets and the transcript retention/throttle.
- `apps/web-tap/src/terminalWrites.test.mjs` asserts one start per frame, three-batch visible priority, hidden/timer/wake progress and cancellation.
- Browser fixture in `.trellis/tasks/10-16-optional-tap-web/browser-check.mjs` covers IME, draft/selection restore, interrupted paste without retry, desktop grid ownership, 5001-frame batching, two-renderer scheduling, renderer retry with sibling identity retained, phone reading/direct input, optional-font failure, frozen close target, late 401/stale callbacks across devices, Escape ownership and explicit token redemption/cancellation. Synthetic viewport tests cannot replace real iOS/Android keyboard acceptance.

## 7. Wrong vs Correct

```typescript
// Wrong: matching cwd does not prove a live PTY owns this conversation.
const detail = recentSessions.find((item) => item.cwd === project.path);
// Correct: use host-owned CLI identity and revalidate the PTY/root after I/O.
const boundId = terminal.cliSessionId;
const detail = await readExactHistory(boundId, source);
await revalidateTerminalContext(projectId, worktreeId, terminal.id, boundId);
```

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

```typescript
// Wrong: history rows are treated as the authoritative project catalog.
const projects = unique(history.map((session) => session.projectKey));
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
// Correct: resolve the registered ID locally, validate the canonical root,
// then delegate conversation execution to the native structured runtime (no Hook gate).
const { project, cwd } = resolveRegisteredContext(payload.projectId, payload.worktreeId);
await webDeviceApi.validateContext(project.path, cwd);
// Browser intent is not sufficient for writes; obtain native desktop approval first.
await webDeviceApi.accepted(operation.id);
await webDeviceApi.running(operation.id);
```

```typescript
// Correct: the desktop publishes a bounded workspace DTO; cwd is display-only
// and returned only after browser authentication and device ownership checks.
await webDeviceApi.publishWorkspace(workspace, sessions);
/* workspace = {
  groups,
  projects: projects.map(({ id, name, groupId, source, environmentType }) =>
    ({ id, name, groupId, source, environmentType, cwd })),
  worktrees: worktrees.map(({ id, projectId, name, branch, status }) =>
    ({ id, projectId, name, branch, status, cwd })),
  updatedAt: Date.now(),
}; */
```

```typescript
// Correct: the browser sends an ID and launch intent; desktop state supplies cwd and startup details.
await submit("project.start", {
  targetType: "worktree",
  targetId: worktreeId,
  launchMode: "internal",
});
```
## 真实终端通道

- attach 允许可选 `afterSequence`（PTY sequence，不是 browser event sequence）；旧客户端省略时仍请求完整回放。当前性能实现使用 xterm 写入完成后的游标；分片边界和与在途输出重叠的恢复语义尚待完整验收，不视为端到端 ACK 背压。
- 浏览器实时输出通过独立订阅流接入 xterm，避免更新页面级 React state；同尺寸数据批量写入。性能测试中的突发批处理结果不能替代持续网络及后台场景验证。

- 浏览器只通过已认证的 `/ws/browser` 发送 `terminal_command`；服务端必须同时校验登录用户、移动浏览器 `device_scope`、设备归属、Session ID、输入大小和 resize 范围，再转发到目标设备连接。
- 设备通过 `terminal_output` 和 `terminal_status` 发布实时帧。服务端只向设备所属用户的浏览器广播，不写入 `browser_events` 或 SQLite；断线恢复由浏览器重新 attach，并复用桌面 PTY daemon 的回放能力。
- 浏览器不得获得桌面 PTY daemon 地址或 token。桌面 React bridge 是 Web 设备通道与本地 PTY 之间的唯一适配层；Web 必须使用独立的 `PtyHostSocket` 客户端，禁止在桌面显示连接上重复 attach。
- 项目启动操作仍以桌面登记的项目/Worktree ID 为权威。`project.start` 成功结果中的 `sessionIds[0]` 是浏览器 attach 的 PTY ID；历史 CLI Session ID 不得当作 PTY ID 使用。
- 桌面端终端命令队列最多保留 256 项，溢出时淘汰最早命令；PTY 输出按约 16ms 合并转发并携带 reset/replay 与真实 cols/rows。桌面有输出消费者时由桌面独占 resize，Web 只按 PTY 尺寸镜像；桌面无消费者时 Web 可 resize。detach 只释放 Web observer 连接，不关闭 PTY。
- 设备协议版本为 3，本地 Web daemon 请求协议版本为 5；旧 1–4 版仅允许使用其发现协议版本执行状态检查与退出，空闲后升级，不混用业务帧。设备连接停止必须取消当前 TCP/握手，旧代次不能写回新连接状态。

## 内嵌服务启动就绪

- 服务必须先成功绑定监听端口，再打开 Web SQLite、更新管理员凭据和将设备标记离线。端口被占用时不得产生这些存储副作用。
- 桌面 `WebServerManager` 的 `running=true` 只能在监听、存储初始化和路由构建全部成功后设置；启动命令等待显式 ready 结果，失败或 20 秒未就绪时回收托管线程并返回错误。
- 内嵌服务可绑定回环地址、当前机器实际拥有的网卡 IP，或显式的 IPv4/IPv6 unspecified 地址；具体非回环地址默认生成对应 HTTP Origin，unspecified 地址必须配置精确 Origin。
- 非回环监听必须向设置页暴露风险状态。HTTPS Origin 使用 Secure Cookie；HTTP 只适用于受信局域网或加密虚拟组网。运行中应用新配置失败时必须恢复旧配置并重新启动旧监听。
