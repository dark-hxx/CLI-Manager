# Agent Capability Diagnostics Contracts

## Scenario: Session-bound MCP and Skill diagnostics

### 1. Scope / Trigger

- Trigger: changing the realtime Agent capability card, one of the five Agent adapters, MCP/Skill discovery, OpenCode session bridging, WSL routing, or SSH Agent diagnostic RPCs.
- Applies to Claude, Codex, Pi, Grok Build, and OpenCode in local, WSL, and SSH Agent environments.
- The capability snapshot is derived state. It is cached only in frontend memory and must never be written to SQLite or the settings store.

### 2. Signatures

```text
agent_capabilities_inspect({ request: AgentCapabilityCommandRequest })
  -> AgentCapabilitySnapshot
agent_capabilities_probe({ request: AgentCapabilityCommandRequest })
  -> AgentCapabilitySnapshot

opencode_hook_status() -> OpenCodeHookStatus
opencode_hook_install() -> OpenCodeHookStatus
opencode_hook_uninstall() -> OpenCodeHookStatus

SSH request kinds:
  agentCapabilitiesInspect | agentCapabilitiesProbe
SSH required capability:
  agentCapabilitiesV1
```

`AgentCapabilityCommandRequest` flattens the shared request and adds optional `wslDistroName`, `sshConsumerId`, and structured `sshLaunch`. The shared request fields are `terminalSessionId`, `cliSessionId`, `agent`, `environment`, `cwd`, optional `configRoot`, `launchArgs`, optional `baselineConfigFingerprint`, and bounded `runtimeEvidence`.

### 3. Contracts

- A request is valid only for an explicit non-empty terminal ID and the exact Hook-bound `cliSessionId`. The frontend must not substitute the latest project history session.
- Activation and health are independent: MCP activation is `active | disabled`; active health is `healthy | error | checking | unknown`. Static configuration alone yields `unknown`.
- Runtime evidence comes only from the exact bound history detail. Agent-native probe output may refine health, but the backend owns the executable and fixed arguments. Never execute a command, URL, header, environment map, or argument sourced from an MCP configuration document.
- Codex `mcp list --json` exposes OAuth state as snake_case `auth_status`; parse both `auth_status` and compatibility `authStatus`. `authenticated` may refine health to healthy and `unauthenticated` to error. `unsupported` means OAuth is not applicable and remains unknown unless exact-session runtime evidence establishes health.
- When probe output is valid structured JSON, match records by their exact normalized `name` / `id` and do not run the plaintext line fallback over the serialized JSON. Plaintext substring matching is reserved for non-JSON Agent output because names such as `authenticated` and `unauthenticated` can otherwise overwrite each other.
- Skill state is `available | disabled | denied | shadowed | invalid`. Discovery includes bounded user/project compatibility roots and installed plugin cache roots; scans do not follow directory symlinks and retain only display-safe relative labels.
- Config contents are reduced to a SHA-256 fingerprint plus normalized MCP metadata. Responses never contain commands, URLs, headers, tokens, environment values, config bodies, or raw probe stderr.
- TOML configuration input is a complete document, not an individual TOML value. With `toml 0.9`, parse it through `toml::from_str::<toml::Value>()` (or `str::parse::<toml::Table>()` and wrap the table); `str::parse::<toml::Value>()` uses `ValueDeserializer` and falsely rejects ordinary top-level assignments and leading comments.
- Local inspection uses canonical local directories. WSL inspection uses fixed `wsl.exe --exec` reads and never opens the WSL UNC path directly. SSH inspection uses only the negotiated SSH Agent RPC and never falls back to local paths.
- Frontend cache and request-generation keys include terminal, CLI session, Agent, environment identity, cwd, and config-root identity. Scope changes discard stale responses. Deep check marks active MCPs `checking` while the bounded probe is in flight.
- The summary card reuses the shared CLI brand icon and terminal-panel theme tokens. MCP and Skills summaries are separate keyboard-focusable triggers that set the controlled detail tab before opening the modal. Detail rows keep metadata in a `min-width: 0` flexible column and the status badge non-shrinking so long descriptions or paths cannot push state information outside the viewport.
- OpenCode local binding is a marker-owned global plugin. Install may create or replace only the marker-owned `cli-manager-hook.js`; an unowned same-name file is `conflict`. The plugin reports `SessionStart`, `UserPromptSubmit`, `Stop`, and `StopFailure`, and missing callback environment is a silent no-op.
- SSH Agent protocol `1.11` advertises `agentCapabilitiesV1`. Missing capability produces an `upgradeRequired` snapshot; it does not downgrade to local inspection.
- Pi has no universal built-in MCP status contract. When Pi MCP Adapter configuration is present, discover its JSON sources in low-to-high precedence: `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `<Pi agent dir>/mcp.json`, project `.mcp.json`, then project `.pi/mcp.json`. Later sources override earlier entries with the same server name.
- For Pi MCP Adapter JSON, `disabled: true` means disabled; an entry without it is active. Static active entries remain `unknown` health and must not launch an MCP server. When none of those sources and no exact-session evidence are available, emit `pi_mcp_extension_observability_unknown` instead of claiming zero healthy servers.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Empty/control-character terminal or CLI session ID | Stable `agent_capability_*_invalid`; no scan or process launch. |
| Local cwd/config root is not an existing canonical directory | Stable `agent_capability_*_unavailable`. |
| WSL distro is missing/mismatched or cwd is not a valid Linux/UNC path | Stable `agent_capability_wsl_*` error. |
| SSH launch/consumer context is absent | `agent_capability_ssh_context_required`. |
| SSH Agent lacks `agentCapabilitiesV1` | Snapshot `bridgeStatus=upgradeRequired`; no local fallback. |
| Config is unreadable, oversized, or malformed | Safe diagnostic code; no config content in the response. |
| A valid TOML document starts with a top-level key or comment | Parse the complete document with no `config_parse_error`; retain discovered MCP metadata. |
| A native MCP probe or WSL discovery command produces excessive output | Retain only the bounded prefix, drain the process pipe, and return `agent_probe_output_too_large` for probe output instead of parsing partial data. |
| Skill manifest is unreadable/oversized/malformed | Keep the candidate as `invalid` with a stable code. |
| Probe executable is missing, exits unsuccessfully, or times out | Keep the static snapshot and add `agent_probe_*`; do not launch MCP servers. |
| Codex JSON reports `auth_status=unsupported` for an enabled stdio server | Keep activation active and health unknown unless exact-session evidence establishes healthy/error. |
| Pi MCP Adapter JSON entry has `disabled: true` | Keep it in details as disabled and exclude it from active totals. |
| Pi MCP Adapter has at least one readable configured server | Report configured active/unknown or disabled state; do not emit `pi_mcp_extension_observability_unknown`. |
| OpenCode plugin path is occupied by unowned content | `opencode_hook_conflict`; preserve the file byte-for-byte. |
| Response arrives after the terminal/session scope changed | Frontend generation check discards it. |

### 5. Good / Base / Bad Cases

- Good: the active Codex session has one exact-session successful `mcp:docs` event; the card shows that configured server active and healthy while another static server remains unknown.
- Good: WSL and SSH scans execute in their own environments and return only relative source labels.
- Good: user and project Codex `config.toml` documents containing top-level keys, comments, and `[mcp_servers.*]` tables parse without diagnostics.
- Good: Codex JSON marks authenticated and unauthenticated records healthy/error by exact server name while an OAuth-unsupported stdio record remains active/unknown.
- Good: Pi MCP Adapter discovers a user `mcp.json` server and a project `.pi/mcp.json` override; the active result is shown with `unknown` health without starting either server.
- Base: a configured server has no runtime evidence and no native status; it remains active/unknown.
- Base: a disabled server remains visible in details but is excluded from active and health totals.
- Base: Pi has no readable MCP Adapter source or exact-session evidence; the card keeps the observability diagnostic instead of inventing an empty MCP list.
- Bad: mark every parsed MCP entry healthy, inspect `~/.codex` on the desktop for an SSH terminal, or bind the card to the newest project session.
- Bad: apply generic `enabled` parsing to Pi Adapter JSON and ignore its `disabled: true` flag.

### 6. Tests Required

- Shared Rust crate: static config stays unknown, disabled/shadowed entries are preserved, exact runtime failures affect only the matching server, JSONC is parsed safely, complete TOML documents parse without false diagnostics, malformed TOML still emits `config_parse_error`, and plugin Skills are bounded and discovered.
- Shared Rust crate: Codex snake_case `auth_status` is parsed, exact JSON record matching prevents overlapping server names from overriding each other, and `unsupported` remains unknown.
- Shared Rust crate: Pi MCP Adapter sources follow the documented user/project precedence; `disabled: true` is disabled, configured active entries remain unknown, and a configured entry suppresses `pi_mcp_extension_observability_unknown` without exposing command data.
- Desktop Rust: boundary validation, OpenCode marker ownership/source admission, fixed probe timeout paths, and SSH upgrade mapping.
- SSH Agent: request environment validation, `agentCapabilitiesV1` advertisement, protocol minor identity, and full Agent tests.
- Frontend Node/TypeScript: five-Agent resolution, WSL distro resolution, MCP evidence extraction, exact OpenCode hook source binding, stable error redaction, additive settings migration, and `npx tsc --noEmit`.
- Manual: switch zh-CN/en-US, verify keyboard modal/tabs/filters, local and WSL sessions, SSH upgrade state, rapid split/Tab changes, and 24-hour timestamps.

### 7. Wrong vs Correct

#### Wrong

```ts
const sessionId = latestProjectSession.session_id;
```

```rust
Command::new(configured_mcp.command).args(configured_mcp.args).spawn()?;
```

```rust
let root = document.content.parse::<toml::Value>()?; // Parses one TOML value in toml 0.9.
```

```rust
let enabled = value.get("enabled").and_then(JsonValue::as_bool).unwrap_or(true);
```

#### Correct

```ts
const sessionId = terminalSession.cliSessionId;
if (!sessionId) return actionableUnboundState;
```

```rust
let args = probe_args(validated_agent); // fixed backend-owned read-only command
```

```rust
let root = toml::from_str::<toml::Value>(&document.content)?; // Parses the full document.
```

```rust
let enabled = if agent == AgentKind::Pi {
    !value.get("disabled").and_then(JsonValue::as_bool).unwrap_or(false)
} else {
    value.get("enabled").and_then(JsonValue::as_bool).unwrap_or(true)
};
```

```rust
// Wrong: serialized JSON lines can match multiple overlapping server names.
for line in output.lines() {
    update_every_server_whose_name_is_a_substring(line);
}

// Correct: valid JSON uses exact record names; line fallback is plaintext-only.
if let Ok(json) = serde_json::from_str::<JsonValue>(output) {
    update_exact_probe_records(&json);
} else {
    update_plaintext_probe_lines(output);
}
```

Exact binding prevents cross-pane leakage; fixed probes prevent configuration from becoming an arbitrary command-execution surface; document parsing prevents valid user/project configuration from producing false diagnostics.
