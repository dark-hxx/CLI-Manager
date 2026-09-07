# Technical Design

## Data Flow

`TerminalStatsPanel` -> typed Tauri IPC -> Rust capability service -> fixed Agent adapter -> local/WSL/SSH runner -> normalized/redacted snapshot -> in-memory frontend cache -> summary card/detail modal.

Runtime hook/history evidence is joined only when its Session ID exactly matches the request.

## Public Contracts

- `agent_capabilities_inspect(request)`: effective configuration and cached/session evidence.
- `agent_capabilities_probe(request)`: bounded Agent-native read-only status probe.
- `AgentCapabilityRequest`: terminal ID, Session ID, Agent kind, environment, cwd, safe launch identity.
- `AgentCapabilitySnapshot`: binding metadata, bridge state, config fingerprint/change state, MCP items, Skill items, diagnostics, capture time.
- SSH protocol capability/request: `agent-capabilities-v1` with normalized response and explicit upgrade/unsupported errors.

## State Rules

- MCP activation: `active | disabled`.
- MCP health: `healthy | error | checking | unknown`.
- Skill state: `available | disabled | denied | shadowed | invalid`.
- Newer Agent-native status wins over older exact-session evidence; static configuration only establishes activation and yields unknown health.
- Cache key: terminal ID + Session ID + Agent + environment identity + cwd + config fingerprint. A scope change clears the displayed snapshot before starting another request.

## Adapter and Security Boundaries

- A shared runner selects a fixed executable/subcommand by validated Agent enum. The frontend cannot provide executable names or raw arguments.
- Local and WSL adapters resolve the effective user/project/plugin/package sources using the active cwd and launch context.
- SSH uses only the remote Agent protocol. Old Agents return `agent_upgrade_required`.
- Pi has no universal built-in MCP contract; extension-manifest/session evidence may produce items, otherwise observability remains unknown.
- Error messages use stable codes plus display-safe summaries. Config contents, env values, auth headers, tokens, and raw command lines are never serialized.
- The legacy `resolveSshToolSource` remains unchanged; a separate five-Agent diagnostic enum avoids its CRITICAL blast radius.

## UI

- Add `agentCapabilities` to the real-time card key/default order and settings migration.
- The card summarizes bound Agent/Session, active MCP counts by health, and Skill counts.
- The modal has MCP/Skills tabs, state filters, origin/status columns, empty/error/upgrade/setup states, normal refresh, and deep check.
- OpenCode adds a CLI-Manager-managed global plugin that emits compatible session lifecycle hook payloads.

## Timeouts and Concurrency

- Inspect requests are event-driven and debounced; no background polling.
- Probe timeout: 10 seconds local/WSL, 15 seconds SSH.
- One probe per session. Frontend request generations discard stale responses; backend terminates timed-out child processes.

