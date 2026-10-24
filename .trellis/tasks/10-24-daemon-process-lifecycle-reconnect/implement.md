# Implementation

- Added sibling-helper selection with self-dispatch fallback in the daemon client.
- Added `DaemonClient::force_shutdown` and the `pty_daemon_force_shutdown` Tauri command.
- Added serialized daemon recovery and wired it into endpoint, PTY creation, and legacy transport commands.
- Added discard-only force shutdown selection to terminal exit cleanup.
- Preserved ordinary background exit semantics and existing routing retention behavior.
