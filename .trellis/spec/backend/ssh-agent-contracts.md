# SSH Agent Contracts

## 1. Scope / Trigger

Apply this contract when changing `cli-manager-ssh-agent`, shared SSH transport generation, one-shot Agent probes, Agent installation metadata, bridge framing, or the SSH Host CLI Integration status UI.

The delivered scope includes explicit one-shot probe/install lifecycle, remote Claude/Codex/Kimi/Grok Hook configuration, the one-shot Hook runtime, Claude/Codex-only remote history/resume RPCs, and daemon-owned protocol `1.14` bridges per active SSH Host. Protocol 1.5 introduced read-only file RPCs; protocol 1.7 Git RPCs expose the full Git panel through a dedicated serialized Git lane, protocol 1.8 adds negotiated Diff generation options, protocol 1.9 adds bounded terminal image attachments outside project roots, protocol 1.10 generalizes attachment upload to arbitrary regular files, protocol 1.11 adds session-bound Agent MCP/Skill diagnostics through `agentCapabilitiesV1`, protocol 1.12 adds Host-scoped attachment roots, protocol 1.13 adds direct Host SFTP uploads, and protocol 1.14 adds Host SFTP download/delete. Realtime/historical stats remain separate stages.

Grok compatibility isolation is a stateful `config.toml` mutation: installing and uninstalling must
distinguish Agent-owned `compat.<vendor>.hooks` values from values already chosen or subsequently
edited by the user.

### Agent Release Identity

- The Agent product version is `src-tauri/ssh-agent/Cargo.toml` `[package].version`; its Cargo
  lockfile package entry and `AGENT_VERSION` must resolve to the same value. It is independent
  from the desktop app version and from the bridge protocol version.
- Protocol `1.7` plus `gitFull` first ships as Agent `0.1.1`. The published `0.1.0`
  prerelease reports protocol `1.6`; releases `0.1.0` through `0.1.2` remain immutable.
  Agent `0.1.3` keeps protocol `1.7` and expands ordinary untracked directories into file
  entries so Diff, stage, and guarded deletion receive valid repository-relative paths.
  Agent `0.1.4` keeps protocol `1.7` and adds exact Claude `AskUserQuestion` / Codex
  `request_user_input` Hook templates plus Codex `Notification` runtime admission.
  Agent `0.1.5` reports protocol `1.8` and adds `gitDiffOptions` for fixed whitespace and
  context generation options; legacy `gitDiff` remains the `exact+3` compatibility path.
  Agent `0.1.6` reports protocol `1.9` and adds the negotiated `fileAttach` capability for
  chunked terminal image uploads into the remote user's XDG cache. Agent `0.1.7` reports
  protocol `1.10` and adds `fileAttachAny` for arbitrary regular files up to 20 MiB while
  preserving the original safe basename. Agent `0.1.8` reports protocol `1.11` and
  advertises `agentCapabilitiesV1` for fixed-command, redacted MCP/Skill inspection and probes.
  Agent `0.1.9` keeps protocol `1.11` and adds the current Kimi Code TOML Hook adapter/runtime without adding Kimi history support.
  Agent `0.1.10` keeps protocol `1.11` and adds the Grok Build JSON Hook adapter (`hooks/cli-manager.json` plus `config.toml` cross-tool isolation) without adding Grok remote history support.
  Agent `0.1.11` reports protocol `1.12` and adds the optional Host-scoped attachment root with
  `fileAttachCustomRoot`; empty roots retain the existing XDG cache behavior. The same release
  optionally advertises `fileAttachmentRoot`, a read-only request that returns the resolved
  managed attachment directory without requiring the desktop to guess HOME or `XDG_CACHE_HOME`.
   Agent `0.1.12` reports protocol `1.13` and adds `filePut` for direct Host SFTP uploads into
   the selected remote directory; terminal attachment requests retain their managed
   session/upload isolation.
   Agent `0.1.13` reports protocol `1.14` and adds `fileGet` for bounded arbitrary-file downloads
   and `fileDelete` for regular files or empty directories below the selected remote root.
- The independent Agent release tag is exactly `ssh-agent-v<agent-version>`. Its signed manifest
  must carry that Agent version and point only to assets on that same tag.
- Independent Agent releases are GitHub prereleases with `make_latest: false`. The desktop
  updater endpoint `releases/latest/download/latest.json` remains owned by stable desktop
  releases tagged `V<desktop-version>`.
- Stable desktop releases bundle the signed Agent manifest, signature, and Linux x64/arm64
  binaries. Desktop installation uses that bundle first; only a completely absent bundle falls
  back to the stable desktop Release network manifest.
- Linux x64 and arm64 release binaries target a GLIBC 2.17 ABI baseline. Both desktop and
  independent Agent release workflows use the same build path and reject binaries whose maximum
  referenced GLIBC symbol version is newer than 2.17.
- The shell installer uses `ssh-agent-v<version>` for explicit versions, except legacy `1.3.0`,
  which resolves to its original `V1.3.0` desktop Release. An unavailable GitHub network cannot
  be repaired by the remote installer; the bundled desktop installation remains the offline path.
- User-configured and signed-manifest URLs reject query strings, fragments, and credentials.
  HTTPS redirect targets may contain CDN-generated temporary query signatures, but still require
  a host, reject credentials/fragments, and remain bounded to three redirects. Manifest Minisign
  and Agent SHA-256 verification remain mandatory after redirect resolution.
- Release workflows derive the desktop default manifest, UI installer URL, signed manifest artifact
  URLs, and rendered shell installer from the validated `R2_PUBLIC_BASE_URL` build variable. GitHub
  Release remains the fixed fallback, while local non-release builds retain the committed R2 origin.

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

pub async fn ssh_agent_available_release(
    manifest_url: Option<String>,
    current_version: Option<String>,
    allow_http: bool,
) -> Result<SshAgentAvailableRelease, String>;
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
pub async fn ssh_db_record_history_source(input: SshHistorySourceInput) -> Result<(), String>;
```

`SshAgentProbeResult` contains `status`, stable `code`, sanitized executable/version/protocol/target metadata, `supported`, and an ephemeral diagnostic `detail`. Only metadata fields enter `ssh_agent_installations`; `detail` is never persisted.

`ssh_agent_available_release` resolves the same bundled-first signed Agent manifest as install preview. It must not accept an SSH spec and must not open an SSH connection. The CLI Integration UI may show an Update action only when `action == "upgrade"`; pressing Update still runs `ssh_agent_install_preview` then `ssh_agent_install`. Check failures are shown as real errors and must not be reported as up to date.

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

### Grok compatibility config plan (internal)

```rust
fn install_grok_compat_isolation(
    document: &mut DocumentMut,
    installation_id: &str,
) -> Result<(), String>;
fn uninstall_grok_compat_isolation(
    document: &mut DocumentMut,
    installation_id: &str,
) -> Result<(), String>;
```

Bridge output begins with:

```text
CLI_MANAGER_SSH_AGENT/1 <nonce>\n
```

Frames use a four-byte big-endian length followed by UTF-8 JSON. The maximum frame size is 1 MiB.

Protocol 1.9 terminal attachments use `fileAttachBegin`, `fileAttachChunk`,
`fileAttachFinish`, and `fileAttachAbort`. Chunks contain at most 512 KiB before Base64 encoding,
so every encoded request remains below the 1 MiB frame limit.

Protocol 1.10 arbitrary-file attachments use the parallel `fileAttachAnyBegin`,
`fileAttachAnyChunk`, `fileAttachAnyFinish`, and `fileAttachAnyAbort` request kinds. The separate
capability keeps legacy image uploads usable with Agent 0.1.6 while allowing the daemon to reject
unsupported arbitrary-file requests before writing a frame.

Protocol 1.12 attachment requests may add a non-empty `attachmentRoot` to either Begin request.
The daemon requires `fileAttachCustomRoot` before forwarding that field; the Agent expands only
absolute POSIX or `~/...` roots and writes below its managed
`cli-manager-ssh-agent/attachments` child. Older Agents remain compatible with the default root
because Desktop omits the field when the Host setting is empty.

The Host-level attachment panel may request `fileAttachmentRoot` with the same optional
`attachmentRoot` value. The Agent creates/validates only its managed attachment child and returns
an absolute `rootPath`. This is an additive capability: a desktop may continue Host uploads when
an older Agent lacks `fileAttachmentRoot`, but it must not guess the default remote cache path.

Protocol 1.13 Host SFTP uploads use `filePutBegin`, `filePutChunk`, `filePutFinish`, and
`filePutAbort`. `filePutBegin` contains `rootPath`, an optional confined `relativePath`,
`fileName`, `sizeBytes`, and `sha256`; the Agent writes the verified file directly below the
selected directory without session or UUID child directories. The `filePut` capability is
required before the daemon forwards any of these requests. Root paths may be absolute POSIX or
`~/...` paths without `..`; the Agent canonicalizes the existing directory, rejects symlink
entries/escape paths, verifies size and SHA-256, and atomically renames the same-directory
temporary file. Existing target files are rejected rather than overwritten.

Protocol 1.14 Host SFTP downloads use `fileGet` and return ordered `fileGetChunk` frames. Each
frame carries a sequential index/total, the confined relative path, exact byte size, optional
modification time, and Base64 data. Raw chunks are at most 512 KiB; the daemon accepts at most
64 chunks and 20 MiB of encoded response data, and the Desktop verifies the reconstructed byte
count before writing the selected local file. `fileDelete` removes one regular file or one empty
directory below the resolved root; it never follows symlinks, recursively deletes directories,
or permits deleting the root itself. Both operations require their explicit capabilities before
the daemon writes a frame.

Protocol 1.11 Agent diagnostics use `agentCapabilitiesInspect` and
`agentCapabilitiesProbe`. Both require `agentCapabilitiesV1`, run in the exact remote project
cwd, and return only normalized/redacted snapshots. Capability absence is an actionable upgrade
state and must never fall back to desktop-local inspection.

### Stale bridge capability refresh

#### 1. Scope / Trigger

This contract applies when an installed Agent binary is replaced in place while a daemon-owned
bridge is still alive. The bridge capabilities are negotiated at handshake time, so a request can
observe a missing capability from an old Agent process even though the current Agent path now
resolves to a newer installation. The refresh belongs to the daemon bridge lifecycle, not to the
one-shot Agent probe, Tauri commands, or the Agent wire protocol.

#### 2. Signatures

```rust
SshAgentBridgeManager::request(
    &self,
    host: Weak<DaemonHost>,
    consumer_id: &str,
    plan: &SshLaunchPlan,
    kind: &str,
    payload: Value,
) -> Result<Value, String>;

handle_agent_request(
    writer: &mut impl Write,
    reader_receiver: &Receiver<ReaderMessage>,
    host_id: &str,
    request_number: &mut u64,
    capabilities: &[Value],
    agent_request: AgentBridgeRequest,
) -> Result<(), String>;
```

No public IPC signature, Desktop payload schema, or Agent protocol request kind changes as part of
this refresh.

#### 3. Contracts

- `handle_agent_request` checks the required capability before assigning a request number or
  writing a frame. Missing capabilities return exactly
  `ssh_agent_capability_missing:<capability>` and terminate the stale bridge loop.
- `request` retries the original payload at most once after that exact capability error. It
  invalidates only the reservation's matching bridge slot and `Arc` control, stops that bridge,
  and rebuilds the same `Primary`, `Readonly`, or `Git` lane.
- Bridge replacement preserves the slot's sessions and consumers. The refresh plan uses the
  current Agent path, installation id, and remote machine id; Host-only Primary context is kept
  from the stale plan when the current request plan has no project id.
- A capability error after the one permitted refresh is returned unchanged. There is no shell,
  local-path, or unrelated-lane fallback.

#### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| First request receives `ssh_agent_capability_missing:<capability>` | Stop only the exact stale bridge, re-handshake, and retry the original request once before frame serialization on the replacement bridge |
| Replacement bridge still lacks the capability | Return the same stable capability error; do not refresh again |
| Reservation slot or control does not match the current bridge entry | Do not stop the current bridge; preserve it for normal request/lifecycle handling |
| Remote command, transport, timeout, or validation error is not a capability error | Preserve existing error and retry/disconnect policy; do not refresh for it |
| Refresh races with another request or a newer bridge replacement | Never invalidate a newer control; lane and Host/project identity remain isolated |

#### 5. Good / Base / Bad Cases

- Good: after an in-place Agent upgrade, `fileDelete` receives the old bridge's missing-capability
  response, the bridge is replaced with current Agent identity, and the original delete succeeds.
- Base: a fresh bridge advertises the requested capability and completes the request without a
  refresh.
- Bad: keep the old bridge alive after reporting the capability error, retry indefinitely, delete
  through a shell fallback, or route the request through another lane.

#### 6. Tests Required

- Assert missing capability is returned before any frame/request-number mutation.
- Assert stopped controls cannot reserve new requests and invalidation requires both the exact slot
  and the same `Arc` control, including replacement races.
- Assert one capability refresh retries once, while non-capability errors never refresh and a
  second missing-capability response is final.
- Assert refresh plans preserve Host-only Primary context and overlay current Agent identity.
- Assert Primary, Readonly, and Git bridges remain isolated, and existing fileGet/fileDelete path
  confinement and no-shell-fallback tests remain green.

#### 7. Wrong vs Correct

Wrong: return the missing-capability error but leave the negotiated bridge reusable, or loop until
the Agent changes.

Correct: send the stable error, return `Err` so the stale bridge exits, match and stop only the
offending reservation, rebuild the same lane with current Agent identity, and retry the original
request once.

Remote Git Diff responses contain:

```rust
GitFileDiffPayload {
    content: String,
    can_revert_hunks: bool,
    byte_length: usize,
    line_count: usize,
}
```

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
- The full remote Git panel additionally requires protocol minor 7 and the explicit `gitFull` capability; capability absence blocks Git only and never falls back to local Git commands or the read-only lane.
- Non-default remote Diff generation uses `gitDiffWithOptions` and requires the protocol-minor-8 `gitDiffOptions` capability. The daemon checks the negotiated capability before frame serialization. Default `exact+3` must use legacy `gitDiff` without an `options` field so Agents `0.1.1` through `0.1.4` remain compatible.
- Remote file browsing for an SSH project still uses that project's Host/root context. Terminal attachment upload uses the live SSH session's `sshHostId` and `remotePath`, so a registered SSH project is not required; it still requires an installed Agent and valid Host/session context. Host SFTP download/delete use the exact Host context and current panel root. Neither path requires a configured CLI tool, Hook integration, or history source. Their launch contexts must be built independently from the remote-history context; an empty `toolSource` and, for Host-only attachments, an empty `projectId` are valid for these request-driven lanes.
- The desktop first requests protocol-minor-10 `fileAttachAny` for every attachment so file contents are never inferred from the extension. If that capability is missing, only a valid legacy image within 5 MiB and 12 million pixels retries through protocol-minor-9 `fileAttach`. The daemon checks each negotiated capability before sending a frame; Agent 0.1.6 therefore continues accepting legacy images while unsupported arbitrary files return an actionable upgrade error instead of receiving a desktop-local path.
- A non-empty Host attachment root is sent only in the Begin payload and requires the negotiated `fileAttachCustomRoot` capability in addition to `fileAttachAny` or `fileAttach`. Missing custom-root capability is rejected before the Agent frame is written; Desktop does not silently fall back to the default directory.
- Host SFTP browsing uses the configured Host upload directory directly, or the resolved Agent default directory when the setting is empty. Manual directory input is validated as an absolute POSIX/`~/...` path without `..`; changing it replaces the current browsing root and does not change terminal attachment routing.
- The Host SFTP local pane is independent from the remote Agent lane: it starts at the platform Desktop directory, obtains metadata through the existing bounded local `file_list_dir` command, reuses File Explorer material icons, and never sends local directory browsing requests to the SSH Agent.
- Host SFTP direct upload uses protocol `1.13` `filePut` and the current browsing directory. It never reuses `fileAttachAny`, never creates a session/UUID directory, and never sends a local path to the Agent. Older Agents return `ssh_agent_capability_missing:filePut` and the UI shows an upgrade action.
- Host SFTP download/delete use protocol `1.14` `fileGet`/`fileDelete` and the current browsing directory. Downloads preserve arbitrary regular-file bytes in a user-selected local path; deletes are confirmed in the UI and only remove regular files or empty directories. Older Agents return the matching capability error and the UI keeps the remote listing unchanged.
- Arbitrary-file upload accepts any non-empty regular file up to 20 MiB without an extension or MIME allowlist. Directories and symlinks remain rejected. The Desktop checks metadata and then reads at most 20 MiB + 1 byte so a file-growth race cannot cause unbounded allocation. A basename must be 1–255 bytes, cannot be `.` / `..`, and cannot contain path separators, NUL, CR, or LF. Legacy `fileAttach` remains limited to PNG, JPG/JPEG, GIF, WebP, and BMP, 5 MiB, and 12 million pixels.
- Begin declares byte length and SHA-256, chunks carry an exact monotonic offset, finish verifies length/hash and performs a same-directory atomic rename. Legacy images additionally verify dimensions and decodability. Abort, bridge shutdown, and failed finish remove partial files and empty per-upload directories.
- With an empty Host root, legacy images live at `${XDG_CACHE_HOME:-$HOME/.cache}/cli-manager-ssh-agent/attachments/<session-id>/<uuid>.<ext>`. With a configured root, the Agent uses `<expanded-root>/cli-manager-ssh-agent/attachments` and keeps the same session/upload layout. Arbitrary files preserve the safe original basename without permitting traversal or collisions. Directories use `0700` and files `0600` on Unix. Attachments never enter the SSH project root; bounded cleanup removes files older than 48 hours only below the Agent-managed child and never follows symlinks or removes unrelated parent files.
- Clipboard image objects, native clipboard file paths (including screenshot-tool temporary paths), context-menu paste, and native file drop use the same SSH attachment transport. Host-only SSH terminals use their saved session Host/remote path even when no project is registered; local terminals retain the existing local path behavior. Internal remote file-explorer drags already carry remote references and must not be uploaded again.
- Agent Diff options accept only whitespace `exact | ignore-eol | ignore-all` and context `3 | 10 | 20`. Invalid fields or values are rejected at deserialization/validation; non-exact payloads always set `canRevertHunks=false`.
- Every tracked, untracked, legacy, and option-aware Agent Diff response passes through one final payload gate. More than 768 KiB or 20000 Rust `str::lines()` is `git_diff_too_large`; never return a truncated patch or partial-revert capability.
- `byteLength` and `lineCount` are additive response fields. New Desktop builds derive them when an older Agent omits them, so this does not require a new request kind or capability.
- Diff limits apply to existing text handling only. Remote image, office, archive, audio, and video Diff are not introduced by `gitFull` or `gitDiffOptions`.
- Desktop install and the HTTP(S) script consume the same schema-1 release manifest and Tauri updater Minisign trust root. The signature covers manifest bytes; the manifest pins channel, semantic version, protocol range, Linux target, URL, size, and SHA-256.
- Release URLs default to HTTPS. HTTP requires explicit user opt-in, never permits embedded credentials, query strings, or fragments, and still requires a valid signature. Manifest, signature, and artifact downloads are bounded.
- Install preview is read-only. Confirmation re-fetches and re-verifies the manifest before downloading or opening SSH, preventing a stale preview from authorizing different bytes.
- The desktop uploads the verified artifact through `ssh -T` stdin to a random state-directory staging path. The remote shell receives only fixed commands plus POSIX-quoted validated values; the WebView never assembles an unrestricted shell program.
- The Agent owns installation transactions: an exclusive lock, `versions/<version>`, atomic `current`/`previous` symlinks, a CLI-Manager-owned `$HOME/.local/bin` launcher, and an atomic XDG state `installation.json` discovery record.
- Existing custom install roots are reused from the discovery record when no new root is supplied. A corrupt record is archived and repaired by an explicit install. A valid current binary remains the downgrade authority even if the record is missing.
- Downgrades are rejected unless explicitly allowed. A failed promote restores `current`, `previous`, and the launcher. Rollback swaps only distinct valid versions and restores links if self-check or record persistence fails.
- Uninstall quarantines managed versions before removing links and the discovery record; a failure restores all original links and versions. Normal uninstall keeps one bounded record, while `--purge` removes Agent state. No Agent lifecycle command modifies Claude/Codex/Kimi Hook configuration.
- Operation JSON is accepted only after strict marker, action, UUID, version, protocol, target, path, source, manifest URL, and SHA-256 validation. Arbitrary remote output is never persisted.
- Hook config requests use the Host/tool `configuredConfigRoot`; empty means the source-native default (`$HOME/.claude`, `$HOME/.codex`, or `$HOME/.kimi-code`). Inspect and preview never create directories. Confirmed install may create only a missing native default root; a missing custom root is rejected.
- Hook reports return the configured and canonical roots, `configRootHash`, actual canonical config files, fingerprints, change actions, Agent installation/machine identity, and an installation record. The desktop validates every field before persisting `hook_record_json`.
- Kimi Hook operations use source `kimi`, default root `$HOME/.kimi-code`, and the single `kimiConfig` role at `<root>/config.toml`. SSH launch injects `KIMI_CODE_HOME` only when a non-empty Host/project effective root is configured; an empty root preserves the remote login environment and Kimi's native default. Local terminal launch does not inherit this SSH behavior.
- Kimi runtime admits exactly `SessionStart`, `UserPromptSubmit` (from native `TurnStarted`), `PermissionRequest`, `PermissionResult`, `Stop`, `Interrupt`, `StopFailure`, `SubagentStart`, and `SubagentStop`. Other Kimi events fail source/event admission.
- Hook report `requiredEntries` is Agent-owned capability data, not a Desktop per-source constant. The Desktop accepts `1..=64`, requires `managedEntries <= requiredEntries`, and for an installed record requires its `managedEntries == requiredEntries`; this keeps old and new Agent Hook sets compatible without trusting unbounded remote counts.
- A later inspect refresh preserves the last validated `HookInstallationRecord` for the same canonical root until explicit uninstall. Host-primary and project-override rows that resolve to the same Host/source/canonical root mirror the same Hook report so one physical installation cannot appear installed in one scope and absent in another.
- Local Hook report persistence uses one backend-owned SQLite connection and one bounded transaction. Frontend SQL pool calls must not split `BEGIN`, mutations, and `COMMIT` across separate invocations. A failed root rotation or mirror update rolls back every affected integration row.
- Claude JSON, Codex JSON/TOML, and Kimi `config.toml [[hooks]]` are parsed structurally. Install normalizes only exact Agent-owned duplicates in place; uninstall removes only the exact parsed path/source/event/owner/installation command. Unknown events and third-party fields, array order, matchers, symlinks, TOML comments, similar commands, and user-owned `features.hooks = true` remain intact. Substring ownership is forbidden.
- Grok install changes only a missing or `true` `compat.claude.hooks` / `compat.cursor.hooks` value
  to `false`. Each actual change carries the complete suffix marker
  `# cli-manager-ssh-agent installation=<id> previous=<true|missing> compatCreated=<bool> vendorCreated=<bool>`;
  an already-`false` value is user-owned and receives no marker. Uninstall restores only a still-
  `false` value with the current installation's complete marker, preserving its original comments;
  it removes a vendor or `compat` table only when the marker proves the Agent created it.
- Kimi config planning requires current Kimi Code doctor capability and validates the staged candidate with `kimi doctor config <candidate>` before commit. Legacy `kimi-cli`, missing capability, or candidate rejection is an explicit error and leaves live bytes untouched; `~/.kimi` is never inspected or migrated.
- Hook installation records carry an optional `historySourceCandidate`: Claude/Codex require a matching candidate; Kimi requires it to be absent. Persisting a Kimi Hook report must leave `history_source_instance_id` empty and must never enqueue history work.
- Config writes hold a per-root lock, verify preview fingerprints and current symlink targets, journal original bytes/mode, atomically replace files, reread, and roll back safely. A stale or externally edited target returns a conflict instead of overwriting it.
- Hook execution requires all reserved Host/client/project/Tab/bridge-epoch variables. Missing or invalid binding is a successful no-op. Runtime errors are swallowed by the `hook` CLI so Claude/Codex/Kimi is never blocked.
- The full 64-character Hook spool namespace remains the durable isolation key. Unix bridge socket and PID filenames use the same deterministic 96-bit shortened digest so bind and notify agree while the default fallback runtime path stays below the Linux `AF_UNIX` path limit.
- Hook stdin is limited to 1 MiB and normalized through `hook-schema`. Prompt/message text is removed before spooling. Remote transcript paths remain opaque references and never become desktop-local paths.
- Spool/socket namespace is `SHA-256(hostId, clientInstanceId, installationId)`. It is bounded by 24 hours, 10000 records, and 32 MiB; overflow emits a sequenced `gap`. A stale PID lock is recoverable, JSONL/meta divergence rebuilds monotonic sequence state, ACK removes only confirmed records, and reconnect dedup covers the full bounded spool.
- Bridge hello requires Host/client/installation identity and reports remote machine identity. The desktop also validates every event against the live daemon session's Host/client/project/Tab/epoch/installation/source binding before routing it to the existing Hook sink.
- SSH PTY launch injects Agent bridge identity only when the effective Host/source/configured root has a locally validated `installed` Hook report whose Agent installation and remote machine identities still match. Agent installation alone must not create a background Hook bridge.
- The daemon owns one bridge entry per Host/client connection fingerprint while every PTY remains independent. Address, SSH user/config alias, auth, identity/credential reference, jump/proxy settings, Agent identity/path, ConnectTimeout, or KeepAlive changes replace the old bridge without holding the global registry lock during process shutdown.
- A primary bridge Hook drain reserves its idle slot for the full long-poll/ACK cycle. File requests reuse the primary bridge only when they win that slot first; otherwise they use the isolated read-only bridge and never queue behind Hook long polling. The isolated read-only and Host-scoped Git lanes are request-driven, keep their heartbeat, and never poll an unrelated Hook spool. Git reads/writes remain serialized so a refresh cannot observe a write in progress. Bridge startup, authentication, handshake, capacity, and closed-request-queue failures are delivered immediately to queued consumers; a dropped response channel is never reported as a response timeout.
- Every Git request must carry the exact SSH project `remotePath` as `rootPath`; the Tauri command rejects a mismatch before opening the Agent bridge. The Agent then canonicalizes that root and confines every repo-relative path beneath it. An SSH Git context that is pending or unavailable is a hard error and must never select the local Git transport.
- At most four bridge processes and two concurrent connect/reconnect handshakes run globally. A fifth active Host waits without opening SSH; releasing its last session cancels that wait. Probe/install one-shot processes do not consume a bridge permit.
- Bridge stdout is consumed by a bounded 32-frame reader queue. Login banner plus preamble must complete within `min(ConnectTimeout + 10s, 60s)`; hello, ACK, ping, and ordinary responses have a 10-second bound. Timeout or disconnect kills/reaps the local SSH child before retry.
- Bridge stderr is always drained but only the first 8 KiB is retained in memory for classification. Permission/passphrase/keyboard-interactive failures become `ssh_interactive_auth_required`; Host Key failures become `ssh_host_key_verification_required`; raw stderr is never persisted or logged.
- Application heartbeat uses ping/pong every 10 seconds in addition to OpenSSH KeepAlive. Reconnect uses 1/2/5/10/30/60-second backoff with deterministic +/-20% Host jitter, resets after a connection survives 30 seconds, and limits `bridge_already_active` to a retried takeover state instead of a permanent failure.
- Cancellation IDs are validated and held in a bounded 1024-entry registry. Unknown frame kinds return a versioned error without closing the bridge; invalid request IDs/kinds, oversized frames, contaminated preamble/frame streams, or malformed response identities close it.
- Hook batches are accepted only when at most 128 records have strictly increasing sequences above the current cursor and the final sequence equals `latestSequence`; ACK must echo `accepted=true` and the exact sequence. Remote error codes are limited to 128 ASCII identifier bytes before logging.
- Spool drain and ACK use bounded per-record streaming rather than loading the full 32 MiB file. A malformed or over-1-MiB record fails closed and preserves the original spool; ACK temporary files are removed on failure.
- Remote history list/search/detail requests reuse the Host bridge and remain project-scoped. Agent cursors use `generation:offset`; full detail uses ordered 256-KiB chunks under the existing 1-MiB frame limit and a 64-MiB aggregate cap. Desktop `historyGet.remoteTranscriptRef` is always a non-null string on the wire; ordinary historical detail sends `""`, while realtime detail may send a Hook-provided opaque Agent-side locator. This preserves compatibility with published Agent `0.1.3`, whose request field is a Rust `String`; the Agent canonicalizes non-empty refs under the configured source root, requires a regular `.jsonl` file, parses only that file, and rejects a session-id or project-scope mismatch.
- Desktop remote-history commands must wait for PtyHost daemon readiness like terminal creation does. Starting the app and immediately opening SSH history must not fail with a raw `daemon_unavailable` just because the background daemon connection thread has not populated `DaemonBridge` yet.
- `historySync.forceRefresh` defaults to `false`. A complete compatible index covering the requested project paths serves non-forced pages without acquiring the Agent writer lock, walking history roots, or rewriting the index. Forced, partial, missing, incompatible, and scope-expansion requests run recent-first incremental discovery; no-change refreshes preserve the published file.
- Frontend single-flight keys include every result-affecting scope, cursor, limit, and refresh field but exclude the UI `consumerId`. The shared RPC uses its own ephemeral bridge consumer and releases it after settlement so one window's close cannot stop another window's request.
- Desktop remote-history consumers validate installation/machine/user/source/config-root/source-instance identity on initial and continuation pages. Detail chunks additionally validate request identity, sequence, total, aggregate size, and one request deadline.
- `sourceInstanceId` remains stable across Agent reinstall/upgrade because its identity is machine/user/source/config-root. The current RPC must still match the launch plan's `installationId`, but catalog apply treats `installationId` and Host binding as rotatable metadata and atomically replaces them after the stable source identity matches.
- Resume preflight remains Claude/Codex-only: it reopens the indexed artifact, validates the stable source identity, verifies the original JSONL is still readable, canonicalizes an enterable absolute POSIX cwd, checks the standard executable, and returns structured resume args plus the canonical config-root environment override. Kimi is rejected before history metadata or Agent history work is created.
- Agent uninstall returns `agent_managed_hooks_present` while any Agent Hook installation record remains. Hook uninstall does not delete the configured root, future history source identity, or unrelated Agent state.
- If a custom config root was deleted externally, install/inspect still report it missing, but preview-uninstall/uninstall may recover exactly one matching canonical identity from the bounded Agent-owned record set and remove that stale record without recreating the directory. Retained-root cleanup also sends the previously validated `expectedCanonicalRoot`; if the configured path is a symlink that now resolves elsewhere, only an exact unique Agent record may route cleanup back to the old canonical root. Ambiguous, missing, invalid, or retargeted canonical records fail closed.
- Remote Hook third-party notification jobs omit remote cwd, transcript refs, Host/project/session/Tab identifiers, and prompt text. Their optional display project is the daemon-validated sidebar project name captured at launch, never a remote cwd basename or remote event field.
- SSH combination writes use explicit `ssh_db_*` commands. Each command opens the primary database with WAL, foreign keys, and a 15-second busy timeout, then keeps all dependent reads and writes inside one short `BEGIN IMMEDIATE` transaction on that connection.
- `ssh_db_record_history_source` validates Host/installation UUIDs, source/scope, stable `ssh-<64 hex>` identity, canonical POSIX root, and 64-hex config hash before opening the database. It idempotently updates or inserts the integration row and maps busy/locked failures to `ssh_agent_history_metadata_busy`.
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
| Agent manifest version differs from Agent Cargo package version or an Agent Tag differs from `ssh-agent-v<version>` | fail the release workflow |
| Linux Agent requires a GLIBC symbol newer than 2.17 | fail the release workflow |
| Independent Agent prerelease changes GitHub desktop latest Release | fail the release workflow |
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
| Primary Hook/history lane has an empty `toolSource` | reject bridge creation; request path returns `ssh_agent_identity_required` |
| Request-driven Readonly file/attachment or Git lane has an empty `toolSource` | accept it; Agent path, installation, machine, client, Host, and bridge identities remain mandatory; `projectId` may be empty for Host-only attachment |
| Hook batch sequence/latest/ACK mismatch | close bridge without advancing the cursor |
| Remote continuation identity changes | `history_remote_identity_changed`; preserve the previous catalog rows |
| Agent reinstall changes only `installationId` while machine/user/source/config-root stay stable | accept the same source instance and update catalog metadata atomically |
| Remote history page uses a complete covered index without force | return from the published index without an Agent writer lease or index write |
| Main history-integration metadata remains locked after 15 seconds | `ssh_agent_history_metadata_busy`; do not expose raw SQLite code 5/6 |
| Detail chunks are reordered, duplicated, oversized, or exceed the deadline | close/fail the request without caching partial detail |
| Ordinary `historyGet` has no Hook transcript reference | Desktop sends `remoteTranscriptRef: ""`, never JSON `null`; Agent resolves the session through its index |
| Realtime transcript ref escapes the configured root, is not a regular `.jsonl`, or parses to another session/project | `history_artifact_*` / `history_session_identity_mismatch`; return no detail and do not fall back to discovery |
| Resume source JSONL or cwd is missing | `remote_session_source_missing` / `remote_session_cwd_unavailable`; create no PTY |
| Another daemon consumer owns the same source-instance/session | `remote_session_active_elsewhere` |
| Remote file root is not absolute/canonical or a relative path escapes through `..`/symlink | stable `remote_file_root_*` / `remote_file_path_*` error; no local fallback |
| Remote file is binary | `remote_file_binary` |
| Remote text/other file exceeds 1 MiB | `remote_file_too_large` |
| Remote image exceeds 5 MiB | `image_file_too_large` |
| Remote raster image exceeds 12,000,000 pixels | `image_dimensions_too_large` |
| Remote path has a known video extension | `video_preview_unsupported` |
| Local attachment path is relative, a directory, or a symlink | `attachment_local_path_invalid`; read no bytes and send no Agent frame |
| Attachment basename is empty, `.` / `..`, over 255 bytes, or contains a separator/control newline | `attachment_name_invalid`; create no cache entry |
| Arbitrary attachment is empty or exceeds 20 MiB | `attachment_empty` / `attachment_too_large`; reject at both Desktop and Agent boundaries |
| Agent lacks `fileAttachAny` | retry only a validated legacy image through `fileAttach`; otherwise return `ssh_agent_capability_missing:fileAttachAny` |
| Configured attachment root is relative, traverses `..`, contains control characters/backslashes, or resolves through a symlink/non-directory | `ssh_attachment_root_*` / `attachment_root_invalid`; do not create an upload directory |
| Configured attachment root is non-empty but Agent lacks `fileAttachCustomRoot` | `ssh_agent_capability_missing:fileAttachCustomRoot`; reject before writing the Begin frame and do not use the default root |
| Host attachment directory discovery is requested but Agent lacks `fileAttachmentRoot` | show the remote directory as unavailable; Host uploads remain available and must use the negotiated attachment protocol |
| Host SFTP upload is requested but Agent lacks `filePut` | return `ssh_agent_capability_missing:filePut`; do not fall back to `fileAttachAny` or send a local path |
| Host SFTP root is invalid, unavailable, or not a directory | return `remote_file_root_invalid` / `remote_file_root_unavailable` / `remote_file_not_directory`; create no partial file |
| Host SFTP target basename is invalid or the target already exists | return `attachment_name_invalid` / `attachment_target_exists`; preserve the existing target |
| Host SFTP download is requested but Agent lacks `fileGet` | return `ssh_agent_capability_missing:fileGet`; do not write a local file |
| Host SFTP download chunks are reordered, inconsistent, oversized, or incomplete | return a stable `ssh_agent_bridge_file_get_chunk_*` / timeout error; write no local file |
| Host SFTP download target is not an absolute regular-file destination with an existing non-symlink parent | return `attachment_local_path_invalid` / `local_directory_unavailable`; write no local file |
| Host SFTP delete is requested but Agent lacks `fileDelete` | return `ssh_agent_capability_missing:fileDelete`; do not alter the remote path |
| Host SFTP delete targets the root, a traversal/symlink, an unsupported entry, or a non-empty directory | return `remote_file_path_*` / `remote_file_directory_not_empty` / `remote_file_delete_*`; do not recursively delete |
| Attachment chunk offset, final size, or SHA-256 differs | stable `attachment_*_mismatch`; delete partial content and its empty upload directory |
| Spool record is malformed or over 1 MiB | stable `hook_spool_record_*` error; preserve original spool |
| Custom Hook config root is missing | `hook_config_root_missing` |
| Deleted custom root has one valid matching Agent record during uninstall | use its canonical identity for no-op config cleanup and remove the record |
| Deleted custom root has multiple or invalid matching records | `hook_config_record_conflict` / `hook_config_record_invalid` |
| Configured-root symlink now points from canonical root A to B | uninstall based on a stored Hook report carries `expectedCanonicalRoot=A` and uses one exact Agent record; a direct request without an expected identity follows the current B root |
| Hook JSON/TOML is malformed or a managed event has an invalid shape | stable `hook_config_*_invalid` error; no write |
| Grok `compat`, a vendor entry, or its `hooks` item has an incompatible TOML type | `hook_config_toml_compat_invalid`, `hook_config_toml_compat_vendor_invalid`, or `hook_config_toml_compat_hooks_invalid`; no write |
| Grok value is already `false`, its marker is incomplete/mismatched, or the value changed after install | treat it as unowned and leave it unchanged during uninstall |
| Preview fingerprint or symlink/root target changed | `hook_config_changed` / `hook_config_root_changed` |
| Another live Hook config transaction owns the root lock | `hook_config_locked` |
| SSH multi-row write cannot obtain/commit its SQLite transaction | stable `ssh_database_begin_failed` / `ssh_database_commit_failed`; no partial mutation |
| Hook report nested identity differs from top-level command input | `ssh_hook_report_invalid`; no write |
| Hook report has zero or more than 64 required entries, or managed entries exceed required entries | `ssh_agent_hook_count_invalid`; no report persistence |
| Explicit integration belongs to another source | `ssh_hook_integration_identity_changed`; no write |
| SSH Config import exceeds 10000 hosts | `ssh_config_import_too_many_hosts`; no write |
| Local Hook metadata remains write-locked after the bounded wait | `ssh_agent_hook_metadata_busy`; preserve all integration rows |
| CLI-Manager marker belongs to another installation or placement | status `conflict` / `hook_config_owner_conflict` |
| Spool JSONL was appended but meta is stale | rebuild count/bytes/next sequence before append |
| Git request root differs from `SshLaunchPlan.remotePath` | `remote_git_root_mismatch`; do not open the Agent bridge |
| Git capability `gitFull` is absent | `ssh_agent_capability_missing:gitFull`; do not downgrade to read-only or local Git |
| Non-default Diff requested without `gitDiffOptions` | `ssh_agent_capability_missing:gitDiffOptions`; reject before writing to the Agent |
| Diff context is not `3`, `10`, or `20` | `remote_git_diff_options_invalid`; do not execute Git |
| Final Diff exceeds 768 KiB or 20000 lines | `git_diff_too_large`; no partial Patch response |
| Untracked Git diff target is a symlink or directory | `remote_git_symlink_rejected`; do not follow or read the target |
| Git status contains an ordinary untracked directory | enumerate its files with `--untracked-files=all`; never return a trailing-slash pseudo-file |
| Git path list exceeds count or aggregate byte bound | `remote_git_paths_invalid` |
| Root repository uses `repoPath == ""` | accept it only for repository resolution; file paths still require a non-empty relative path |
| SSH Git context is pending, missing, or stale | `ssh_agent_context_unavailable`; do not invoke any local `git_*` command |

## 5. Good / Base / Bad Cases

- Good: four PTYs on one Host retain independent interactive SSH processes while an explicit Agent probe uses one short-lived `ssh -T` process.
- Good: a login banner precedes the marker by less than 8 KiB; the doctor report is parsed and only sanitized metadata is stored.
- Base: the Agent is absent; the UI records `notInstalled` without installing anything or modifying Hook configuration.
- Base: MFA authentication requires an interactive terminal; the probe reports `authenticationRequired` and does not retry.
- Good: a signed x64/aarch64 artifact is uploaded through stdin, self-checks from staging, atomically becomes `current`, and leaves the former version as `previous`.
- Good: an existing custom install root is upgraded in place without needing to repeat `--install-dir` inside the Agent transaction.
- Good: Claude and Codex Hooks use different roots; preview shows actual files, confirmation preserves third-party entries, and both tools can be removed independently.
- Good: an Agent release adds a Hook template and increases `requiredEntries`; the Desktop accepts the bounded self-consistent report without a matching hardcoded count update.
- Bad: hardcode Claude/Codex Hook counts in the Desktop validator; Agent template additions then make inspect, preview, and apply fail together.
- Good: Grok disables an existing `compat.claude.hooks = true # user note`, then uninstall restores `true # user note`; a pre-existing `compat.cursor.hooks = false` stays false throughout.
- Base: a missing Grok `compat` hierarchy is created for install and removed again on uninstall, while unrelated TOML tables remain intact.
- Bad: an uninstall sees an incomplete or another installation's Grok marker and re-enables the value; the value is not Agent-owned and must remain unchanged.
- Good: the desktop disconnects, events spool under the bound Host/client namespace, and reconnect replays each event at most once before ACK deletion.
- Good: four Host bridges are connected, a fifth waits without starting SSH, and closing one Host releases a permit for the waiting Host.
- Good: an SSH project file panel reuses its Host bridge, lists only canonical-root descendants, skips symlinks, and reads bounded UTF-8 text or supported image data URLs.
- Good: a Host-only SSH terminal with no registered project opens an isolated Readonly bridge for attachment upload using its saved Host/remote path while keeping Agent installation and machine identity checks.
- Good: a Unicode-named extensionless file below 20 MiB is stored as `<session>/<uuid>/<original-name>` and the terminal receives only that remote path.
- Good: two Hosts configure different attachment parents; each receives its own Agent-managed child and cleanup in one Host's subtree never removes the other Host's files or unrelated parent files.
- Good: the SSH Host list opens a two-pane attachment panel; the remote pane uses `fileAttachmentRoot` instead of guessing the remote HOME/XDG cache, while an older Agent can still upload and report the returned absolute path.
- Good: the SSH Host list opens a two-pane SFTP panel at the configured `/data` directory, lists its existing files, accepts a manually entered child directory, and writes an uploaded file directly to that directory without a UUID child.
- Base: an older Agent can still serve the existing read-only listing/default-root discovery paths, but a Host SFTP upload stops with an explicit `filePut` upgrade error; terminal pastes continue using their existing attachment protocol.
- Base: Agent 0.1.6 lacks `fileAttachAny`; a valid 5 MiB-or-smaller image retries through `fileAttach`, while a ZIP returns an update-required error.
- Bad: infer file contents from `.png` and force the legacy image protocol; an arbitrary file with that suffix would be rejected despite the no-type-restriction contract.
- Bad: fall back to pasting the desktop-local path when arbitrary upload is unsupported; the remote CLI cannot read it and may receive sensitive local path text.
- Bad: apply the Primary Hook/history `toolSource` gate to every non-Git lane; generic file requests then fail with `ssh_agent_identity_required` before contacting an installed Agent.
- Good: remote video, byte-size, and raster-pixel checks run before file reads and Base64 conversion; the desktop also prechecks directory metadata to avoid unnecessary RPCs.
- Bad: relying only on WebView `<img>` sizing after a high-pixel image has already crossed the SSH bridge as Base64.
- Good: an SSH terminal stats panel with a Hook session id and transcript ref reads only that bounded JSONL through the Agent, while stale/offline failures preserve the last bounded snapshot without local path fallback or full history discovery.
- Good: an ordinary SSH history detail request has no Hook transcript ref, so Desktop sends `remoteTranscriptRef: ""`; Agent `0.1.3` deserializes the string and resolves the session through its published index.
- Base: a realtime detail request has a Hook transcript ref; Desktop preserves the non-empty opaque string and Agent applies its existing root/type/session/project validation.
- Bad: encode a missing `remoteTranscriptRef` as JSON `null`; Agent `0.1.3` declares the field as Rust `String`, so request deserialization fails with `history_request_invalid` before history lookup runs.
- Good: two windows request the same remote-history page, share one ephemeral bridge consumer and one metadata transaction, then either window may close without interrupting the request.
- Base: the Desktop catalog is missing while the Agent index is complete; the first non-forced page is awaited and returned without scanning.
- Good: deleting a Host either clears project/integration references and deletes the Host together, or rolls the entire operation back.
- Good: two different SSH Hosts save preferences concurrently; SQLite coordinates only their short write sections and no application-wide CRUD mutex serializes them.
- Base: two imports contain the same config alias; the later transaction observes the normalized existing alias and reports it as skipped.
- Bad: issue `BEGIN IMMEDIATE`, updates, and `COMMIT` as separate `tauri-plugin-sql` calls and assume the pool preserves connection affinity.
- Bad: pass a remote absolute path to local `file_*`/Git commands, expose create/save/delete/move/external opener actions, or traverse more than the Agent file quotas.
- Good: while an SSH project is still building its Agent context, Git actions fail closed; once ready, `rootPath` equals the launch plan and only the dedicated Git lane is used.
- Good: Agent repository validation allows the empty `repoPath` that identifies the configured root repository, while `validate_file_path` continues to reject an empty file path.
- Good: an untracked `test/c.txt` is returned as that exact file path; a nested repository remains in repository enumeration and does not become a blank file row in its parent repository.
- Good: Agent `0.1.4` receives field-compatible legacy `gitDiff` for `exact+3`; Agent `0.1.5` receives `gitDiffWithOptions` only after advertising `gitDiffOptions`.
- Base: ignored whitespace removes every visible Hunk; return an empty payload with partial revert disabled instead of the legacy exact-mode empty-Diff error.
- Good: an older Agent omits Diff metadata; Desktop derives it and still rejects content above the same hard limits.
- Bad: return `remote_git_diff_too_large` on one path and `git_diff_too_large` on another, or truncate before enabling revert.
- Bad: serialize a non-default Diff request before checking capabilities, or include `options` in a legacy request whose payload denies unknown fields.
- Bad: let a missing SSH context make `createGitTransport` silently choose the local transport, or allow a symlinked untracked file to be read by `fs::read`.
- Bad: validate an allowed-empty `repoPath` with the same non-empty path-segment check as file paths; the root repository then fails every Git read with `remote_git_path_invalid`.
- Good: a replaced bridge briefly receives `bridge_already_active`, backs off, then takes ownership after the old Agent process removes its socket.
- Base: a missing or malformed discovery record is reconstructed only after an explicit install; no page-open or probe action changes remote files.
- Base: Claude/Codex/Kimi launched from an ordinary SSH shell has no binding variables; the installed Hook exits successfully without writing spool data.
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
- Assert protocol minor 3 history capability negotiation, generation cursors, continuation identity, chunk ordering/size/deadline, detail LRU eviction, consumer release, and direct transcript-ref root/type/session/project confinement.
- Assert Desktop `historyGet` payload encoding maps a missing transcript ref to the JSON string `""`, preserves a non-empty direct ref unchanged, and never emits JSON `null` for the Agent `String` field.
- Assert remote-history complete-index reuse, force/scope/partial refresh routing, recent-first discovery, unchanged no-write behavior, shared-request consumer lifetime, main-metadata busy mapping, idempotent update, and rollback.
- Assert protocol minor 4 resume capability and protocol minor 5 remote-file capability, structured Claude/Codex args, source/cwd validation, ownership claim/release, and implicit SSH Config username handling.
- Assert remote file root/path confinement, symlink escape rejection, binary refusal, 1 MiB text and 5 MiB image limits, the exact 12,000,000-pixel boundary, video refusal, directory/search/visited limits, image data URLs, request-driven read-only scheduling, Primary-only `toolSource` enforcement, empty-source Readonly/Git admission, primary Hook-poll exclusion, loaded-directory reuse, consumer release, and UI/store read-only routing.
- Assert protocol minor 7 and `gitFull`, dedicated Git-lane serialization and identity isolation, exact launch-root binding, strict per-RPC payloads, full Git mutation/network operations, write timeout/no-retry result-unknown handling, path/branch/patch validation, untracked symlink rejection, and SSH-pending fail-closed transport selection.
- Assert protocol minor 8 and `gitDiffOptions`, legacy `exact+3` payload compatibility, pre-serialization capability rejection, all three whitespace flags, 3/10/20 context values, invalid-option rejection, and non-exact partial-revert disablement.
- Assert protocol minor 10/12/13/14, legacy `fileAttach`, `fileAttachAny`, `fileAttachCustomRoot`, optional `fileAttachmentRoot`, `filePut`, `fileGet`, and `fileDelete`; safe arbitrary basenames, 20 MiB admission, legacy image limits, default/custom cache/session/upload confinement, direct Host root/relative path validation, no-UUID direct commit, existing-target rejection, POSIX/Home root validation, symlink-component rejection, managed-child cleanup isolation, chunk size and offset validation, download chunk ordering/size and binary preservation, empty-directory-only deletion, size/pixel/SHA-256 verification, atomic commit, abort/drop cleanup, nested 48-hour expiry, Agent 0.1.6 image compatibility, old-Agent arbitrary-file/custom-root/root-discovery/filePut/fileGet/fileDelete rejection, Host-only versus project SSH paste routing, Host-list transfer isolation, and local-versus-SSH paste routing.
- Assert tracked/untracked payload metadata, inclusive 768 KiB and 20000-line boundaries, and stable `git_diff_too_large` parity with Desktop.
- Assert `validate_relative("", true)` succeeds for the root repository, while `validate_relative("", false)` and empty file paths remain rejected.
- Assert ordinary untracked directories expand to concrete files and nested repositories are excluded from the parent repository's change list.
- Assert manifest tampering, duplicate/unknown targets, HTTP opt-in, query/fragment rejection, target selection, size/SHA-256 mismatch, and bounded downloads.
- Assert install path quoting, strict operation markers/metadata, semantic version actions, lock conflicts, default/custom roots, corrupt/missing discovery recovery, promote rollback, distinct previous versions, and transactional uninstall.
- Assert Claude/Codex/Kimi exact-owner merge, duplicate normalization, unknown-event preservation, invalid JSON/TOML refusal, Kimi similar-command isolation/current-product doctor/candidate validation, user-owned TOML/comment preservation, symlink target change refusal, fingerprint conflict, journal rollback, and Agent uninstall blocking.
- Assert Grok install/uninstall restores only same-installation marker-backed `true`/missing compat values, preserves pre-existing `false`, comments and unrelated fields, removes only Agent-created tables, ignores incomplete/foreign markers and user edits, and accepts dotted TOML forms.
- Assert Kimi reports only `kimiConfig`, admits exactly its nine bridge events, omits `historySourceCandidate`, never writes history metadata, and remains rejected by history sync/detail/resume commands while Claude/Codex records still require matching history candidates.
- Assert Desktop Hook report validation accepts current and legacy positive entry counts, rejects zero and counts above 64, rejects `managedEntries > requiredEntries`, and requires installed-record counts to match the report.
- Assert missing binding no-op, event allowlists, 1 MiB stdin bound, message redaction, Host/client/installation namespace isolation, stale lock recovery, monotonic meta rebuild, TTL/count/byte gap, streaming read/ACK, malformed-record preservation, monotonic batch/ACK validation, full-window event/gap dedup, and Claude/Codex/Kimi remote notification cwd redaction plus trusted project-name propagation.
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

### Wrong: require CLI source identity on every non-Git bridge

```rust
lane != BridgeLane::Git && plan.tool_source.is_empty()
```

### Correct: require CLI source identity only for the Primary Hook/history lane

```rust
lane.requires_tool_source() && plan.tool_source.is_empty()
```

Readonly file/attachment and Git lanes are request-driven Agent capabilities. They retain the full Agent installation and machine identity gate without inventing a CLI source.

### Wrong: select attachment semantics from the filename extension

```rust
let kind = if file_name.ends_with(".png") {
    "fileAttachBegin"
} else {
    "fileAttachAnyBegin"
};
```

### Correct: prefer the arbitrary-file capability and narrowly retain legacy compatibility

```rust
let response = request("fileAttachAnyBegin").or_else(|error| {
    if error == "ssh_agent_capability_missing:fileAttachAny" && is_valid_legacy_image(bytes) {
        request("fileAttachBegin")
    } else {
        Err(error)
    }
})?;
```

This prevents a misleading extension from reintroducing a type restriction while keeping Agent
0.1.6 image paste usable.

### Wrong: map an absent Agent string field to JSON null

```rust
payload["remoteTranscriptRef"] = remote_transcript_ref
    .map(Value::String)
    .unwrap_or(Value::Null);
```

### Correct: normalize the optional Desktop value to the Agent wire type

```rust
payload["remoteTranscriptRef"] =
    Value::String(remote_transcript_ref.unwrap_or_default());
```

The Desktop option expresses whether a direct locator is available; the Agent wire contract remains a non-null string, with `""` selecting indexed lookup.

### Wrong: duplicate Agent Hook counts in the Desktop

```rust
let required = if source == "claude" { 11 } else { 6 };
```

### Correct: validate the Agent-owned count as bounded protocol data

```rust
let required = report.required_entries;
if required == 0 || required > MAX_AGENT_HOOK_ENTRIES || report.managed_entries > required {
    return Err("ssh_agent_hook_count_invalid".to_string());
}
```

The Agent owns the Hook template list. The Desktop owns boundary validation and must not duplicate the list length.

### Wrong: blindly reset Grok cross-tool compatibility on uninstall

```rust
document["compat"][vendor]["hooks"] = value(true);
```

### Correct: restore only a current-installation-owned marker-backed value

```rust
let Some((previous, compat_created, vendor_created, original_suffix)) =
    parse_grok_compat_marker(&marker_suffix(item), installation_id)
else {
    return Ok(false); // user-owned, foreign, incomplete, or subsequently changed
};
```

The marker records the original `true`/missing state and table ownership. This prevents uninstall
from enabling a user-disabled integration or deleting user-owned configuration.

### Wrong: add fields to the published legacy Git Diff payload

```ts
request("gitDiff", { repoPath, relativePath, status, options });
```

### Correct: keep the legacy payload exact and capability-gate the new request

```ts
const legacy = isDefaultGitDiffOptions(options);
request(
  legacy ? "gitDiff" : "gitDiffWithOptions",
  legacy ? { repoPath, relativePath, status } : { repoPath, relativePath, status, options },
);
```

The daemon rejects `gitDiffWithOptions` before writing a frame when `gitDiffOptions` was not negotiated.

### Wrong: return one Diff path without the final size gate

```rust
Ok(GitFileDiffPayload { content, can_revert_hunks })
```

### Correct: converge every Agent Diff path on one payload builder

```rust
build_diff_payload(content, can_revert_hunks)
```

This keeps tracked, untracked, legacy, and option-aware requests on the same metadata and `git_diff_too_large` contract.

### Wrong: treat an SSH Git request as local when the Agent context is not ready

```ts
return createGitTransport(projectRoot, remoteContext); // null silently means local
```

### Correct: make the remote requirement explicit and fail closed

```ts
return createGitTransport(projectRoot, remoteContext, remoteRequired);
// remoteRequired && !remoteContext -> ssh_agent_context_unavailable
```

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
