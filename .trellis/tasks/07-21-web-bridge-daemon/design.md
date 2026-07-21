# Technical Design

## Process Topology

```text
Browser <-> apps/server <-> Device WebSocket <-> cli-manager-web-daemon
                                               <-> loopback NDJSON <-> Tauri
                                               <-> existing invoke/events <-> React
```

`apps/server` remains the Web authority. The new daemon owns only the desktop-side device adapter.

## Local Protocol

- Discovery: `.cli-manager/web-daemon.json`, development uses `web-daemon.dev.json`.
- Fields: `port`, `token`, `pid`, `version`, `protocolVersion`, `features`.
- First frame is `auth`; all requests have bounded JSON frames and request IDs.
- Tauri requests: status/configure/start/stop/restart/pairing/take-operations/history/operation-state/shutdown.
- Daemon pushes: status changes, operation-ready, pairing-claimed, and errors.
- Loopback-only TCP, random token, stale PID cleanup, version handshake, and idle exit follow the PTY daemon conventions.

## Ownership

- daemon owns `web-device.json` migration compatibility and the existing keyring account.
- Tauri receives only non-secret status and pairing result.
- Tauri keeps path validation and operation execution; daemon never receives arbitrary filesystem authority.
- Existing Tauri command names and frontend event names remain stable.

## Failure Handling

- No desktop client: retain a bounded in-memory operation queue; do not emit accepted/running early.
- daemon disconnect: Tauri reports disconnected status and reconnects/spawns with bounded retry.
- daemon crash: server-side non-terminal operations are recovered on the next device connection.
- incompatible daemon with no pending work: stop and replace; with pending work: keep and warn.
