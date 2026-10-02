## Change

Projects can select DeepSeek Harness and launch its official Web profile through CLI-Manager's existing PTY/daemon. Installed `dsh` and a validated, already-built local source tree are supported; cwd remains the project or Worktree, and `--port 0` supplies an available port unless the user specifies one. The toolbar reopens the URL reported by the running service, with per-Tab isolation and ordered lifecycle cleanup.

Live daemon attach reuses the process. Endpoint recovery requires retained replay to contain the original readiness line; when checkpoint truncation has removed it, the button waits for new readiness. Recovery from the checkpoint alone is not implemented. A missing daemon restarts the Web service rather than resuming a native conversation.

WSL/SSH use their own installed CLI; local source paths are rejected for guest execution. SSH loopback endpoints require user-managed forwarding and cannot be opened directly by the toolbar. Conversation history, models and Hooks remain in the official WebUI. ZCode and community TUI support remain follow-up scope for #272.

## Validation

- 63 targeted Node tests across command/readiness, process/ACK/replay, resume, terminal runtime/session, Agent identity, Shell prefill and existing Grok/Kimi history scripts.
- 3 Rust tests (2 source checks and a real Windows ConPTY Ctrl+C lifecycle test); `cargo +1.96.1 check` (already installed toolchain; stable 1.90 is below the existing sysinfo dependency requirement).
- TypeScript; desktop frontend and Web production builds; independent normal and strict architecture checks (zero violations); whitespace/reference/diff review. GitNexus unavailable; contract + rg fallback used.
- Official DSH 0.1.7-rc.2 built source: isolated HOME/project cwd with spaces, authenticated WebUI and browser main page, simultaneous port-0 services, explicit port, EADDRINUSE failure and process cleanup. Upstream tracked source unchanged.
- Manual browser fixture of real components with mocked desktop boundaries: zh-CN/en-US, source/env preservation, Web open/readiness/stop and SSH restriction. Full native create/edit/clone/Settings workflow and WSL/SSH end-to-end remain untested; no API key or model call was used.

Refs #272. ZCode and community TUI remain separate follow-up work.
