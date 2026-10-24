# Daemon Process Lifecycle and Terminal Reconnect

## User Requirements

- Rename the PTY daemon process so Task Manager shows `cli-manager-daemon` instead of a second indistinguishable `cli-manager` process.
- When the user chooses to discard tasks and exit, the PTY daemon must terminate when it has no remaining sessions; it must not remain alive unexpectedly.
- Diagnose and fix the terminal failure where `终端连接已断开，正在尝试自动重连，请稍后再试。` loops indefinitely and prevents opening terminals until all CLI-Manager processes are killed and restarted.
- Keep the daemon, background-task, PTY, WebView, Web bridge, SSH, WSL, and ordinary terminal paths compatible; do not overwrite unrelated agent changes.

## Acceptance Criteria

- Windows process inspection clearly distinguishes the GUI process from the PTY daemon process.
- Discard-and-exit closes the intended daemon sessions, shuts down an idle daemon, and leaves no stale discovery/transport state that blocks the next launch.
- A daemon disconnect/restart or failed attach recovers the terminal transport without an infinite reconnect loop; creating a new terminal works without manually killing processes.
- Existing background-task continuation still preserves running tasks when the user chooses the keep-running/background option.
- Localized user-facing text remains unchanged or is updated in both `zh-CN` and `en-US` when needed.
- Targeted Rust/frontend tests plus architecture checks pass; `CHANGELOG.md` and `docs/功能清单.md` are updated with `TEMP` version entries unless a version is supplied later.

## Scope / Scenarios

- Normal GUI close with no running tasks.
- Discard-and-exit with foreground PTY sessions.
- Keep-running/background exit with active daemon sessions.
- Daemon already idle, daemon already disconnected, stale discovery file, and daemon restart during terminal attach.
- Local PowerShell/CMD, WSL, SSH, multiple panes/sessions, and new-terminal creation after reconnect.
- Development and installed Windows builds; existing standalone helper binaries and Web daemon behavior.
