# SSH Remote Terminal Contracts

## 1. Scope / Trigger

Apply this contract when changing SSH host persistence, remote project creation, remote directory queries, terminal launch, PTY/daemon restore, project capability routing, or project sync/import behavior.

The first SSH scope is a remote terminal MVP, not a remote IDE. Local and WSL projects retain their existing capabilities. SSH projects may use terminals, split panes, command templates, groups, and Workspans; remote files, Git, Worktree, history, hooks, statistics, provider switching, external terminal launch, and remote resource monitoring require separate implementations.

## 2. Signatures

### SQLite

```sql
ssh_hosts(id, name, group_name, host, port, username, config_alias,
          auth_mode, identity_file, credential_ref, jump_mode, jump_host_id,
          proxy_type, proxy_host, proxy_port, proxy_command,
          connect_timeout_sec, server_alive_interval_sec,
          server_alive_count_max, terminal_encoding, startup_script, notes,
          sort_order, created_at, updated_at, group_id)

ssh_host_groups(id, name, parent_id, sort_order, created_at)

projects.environment_type TEXT NOT NULL DEFAULT 'local'
projects.ssh_host_id TEXT REFERENCES ssh_hosts(id) ON DELETE SET NULL
projects.remote_path TEXT NOT NULL DEFAULT ''
projects.cli_config_root TEXT NOT NULL DEFAULT ''

ssh_host_tool_preferences(host_id, source, configured_root, updated_at)
ssh_agent_tool_integrations(integration_id, host_id nullable, installation_id,
  remote_machine_id, ssh_user, source, scope_kind, configured_root,
  canonical_root, config_root_hash, hook_record_json,
  history_source_instance_id, validation_state, cleanup_state, checked_at)
```

### Tauri commands

```rust
pub async fn ssh_client_status() -> SshClientStatus;
pub async fn ssh_test_connection(spec: SshConnectionSpec, accept_new_host_key: Option<bool>)
    -> Result<SshConnectionTestResult, String>;
pub async fn ssh_save_password(host_id: String, password: String)
    -> Result<String, String>;
pub async fn ssh_password_status(host_id: String) -> Result<bool, String>;
pub async fn ssh_delete_password(host_id: String) -> Result<(), String>;
pub async fn ssh_check_path(spec: SshConnectionSpec, path: String)
    -> Result<SshPathCheckResult, String>;
pub async fn ssh_list_directories(spec: SshConnectionSpec, path: String)
    -> Result<Vec<SshDirectoryEntry>, String>;
```

### Terminal launch

```rust
pub struct SshLaunchPlan {
    pub host_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub config_alias: String,
    pub auth_mode: String,
    pub identity_file: String,
    pub jump_target: String,
    pub proxy_command: String,
    pub connect_timeout_sec: u64,
    pub server_alive_interval_sec: u64,
    pub server_alive_count_max: u32,
    pub remote_path: String,
    pub environment_overrides: HashMap<String, String>,
    pub initialization_command: Option<String>,
    pub startup_command: Option<String>,
}
```

`pty_create` and the daemon `ClientFrame::Create` accept an optional structured `ssh_launch`. The frontend resolves the plan but must not build a complete shell-escaped `ssh` command string.

## 3. Contracts

### Host and project identity

- A host is a reusable machine-local connection asset; a project is a user-visible workspace binding one host to one POSIX remote directory.
- SSH project identity is `(environment_type = "ssh", ssh_host_id, normalized remote_path)`. Never use the local `path` field to identify an SSH project.
- Deleting a host sets project `ssh_host_id` to `null`; the project remains visible and must require explicit rebinding before launch.
- Host grouping is independent from the existing manual project grouping.
- `ssh_host_groups` owns the editable multi-level SSH host tree. `ssh_hosts.group_name` is legacy display/migration data; new UI should bind by `group_id`.
- Migration 21 must preserve old flat `group_name` values as root groups and backfill each host's `group_id`.

### Authentication and secrets

- Supported launch modes are `ssh_config`, `agent`, `identity_file`, `credential_ref`, `password_prompt`, and `interactive`.
- `credential_ref` means Username / Password: SQLite stores only the credential reference, while the secret lives in the platform credential store.
- Saved SSH passwords must use the shared credential store: Windows Credential Manager, macOS Keychain, or Linux Secret Service. Native WSL support depends on Secret Service availability.
- OpenSSH receives saved passwords only through the one-shot loopback AskPass helper. The command line, ordinary logs, WebDAV payloads, exports, session snapshots, and normal environment data must not contain the password.
- Passwords, private-key contents/passphrases, and proxy credentials must not enter SQLite, Tauri store, session snapshots, logs, WebDAV, or local exports.
- `identity_file` is machine-local and must not be synchronized.
- Host key trust and changed-key blocking remain owned by system OpenSSH.

### Remote paths and commands

- Remote project paths are absolute POSIX paths.
- The remote directory picker treats an empty or whitespace-only browse path as `/` before invoking Rust; backend validation remains strict for non-empty relative or traversal paths, and the UI localizes those validation errors.
- Reject NUL, CR, LF, relative paths, and any `..` path segment at the Rust boundary.
- Quote every path and environment value with the dedicated POSIX quoting helper.
- Environment keys must match shell variable syntax.
- Directory browsing/check commands use non-interactive `BatchMode=yes` for SSH Config, Agent, and identity-file modes.
- HTTP and SOCKS5 proxy URLs are stored as structured `proxy_type`, `proxy_host`, and `proxy_port` fields. The app binary provides the stdio proxy helper used by OpenSSH `ProxyCommand`; users must not need to author a raw command.
- When a direct HTTP/SOCKS5 proxy is enabled, it takes precedence over `ProxyJump`; do not emit both routes for the same connection.
- Connection testing must probe a configured HTTP/SOCKS5 proxy as a separate diagnostic stage before starting SSH, and return the sanitized proxy endpoint plus the raw connect/handshake error when that stage fails.
- Connection testing must run OpenSSH in verbose mode and complete as soon as stderr reports `Authenticated to ...`; it must not wait for a remote command or shell session to exit after authentication succeeds.
- Username/password testing may try `password` and `keyboard-interactive`, with at most one password prompt, so servers that expose password login through keyboard-interactive are covered without repeated prompts.
- Username/password terminal launches must allow both `password` and `keyboard-interactive`; the launch path must not use stricter authentication methods than the successful connection-test path.
- The `__ssh_proxy` helper subcommand must be dispatched before inherited AskPass environment handling; password-authenticated SSH processes pass AskPass variables to ProxyCommand children.
- The proxy stdio bridge must flush every remote-to-OpenSSH chunk immediately. SSH handshake packets are binary and may be smaller than the Windows stdout buffer; waiting for EOF to flush can deadlock key exchange at `expecting SSH2_MSG_NEWKEYS`.
- `credential_ref` directory browsing/check commands use `BatchMode=no` plus AskPass. Any AskPass/credential error must be returned; do not silently retry without the password.
- `password_prompt` and `interactive` modes require a real PTY and must return `ssh_interactive_auth_required` for directory browsing/check commands.
- A successful launch enters `remote_path`, emits OSC 777 `cli-manager-ssh=connected`, applies environment overrides, runs initialization/startup commands, and finally returns to the user's remote login shell.
- Claude/Codex tool config roots use this priority: SSH project `cli_config_root`, matching `ssh_host_tool_preferences`, then the CLI native default. Native default means no environment variable is injected.
- Resolve the source only from the SSH project's configured `cli_tool`. Inject `CLAUDE_CONFIG_DIR` for Claude or `CODEX_HOME` for Codex; do not scan or switch remote providers.
- Absolute POSIX roots use normal POSIX quoting. `~` and `~/...` roots must be rendered with an explicit quoted `${HOME}` prefix so shell expansion occurs without evaluating arbitrary variables or command substitution.
- Active PTYs capture the root in their launch plan. Editing a Host or project root affects only subsequent launches and never rewrites a running session.
- When an SSH project creates a terminal without an explicit session command, resolve its project command as `startup_cmd` first, otherwise `cli_tool + cli_args`; project environment variables follow the same fallback rule. Explicit resume/template commands take precedence, and machine-local provider overrides are not injected into the remote command.
- SSH startup commands are embedded in `SshLaunchPlan` and executed exactly once by the remote launch command. The frontend may retain the resolved command as session metadata but must not write it again through `pty_write`.
- A configured initialization/startup command runs inside one login shell, then hands control to a non-login interactive shell that inherits the initialized environment. Do not start a second login shell after the command; repeated MOTD/profile output can bury command output and rerun login side effects.

### PTY, daemon, and restore

- The local OpenSSH process is the PTY root process; xterm rendering remains unchanged.
- Persist `environmentType`, `sshHostId`, `remotePath`, `connectionState`, and `disconnectReason` in terminal session snapshots.
- Reopen a live daemon session by attaching to its existing PTY. Never rerun the SSH launch or startup command.
- An exited daemon session may restore replay and disconnected metadata only.
- If an older daemon rejects the SSH create frame, fall back to the in-process PTY path; legacy local Create frames remain compatible.

### Capability routing

- All SSH feature entry points must consult `resolveProjectCapabilities` or an equivalent hard backend/store guard.
- SSH MVP allows `terminal`, `splitTerminal`, and `commandTemplates` only.
- A hidden or disabled UI control is not sufficient for files and Worktree: stores must reject SSH projects before invoking local filesystem/Git processes.
- `findProjectByPath` and other local path matchers must exclude SSH projects and empty local paths.
- The system resources panel is local-only and must be labelled `Local Resources` / `本机资源` for SSH sessions.

### Sync

- Sync/export may carry project `environment_type`, `remote_path`, and `cli_config_root`.
- It must exclude `ssh_hosts`, `ssh_host_id`, `identity_file`, `credential_ref`, passwords, and machine-specific proxy credentials.
- Imported SSH projects have `ssh_host_id = null`, preserve only a valid explicit POSIX/`~/...` project config root, and clear machine-specific provider/worktree configuration before requesting host rebinding.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| OpenSSH missing | Return client-unavailable status and show localized setup guidance; local projects remain usable. |
| Empty host without config alias | `ssh_host_address_required`. |
| Port is zero without config alias | `ssh_host_port_invalid`. |
| Timeout is zero or greater than 300 seconds | `ssh_connect_timeout_invalid`. |
| Unknown auth mode | `ssh_auth_mode_invalid`. |
| Identity-file mode without a path | `ssh_identity_file_required`. |
| Credential-reference mode without a saved credential | `ssh_credential_ref_required`. |
| Empty password when saving a credential | `ssh_password_required`. |
| Invalid host id for credential account scoping | `ssh_host_id_invalid`. |
| Host argument contains NUL/CR/LF | `ssh_launch_argument_invalid`. |
| Proxy URL embeds `user:password@host` | `ssh_proxy_credentials_forbidden`. |
| HTTP/SOCKS5 proxy host is empty or its port is outside 1–65535 | `ssh_proxy_address_invalid`. |
| Remote path is relative or contains NUL/CR/LF | `ssh_remote_path_invalid`. |
| Remote path contains a `..` segment | `ssh_remote_path_parent_forbidden`. |
| Invalid environment key/value | `ssh_environment_key_invalid` or `ssh_environment_value_invalid`. |
| Tool config root is relative, contains NUL/CR/LF/backslash, `$`, or backticks | `ssh_tool_config_root_invalid`. |
| Tool config root contains a `..` segment | `ssh_tool_config_root_parent_forbidden`. |
| Password/MFA directory query | `ssh_interactive_auth_required`; keep manual path input available. |
| Referenced host missing | Block launch with `ssh_host_not_found`; never fall back to localhost. |
| Host key changed | OpenSSH blocks the connection; do not auto-ignore the warning. |
| First connection has no known host key | Return a confirmation-required diagnostic; only an explicit user action may retry with `StrictHostKeyChecking=accept-new`. |
| SSH transport exits | Persist disconnected/failed state and classified reason; do not interpret remote output as local paths. |

## 5. Good / Base / Bad Cases

- Good: one host profile backs several SSH projects with distinct remote paths and existing manual project groups.
- Good: a path such as `/srv/project name/开发` is quoted once, opens correctly, and cannot inject shell syntax.
- Good: application restart attaches a daemon-owned SSH PTY without repeating initialization commands.
- Good: Username / Password host can test connection and browse/check a remote path through AskPass without exposing the password.
- Good: project `~/state/claude` overrides the Host Claude root and launches with `CLAUDE_CONFIG_DIR="${HOME}"/'state/claude'`.
- Base: no project or Host root exists, so Claude/Codex uses its native default without an injected variable.
- Base: password-prompt/MFA users manually enter a remote path, then authenticate in the real PTY.
- Base: an imported SSH project remains visible with a rebinding warning.
- Bad: treating `path = ""` as a local project key; on POSIX this can match every local path.
- Bad: passing a remote POSIX path into local filesystem, Git, Worktree, history, or provider APIs.
- Bad: synchronizing host IDs or private-key paths across machines.
- Bad: quoting `~/.claude` as one literal shell token; this disables tilde expansion and points the CLI at a directory named `~`.

## 6. Tests Required

- Run `npx tsc --noEmit`.
- Run `cargo check` and `cargo test --lib` from `src-tauri`.
- Assert migration defaults all existing projects to `local` and host deletion nulls remote bindings.
- Assert SSH group migration preserves legacy flat groups as root `ssh_host_groups` and backfills `ssh_hosts.group_id`.
- Assert launch-plan validation, POSIX quoting, environment-key validation, proxy credential rejection, jump targets, and legacy daemon frame compatibility.
- Assert password/interactive/agent modes do not include stale identity-file arguments after auth-mode switches.
- Assert AskPass serves a saved password only for the matching one-shot token and rejects reused or unknown prompts.
- Assert remote path checking accepts spaces/Unicode/single quotes and rejects traversal, relative paths, NUL, CR, and LF.
- Assert project root overrides Host root, Host root overrides native default, and unrelated/local/WSL launches receive no SSH tool-root injection.
- Assert absolute, `~`, and `~/...` config roots render safely; reject traversal, relative paths, expansion syntax, backslashes, NUL, CR, and LF at the Rust boundary.
- Assert deleting a Host cascades Host preferences while retaining validated integration identity with `host_id = NULL` and `unbound/retained` state.
- Assert session restore attaches live daemon PTYs and never reruns an exited SSH command.
- Assert SSH projects are rejected by file and Worktree stores and excluded from local path matching.
- Assert export/import omits all host and credential fields and requires rebinding.
- Manually verify OpenSSH Agent, private key, password/MFA, first host key, changed host key, ProxyJump, ProxyCommand, network interruption, zh-CN/en-US, and 24-hour time display.

## 7. Wrong vs Correct

### Wrong: build SSH in the WebView

```ts
const command = `ssh ${user}@${host} "cd ${remotePath} && ${startupCommand}"`;
invoke("pty_create", { shell: command });
```

This mixes UI data with shell syntax, bypasses Rust validation, and makes daemon restore inconsistent.

### Correct: pass a structured launch plan

```ts
invoke("pty_create", {
  sshLaunch: {
    hostId,
    host,
    port,
    username,
    remotePath,
    environmentOverrides,
    startupCommand,
  },
});
```

Rust validates the plan, builds OpenSSH arguments, quotes remote shell values, and uses the same representation for in-process PTY and daemon execution.

### Wrong: rely only on disabled UI

```ts
if (remote) return <DisabledGitButton />;
```

### Correct: route and enforce capabilities at both boundaries

```ts
if (!projectSupportsCapability(project, "git")) return null;
```

The corresponding store/backend path must also reject SSH projects before any local path operation.

### Wrong: quote a tilde root literally

```rust
format!("export CLAUDE_CONFIG_DIR={}", posix_quote("~/.claude"))
```

### Correct: expand only the supported HOME shorthand

```rust
format!("export CLAUDE_CONFIG_DIR=\"${{HOME}}\"/{}", posix_quote(".claude"))
```

The dedicated validator rejects all other shell expansion syntax before command construction.
