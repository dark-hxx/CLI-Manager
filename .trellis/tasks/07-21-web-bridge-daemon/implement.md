# Implementation Steps

1. Add pure Web daemon protocol, discovery, profile/credential helpers, queue, server and client modules.
2. Add `cli-manager-web-daemon` binary using the shared daemon core.
3. Replace Tauri `WebDeviceManager` internals with a local daemon client while preserving command/event contracts.
4. Wire startup, auto-start, shutdown/detach, restart and stale daemon recovery.
5. Update universal binary preparation, backend contract, feature inventory and `[TEMP]` changelog.
6. Add focused protocol/queue/lifecycle tests and run Rust/TypeScript checks.
