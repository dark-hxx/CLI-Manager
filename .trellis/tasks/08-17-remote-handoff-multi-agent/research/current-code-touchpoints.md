# Remote handoff multi-Agent research

## Baseline

- Branch: `fix/remote-handoff-provider-runtime`.
- Upstream: `fork/fix/remote-handoff-provider-runtime`.
- Start state: ahead 0, behind 0; only this Trellis task directory is untracked.
- cc-connect: `v1.5.0-beta.3`, commit `ad196294`.

## cc-connect capability evidence

The installed `cc-connect config example` exposes these project Agent types:

| Agent | Type | Relevant options |
| --- | --- | --- |
| Claude Code | `claudecode` | `mode=default/bypassPermissions` |
| Codex | `codex` | `mode=suggest/yolo`, app-server integration used by CLI-Manager |
| Pi | `pi` | `rpc=true`, `mode=default/yolo` |
| OpenCode | `opencode` | `mode=default/yolo` |

Pi RPC is required for UI forwarding. OpenCode is supported by cc-connect but its approval behavior must be presented as capability-limited rather than assumed equivalent to Codex/Claude.

## Existing reusable code

- `src/lib/agentCapabilities.ts::resolveAgentRuntimeKind()` recognizes Claude/Codex/Pi/Grok/OpenCode.
- `src/lib/historyResumeCommand.ts` already produces Claude, Codex and Pi resume commands.
- Local OpenCode `--help` confirms `-s, --session <id>` continues a session.
- Provider `scope::prepare()` already produces Claude settings snapshots and Codex launch config.
- Existing Claude, Pi and OpenCode Hook installers emit normalized source values.
- Existing platform and notification machinery is already platform-neutral after handoff identity is established.

## Existing incorrect assumptions

- Frontend eligibility is named and implemented as Codex-only.
- Rust `CcConnectAgent` lacks Pi/OpenCode.
- Registered project loading maps every non-Codex CLI to Claude.
- Target resolution/preflight/provider labels force Codex.
- Injected cc-connect session stores `agent_type=codex`.
- Hook notification ownership requires `source=codex`.
- Local cancellation prepares only Codex Provider and command.
- SSH resume Agent supports only Claude/Codex, so non-Codex SSH is intentionally deferred.

## Tooling degradation

- GitNexus MCP tools are not exposed in this session.
- `npx gitnexus status` found no index.
- `npx gitnexus analyze` failed because the installed package cannot resolve `tree-sitter-kotlin`.
- Planning therefore uses Trellis contracts, `rg`, targeted source reads, installed cc-connect output and later compile/test evidence.
