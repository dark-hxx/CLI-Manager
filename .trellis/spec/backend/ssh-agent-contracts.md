# SSH Agent Contracts

## 1. Scope / Trigger

Apply this contract when changing `cli-manager-ssh-agent`, shared SSH transport generation, one-shot Agent probes, Agent installation metadata, bridge framing, or the SSH Host CLI Integration status UI.

The delivered scope includes explicit one-shot probe/install lifecycle, remote Claude/Codex Hook configuration, the one-shot Hook runtime, remote history/resume RPCs, and one reusable daemon-owned protocol `1.6` bridge per active SSH Host. Protocol 1.5 file RPCs and protocol 1.6 Git RPCs are read-only; realtime/historical stats remain separate stages.

## 2. Signatures

### Shared transport

```rust
pub struct SshTransportSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub config_alias: String,
    pub auth_mode: String,
    pub identity_file: String,
    pub credential_ref: String,
    pub jump_target: String,
    pub proxy_type: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub proxy_command: String,
    pub connect_timeout_sec: u64,
    pub server_alive_interval_sec: u64,
    pub server_alive_count_max: u32,
}

pub fn build_interactive_launch(remote_command: String) -> Result<SshTransportLaunch, String>;
pub fn build_one_shot_launch(
    remote_command: String,
    options: SshOneShotOptions,
) -> Result<SshTransportLaunch, String>;
```

### Tauri command

```rust
pub async fn ssh_agent_probe(
    host_id: String,
    spec: SshTransportSpec,
    agent_path: Option<String>,
) -> Result<SshAgentProbeResult, String>;

pub async fn ssh_agent_install_preview(...) -> Result<SshAgentInstallPreview, String>;
pub async fn ssh_agent_install(...) -> Result<SshAgentOperationResult, String>;
pub async fn ssh_agent_rollback(...) -> Result<SshAgentOperationResult, String>;
pub async fn ssh_agent_uninstall(...) -> Result<SshAgentOperationResult, String>;
pub async fn ssh_agent_hook_inspect(...) -> Result<HookConfigReport, String>;
pub async fn ssh_agent_hook_preview(...) -> Result<HookConfigReport, String>;
pub async fn ssh_agent_hook_apply(...) -> Result<HookConfigReport, String>;

pub async fn ssh_db_ensure_group_schema() -> Result<(), String>;
pub async fn ssh_db_import_config_hosts(
    hosts: Vec<SshImportHostInput>,
    group_id: Option<String>,
) -> Result<SshImportResult, String>;
pub async fn ssh_db_delete_host(id: String) -> Result<(), String>;
pub async fn ssh_db_delete_group(id: String) -> Result<(), String>;
pub async fn ssh_db_save_host_preferences(
    host_id: String,
    claude_root: String,
    codex_root: String,
    updated_at: String,
) -> Result<(), String>;
pub async fn ssh_db_record_hook_report(input: SshHookReportInput) -> Result<(), String>;
```

`SshAgentProbeResult` contains `status`, stable `code`, sanitized executable/version/protocol/target metadata, `supported`, and an ephemeral diagnostic `detail`. Only metadata fields enter `ssh_agent_installations`; `detail` is never persisted.

### Agent CLI and bridge

```text
cli-manager-ssh-agent version
cli-manager-ssh-agent status
cli-manager-ssh-agent doctor
cli-manager-ssh-agent install [--install-dir PATH] [--allow-downgrade]
cli-manager-ssh-agent rollback [--install-dir PATH]
cli-manager-ssh-agent uninstall [--install-dir PATH] [--purge]
cli-manager-ssh-agent hook --source claude|codex --event EVENT \
  --managed-by cli-manager-ssh-agent --installation-id UUID
cli-manager-ssh-agent hook-config inspect|preview-install|preview-uninstall|install|uninstall
cli-manager-ssh-agent bridge --stdio --protocol 1
```

Bridge output begins with:

```text
CLI_MANAGER_SSH_AGENT/1 <nonce>\n
```

Frames use a four-byte big-endian length followed by UTF-8 JSON. The maximum frame size is 1 MiB.

## 3. Contracts

- Interactive PTY and one-shot execution must share authentication, port, config alias, timeout, KeepAlive, identity, AskPass, ProxyJump, and ProxyCommand generation.
- Interactive launches use `ssh -tt`; one-shot probe/install/doctor launches use `ssh -T`, `ConnectionAttempts=1`, and `BatchMode=yes`, except saved credential mode uses one-shot AskPass with `BatchMode=no` and one password prompt.
- Saving or opening SSH Host settings never probes automatically. Only the explicit Probe Agent action creates the one-shot SSH process.
- Password-prompt and multi-round interactive authentication return `authenticationRequired`; background retries must stop.
- Probe discovery accepts a previously persisted explicit path, `PATH`, `$HOME/.local/bin/cli-manager-ssh-agent`, or the standard XDG data `current` path. Explicit paths accept only absolute POSIX or `~/...` syntax.
- Probe stdout may contain at most 8 KiB of login banner before `CLI_MANAGER_SSH_AGENT_PROBE/1`. Total retained stdout is 64 KiB and stderr is 8 KiB; readers continue draining excess bytes without growing retained memory.
- After the probe marker, stdout is strict: state line, absolute executable path, then exactly one doctor JSON document. Extra text, invalid UTF-8, unsafe paths, oversized output, or malformed identity is rejected.
- Protocol major mismatch is incompatible. Protocol minor differences are handled later through capabilities. The first supported Agent target matrix is Linux `x86_64` and `aarch64`.
- `ssh_agent_installations` preserves last-known sanitized metadata on unreachable/authentication-required probes, but a confirmed `notInstalled` result clears stale version/path metadata.
- Bridge `--protocol` is mandatory. A clean EOF before a frame starts is normal; a partial four-byte length or payload is a protocol error.
- A healthy Agent must report protocol major 1 and minor 4 or newer. Minor 1 advertises `heartbeat`, `requestCancellation`, and `boundedBackpressure`; minor 3 adds remote history RPCs and `historyDetailChunks`; minor 4 adds `historyResumePreflight`. Older minor versions remain upgradeable but are not marked usable by the current desktop.
- Desktop install and the HTTP(S) script consume the same schema-1 release manifest and Tauri updater Minisign trust root. The signature covers manifest bytes; the manifest pins channel, semantic version, protocol range, Linux target, URL, size, and SHA-256.
- Release URLs default to HTTPS. HTTP requires explicit user opt-in, never permits embedded credentials, query strings, or fragments, and still requires a valid signature. Manifest, signature, and artifact downloads are bounded.
- Install preview is read-only. Confirmation re-fetches and re-verifies the manifest before downloading or opening SSH, preventing a stale preview from authorizing different bytes.
- The desktop uploads the verified artifact through `ssh -T` stdin to a random state-directory staging path. The remote shell receives only fixed commands plus POSIX-quoted validated values; the WebView never assembles an unrestricted shell program.
- The Agent owns installation transactions: an exclusive lock, `versions/<version>`, atomic `current`/`previous` symlinks, a CLI-Manager-owned `$HOME/.local/bin` launcher, and an atomic XDG state `installation.json` discovery record.
- Existing custom install roots are reused from the discovery record when no new root is supplied. A corrupt record is archived and repaired by an explicit install. A valid current binary remains the downgrade authority even if the record is missing.
- Downgrades are rejected unless explicitly allowed. A failed promote restores `current`, `previous`, and the launcher. Rollback swaps only distinct valid versions and restores links if self-check or record persistence fails.
- Uninstall quarantines managed versions before removing links and the discovery record; a failure restores all original links and versions. Normal uninstall keeps one bounded record, while `--purge` removes Agent state. No Agent lifecycle command modifies Claude/Codex Hook configuration.
- Operation JSON is accepted only after strict marker, action, UUID, version, protocol, target, path, source, manifest URL, and SHA-256 validation. Arbitrary remote output is never persisted.
- Hook config requests use the Host/tool `configuredConfigRoot`; empty means `$HOME/.claude` or `$HOME/.codex`. Inspect and preview never create directories. Confirmed install may create only a missing native default root; a missing custom root is rejected.
- Hook reports return the configured and canonical roots, `configRootHash`, actual canonical config files, fingerprints, change actions, Agent installation/machine identity, and an installation record. The desktop validates every field before persisting `hook_record_json`.
- A later inspect refresh preserves the last validated `HookInstallationRecord` for the same canonical root until explicit uninstall. Host-primary and project-override rows that resolve to the same Host/source/canonical root mirror the same Hook report so one physical installation cannot appear installed in one scope and absent in another.
- Claude JSON and Codex JSON/TOML are parsed structurally. Install normalizes only exact Agent-owned duplicates in place; uninstall removes only the exact path/source/event/owner/installation command. Unknown events and third-party fields, array order, matchers, symlinks, TOML comments, and user-owned `features.hooks = true` remain intact.
- Config writes hold a per-root lock, verify preview fingerprints and current symlink targets, journal original bytes/mode, atomically replace files, reread, and roll back safely. A stale or externally edited target returns a conflict instead of overwriting it.
- Hook execution requires all reserved Host/client/project/Tab/bridge-epoch variables. Missing or invalid binding is a successful no-op. Runtime errors are swallowed by the `hook` CLI so Claude/Codex is never blocked.
- Hook stdin is limited to 1 MiB and normalized through `hook-schema`. Prompt/message text is removed before spooling. Remote transcript paths remain opaque references and never become desktop-local paths.
- Spool/socket namespace is `SHA-256(hostId, clientInstanceId, installationId)`. It is bounded by 24 hours, 10000 records, and 32 MiB; overflow emits a sequenced `gap`. A stale PID lock is recoverable, JSONL/meta divergence rebuilds monotonic sequence state, ACK removes only confirmed records, and reconnect dedup covers the full bounded spool.
- Bridge hello requires Host/client/installation identity and reports remote machine identity. The desktop also validates every event against the live daemon session's Host/client/project/Tab/epoch/installation/source binding before routing it to the existing Hook sink.
- SSH PTY launch injects Agent bridge identity only when the effective Host/source/configured root has a locally validated `installed` Hook report whose Agent installation and remote machine identities still match. Agent installation alone must not create a background Hook bridge.
- The daemon owns one bridge entry per Host/client connection fingerprint while every PTY remains independent. Address, SSH user/config alias, auth, identity/credential reference, jump/proxy settings, Agent identity/path, ConnectTimeout, or KeepAlive changes replace the old bridge without holding the global registry lock during process shutdown.
- At most four bridge processes and two concurrent connect/reconnect handshakes run globally. A fifth active Host waits without opening SSH; releasing its last session cancels that wait. Probe/install one-shot processes do not consume a bridge permit.
- Bridge stdout is consumed by a bounded 32-frame reader queue. Login banner plus preamble must complete within `min(ConnectTimeout + 10s, 60s)`; hello, ACK, ping, and ordinary responses have a 10-second bound. Timeout or disconnect kills/reaps the local SSH child before retry.
- Bridge stderr is always drained but only the first 8 KiB is retained in memory for classification. Permission/passphrase/keyboard-interactive failures become `ssh_interactive_auth_required`; Host Key failures become `ssh_host_key_verification_required`; raw stderr is never persisted or logged.
- Application heartbeat uses ping/pong every 10 seconds in addition to OpenSSH KeepAlive. Reconnect uses 1/2/5/10/30/60-second backoff with deterministic +/-20% Host jitter, resets after a connection survives 30 seconds, and limits `bridge_already_active` to a retried takeover state instead of a permanent failure.
- Cancellation IDs are validated and held in a bounded 1024-entry registry. Unknown frame kinds return a versioned error without closing the bridge; invalid request IDs/kinds, oversized frames, contaminated preamble/frame streams, or malformed response identities close it.
- Hook batches are accepted only when at most 128 records have strictly increasing sequences above the current cursor and the final sequence equals `latestSequence`; ACK must echo `accepted=true` and the exact sequence. Remote error codes are limited to 128 ASCII identifier bytes before logging.
- Spool drain and ACK use bounded per-record streaming rather than loading the full 32 MiB file. A malformed or over-1-MiB record fails closed and preserves the original spool; ACK temporary files are removed on failure.
- Remote history list/search/detail requests reuse the Host bridge and remain project-scoped. Agent cursors use `generation:offset`; full detail uses ordered 256-KiB chunks under the existing 1-MiB frame limit and a 64-MiB aggregate cap.
- Desktop remote-history consumers validate installation/machine/user/source/config-root/source-instance identity on initial and continuation pages. Detail chunks additionally validate request identity, sequence, total, aggregate size, and one request deadline.
- Resume preflight reopens the indexed artifact, validates the stable source identity, verifies the original JSONL is still readable, canonicalizes an enterable absolute POSIX cwd, checks the standard Claude/Codex executable, and returns structured resume args plus the canonical config-root environment override.
- Agent uninstall returns `agent_managed_hooks_present` while any Agent Hook installation record remains. Hook uninstall does not delete the configured root, future history source identity, or unrelated Agent state.
- If a custom config root was deleted externally, install/inspect still report it missing, but preview-uninstall/uninstall may recover exactly one matching canonical identity from the bounded Agent-owned record set and remove that stale record without recreating the directory. Retained-root cleanup also sends the previously validated `expectedCanonicalRoot`; if the configured path is a symlink that now resolves elsewhere, only an exact unique Agent record may route cleanup back to the old canonical root. Ambiguous, missing, invalid, or retargeted canonical records fail closed.
- Remote Hook third-party notification jobs omit remote cwd, transcript refs, Host/project/session/Tab identifiers, and prompt text.
- SSH combination writes use explicit `ssh_db_*` commands. Each command opens the primary database with WAL, foreign keys, and a 15-second busy timeout, then keeps all dependent reads and writes inside one short `BEGIN IMMEDIATE` transaction on that connection.
- `ssh_db_record_hook_report` owns existing-row selection, inspect-record preservation, retained-root conversion, replacement insertion, and canonical-root mirror updates. Its nested report identity fields must equal the validated top-level fields.
- `ssh_db_import_config_hosts` accepts at most 10000 normalized host rows, reads existing aliases once inside the transaction, and inserts only the missing case-insensitive aliases.
- Only `ssh_db_ensure_group_schema` uses a process-wide async mutex and atomic success fast path. The lock covers compatibility DDL/backfill only; ordinary host/group/preference/integration/history operations do not share an application mutex.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Host ID is not a UUID | `ssh_host_id_invalid` |
| Background probe uses password-prompt/interactive auth | status `authenticationRequired`, code `ssh_agent_authentication_required` |
| Explicit Agent path is relative, contains expansion syntax, backslash, NUL/CR/LF | `ssh_agent_path_invalid` |
| Explicit Agent path contains a `..` segment | `ssh_agent_path_parent_forbidden` |
| No candidate executable exists | status `notInstalled`, code `ssh_agent_not_installed` |
| SSH exits with transport status 255 | status `unreachable`, code `ssh_agent_unreachable` |
| Probe process cannot start or times out | status `unreachable`, code `ssh_agent_probe_failed` |
| Banner exceeds 8 KiB | `ssh_agent_probe_banner_too_large` |
| Retained stdout exceeds 64 KiB | `ssh_agent_probe_output_too_large` |
| Marker is missing/invalid or stdout is contaminated | corresponding stable `ssh_agent_probe_*` code |
| Agent name is not `cli-manager-ssh-agent` | status `corrupt`, code `ssh_agent_identity_invalid` |
| Protocol major is not 1 | status `incompatible`, code `ssh_agent_protocol_incompatible` |
| OS/architecture is outside Linux x64/arm64 | status `unsupported`, code `unsupported_target` |
| Supported target has no usable HOME/XDG layout | status `corrupt`, code `home_directory_unavailable` |
| Manifest signature, schema, protocol, URL, target, size, or SHA-256 is invalid | reject before upload |
| Concurrent install/upgrade holds the lock | `agent_install_locked` |
| Incoming semantic version is lower without explicit approval | `agent_downgrade_forbidden` |
| Existing launcher is not owned by CLI-Manager | `agent_launcher_conflict` |
| Requested root differs from a valid discovery record | `agent_install_root_mismatch` |
| Promote/self-check/record write fails | restore old `current`, `previous`, and launcher |
| Rollback has no distinct previous target | `agent_previous_missing` / `agent_previous_same_as_current` |
| `bridge --stdio` omits `--protocol` | `bridge_protocol_required` |
| Frame length is zero or over 1 MiB | `frame_size_invalid` |
| EOF occurs after only part of the length prefix | `frame_length_read_failed:*` |
| Preamble/hello exceeds its deadline | kill/reap SSH child, release connect permit, retry with bounded backoff |
| Required protocol minor/capability is absent | probe `incompatible` / bridge `ssh_agent_bridge_protocol_incompatible` |
| Old bridge still owns the Host/client socket | retry `bridge_already_active` until takeover or cancellation |
| SSH stderr indicates interactive authentication or Host Key action | stop background retry with a stable sanitized code |
| Hook batch sequence/latest/ACK mismatch | close bridge without advancing the cursor |
| Remote continuation identity changes | `history_remote_identity_changed`; preserve the previous catalog rows |
| Detail chunks are reordered, duplicated, oversized, or exceed the deadline | close/fail the request without caching partial detail |
| Resume source JSONL or cwd is missing | `remote_session_source_missing` / `remote_session_cwd_unavailable`; create no PTY |
| Another daemon consumer owns the same source-instance/session | `remote_session_active_elsewhere` |
| Remote file root is not absolute/canonical or a relative path escapes through `..`/symlink | stable `remote_file_root_*` / `remote_file_path_*` error; no local fallback |
| Remote file is binary | `remote_file_binary` |
| Remote text/other file exceeds 1 MiB | `remote_file_too_large` |
| Remote image exceeds 5 MiB | `image_file_too_large` |
| Remote raster image exceeds 12,000,000 pixels | `image_dimensions_too_large` |
| Remote path has a known video extension | `video_preview_unsupported` |
| Spool record is malformed or over 1 MiB | stable `hook_spool_record_*` error; preserve original spool |
| Custom Hook config root is missing | `hook_config_root_missing` |
| Deleted custom root has one valid matching Agent record during uninstall | use its canonical identity for no-op config cleanup and remove the record |
| Deleted custom root has multiple or invalid matching records | `hook_config_record_conflict` / `hook_config_record_invalid` |
| Configured-root symlink now points from canonical root A to B | uninstall based on a stored Hook report carries `expectedCanonicalRoot=A` and uses one exact Agent record; a direct request without an expected identity follows the current B root |
| Hook JSON/TOML is malformed or a managed event has an invalid shape | stable `hook_config_*_invalid` error; no write |
| Preview fingerprint or symlink/root target changed | `hook_config_changed` / `hook_config_root_changed` |
| Another live Hook config transaction owns the root lock | `hook_config_locked` |
| SSH multi-row write cannot obtain/commit its SQLite transaction | stable `ssh_database_begin_failed` / `ssh_database_commit_failed`; no partial mutation |
| Hook report nested identity differs from top-level command input | `ssh_hook_report_invalid`; no write |
| Explicit integration belongs to another source | `ssh_hook_integration_identity_changed`; no write |
| SSH Config import exceeds 10000 hosts | `ssh_config_import_too_many_hosts`; no write |
| CLI-Manager marker belongs to another installation or placement | status `conflict` / `hook_config_owner_conflict` |
| Spool JSONL was appended but meta is stale | rebuild count/bytes/next sequence before append |

## 5. Good / Base / Bad Cases

- Good: four PTYs on one Host retain independent interactive SSH processes while an explicit Agent probe uses one short-lived `ssh -T` process.
- Good: a login banner precedes the marker by less than 8 KiB; the doctor report is parsed and only sanitized metadata is stored.
- Base: the Agent is absent; the UI records `notInstalled` without installing anything or modifying Hook configuration.
- Base: MFA authentication requires an interactive terminal; the probe reports `authenticationRequired` and does not retry.
- Good: a signed x64/aarch64 artifact is uploaded through stdin, self-checks from staging, atomically becomes `current`, and leaves the former version as `previous`.
- Good: an existing custom install root is upgraded in place without needing to repeat `--install-dir` inside the Agent transaction.
- Good: Claude and Codex Hooks use different roots; preview shows actual files, confirmation preserves third-party entries, and both tools can be removed independently.
- Good: the desktop disconnects, events spool under the bound Host/client namespace, and reconnect replays each event at most once before ACK deletion.
- Good: four Host bridges are connected, a fifth waits without starting SSH, and closing one Host releases a permit for the waiting Host.
- Good: an SSH project file panel reuses its Host bridge, lists only canonical-root descendants, skips symlinks, and reads bounded UTF-8 text or supported image data URLs.
- Good: remote video, byte-size, and raster-pixel checks run before file reads and Base64 conversion; the desktop also prechecks directory metadata to avoid unnecessary RPCs.
- Bad: relying only on WebView `<img>` sizing after a high-pixel image has already crossed the SSH bridge as Base64.
- Good: an SSH terminal stats panel reuses one history consumer for incremental detail and catalog usage facts, while stale/offline failures preserve the last bounded snapshot without local path fallback.
- Good: deleting a Host either clears project/integration references and deletes the Host together, or rolls the entire operation back.
- Good: two different SSH Hosts save preferences concurrently; SQLite coordinates only their short write sections and no application-wide CRUD mutex serializes them.
- Base: two imports contain the same config alias; the later transaction observes the normalized existing alias and reports it as skipped.
- Bad: issue `BEGIN IMMEDIATE`, updates, and `COMMIT` as separate `tauri-plugin-sql` calls and assume the pool preserves connection affinity.
- Bad: pass a remote absolute path to local `file_*`/Git commands, expose create/save/delete/move/external opener actions, or traverse more than the Agent file quotas.
- Good: a replaced bridge briefly receives `bridge_already_active`, backs off, then takes ownership after the old Agent process removes its socket.
- Base: a missing or malformed discovery record is reconstructed only after an explicit install; no page-open or probe action changes remote files.
- Base: Claude/Codex launched from an ordinary SSH shell has no binding variables; the installed Hook exits successfully without writing spool data.
- Bad: trust an artifact hash from the WebView, skip manifest re-verification after preview, overwrite a non-owned launcher, or run `curl | sh` without review.
- Bad: identify ownership by substring alone, rewrite unknown Hook events, trust only the WebView fingerprint, reuse a stale spool meta sequence, or send remote cwd to third-party notifications.
- Bad: reuse the `-tt` terminal launch to run doctor, causing PTY/profile output to contaminate protocol stdout.
- Bad: cache remote stderr, proxy credentials, AskPass tokens, or arbitrary doctor JSON in SQLite.
- Bad: treat partial frame headers as clean disconnects; this hides protocol truncation and corrupt streams.

## 6. Tests Required

- Desktop SSH persistence: multi-row/multi-table writes must run on one Rust-owned SQLite connection with a short `BEGIN IMMEDIATE` transaction and busy timeout. Do not send transaction control through `tauri-plugin-sql` pooled IPC calls.
- SSH group schema compatibility may use a process-wide single-flight lock only around the idempotent DDL/backfill step. Ordinary host, preference, integration, and history operations must not share an application-level global mutex.
- Batch SSH Config import reads existing aliases once inside the write transaction, then inserts only normalized missing aliases; concurrent imports must not create partial batches.
- Assert rollback for host deletion, preference pairs, Hook retained-root replacement, and group child/host migration when any statement fails.

- Run `npx tsc --noEmit`.
- Run `cargo check --manifest-path src-tauri/Cargo.toml` with no warnings.
- Run `cargo test --manifest-path src-tauri/Cargo.toml --lib`.
- Run `cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml`.
- Assert transport parity for config alias, Agent, identity-file, credential reference, interactive auth, ProxyJump, and direct proxy precedence.
- Assert explicit path validation and safe HOME expansion.
- Assert bounded banner/report parsing, invalid UTF-8/contamination, protocol mismatch, identity mismatch, unsupported target, clean EOF, partial frame length, oversized frame, and mandatory bridge protocol.
- Assert protocol minor 1 capability negotiation, bounded reader/response timeouts, global bridge/connect permits, retry jitter/reset classification, `bridge_already_active` takeover, heartbeat echo, cancellation bounds, and last-session shutdown.
- Assert protocol minor 3 history capability negotiation, generation cursors, continuation identity, chunk ordering/size/deadline, detail LRU eviction, and consumer release.
- Assert protocol minor 4 resume capability and protocol minor 5 remote-file capability, structured Claude/Codex args, source/cwd validation, ownership claim/release, and implicit SSH Config username handling.
- Assert remote file root/path confinement, symlink escape rejection, binary refusal, 1 MiB text and 5 MiB image limits, the exact 12,000,000-pixel boundary, video refusal, directory/search/visited limits, image data URLs, and UI/store read-only routing.
- Assert manifest tampering, duplicate/unknown targets, HTTP opt-in, query/fragment rejection, target selection, size/SHA-256 mismatch, and bounded downloads.
- Assert install path quoting, strict operation markers/metadata, semantic version actions, lock conflicts, default/custom roots, corrupt/missing discovery recovery, promote rollback, distinct previous versions, and transactional uninstall.
- Assert Claude/Codex exact-owner merge, duplicate normalization, unknown-event preservation, invalid JSON/TOML refusal, user-owned Codex feature/comment preservation, symlink target change refusal, fingerprint conflict, journal rollback, and Agent uninstall blocking.
- Assert missing binding no-op, event allowlists, 1 MiB stdin bound, message redaction, Host/client/installation namespace isolation, stale lock recovery, monotonic meta rebuild, TTL/count/byte gap, streaming read/ACK, malformed-record preservation, monotonic batch/ACK validation, full-window event/gap dedup, and remote notification cwd redaction.
- Run the POSIX installer smoke test for HTTPS dry-run, default HTTP rejection, explicit HTTP, custom install root, downgrade forwarding, and temporary-directory cleanup.
- Compile the Agent for Linux `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu` in addition to host tests.
- Manually verify the CLI Integration page opens without SSH traffic and only Probe Agent starts a one-shot connection.

## 7. Wrong vs Correct

### Wrong: reuse the terminal PTY launch

```rust
ssh_launch.build_process_launch(); // emits -tt and enters the project shell
```

### Correct: share transport settings, select the correct launch mode

```rust
transport.build_interactive_launch(project_command);
transport.build_one_shot_launch(agent_probe_script, SshOneShotOptions::default());
```

The shared transport owns authentication and routing; the caller owns whether the process is an interactive PTY or a bounded one-shot operation.

### Wrong: split a database transaction across pooled IPC calls

```typescript
await db.execute("BEGIN IMMEDIATE");
await db.execute("UPDATE ssh_hosts ...");
await db.execute("COMMIT");
```

### Correct: invoke one domain command

```typescript
await invoke("ssh_db_delete_host", { id });
```

The Rust command owns one connection and one short transaction. Schema single-flight is separate and never becomes a CRUD lock.
