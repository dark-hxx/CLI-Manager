# 1.3.9 Web terminal lifecycle

## Root causes and scope

- Size: Web viewer scaling clamps at 1.4; desktop output subscriber presence is not viewport visibility. Desktop resize and replay dimensions cross the same PTY boundary. Use synchronous viewport registration and restore size when ownership returns.
- Replay: browser currently merges different historical grids at the final size; preserve resize boundaries. A split PTY frame must not advance reconnect checkpoint before its last fragment.
- Latency: device flush shares a thread with a 500ms blocking read; local control accepts poll at 50ms and each batch opens a new connection. Wake outgoing data and reuse authenticated transport.
- Cursor: Web enables blink, desktop disables it and supports delayed Codex show. Browser needs parser-aware visibility handling and focus handling.
- Installer: no preinstall/preuninstall cleanup hook; normal Tauri exit cannot cover forced termination. Stop only verified installed executable paths, then wait and fail visibly if still locked.
- Limits: 96 KiB is encoded batch ceiling, not throughput. Persist 96/256/512 KiB options and validate the full path; do not wait to fill.

## Discovery and scenario coverage

Touchpoints: WebTerminal/views/domain/terminalStream; desktop XTermTerminal/useTerminalDisplay/useWebDeviceBridge; frame batching and protocol; device daemon/fallback/outbox; server websocket validation; settings store and Web device settings; NSIS config and cleanup helper. Project CRUD and history SQL schema are unrelated and unchanged by this task.

Scenarios: visible/hidden tabs, desktop visible/minimized/restored, two sessions, browser focus/blur, wide/narrow windows, resize during replay, fragmented CSI/UTF-8, large output followed by approval, reconnect midway through a fragment, default and larger batches, running/stopped/foreign-install processes, preinstall/preuninstall. WSL/Worktree output uses the same byte transport; SSH Web launch remains existing unsupported scope. Hook installation is not required for raw PTY display.

GitNexus tools/skill files unavailable. Memory index and inbound call analysis used as hints, verified against real source/contracts. Graph labels include HIGH/CRITICAL on shared resize and renderer entrypoints. Sandbox helper frequently fails (SetNamedSecurityInfoW 5); approved escalated reads/patch engine used. Existing unrelated dirty files preserved.

## Verification

- Desktop and Web TypeScript checks passed.
- Combined Node regression: 27 passed (ownership, batch normalization/byte preservation, bounded backpressure, browser stream/reconnect and bridge polling). Initial strip-only run could not parse a TypeScript parameter property; rerun with experimental-transform-types passed.
- Protocol: 7 passed. Server: 53 unit + 4 reconnect passed, with optional sequenceStart/sequenceEnd and 512 KiB limits.
- Chrome with production CSS: widths 800/1200/2400 leave fixed 16 physical pixel gutter; desktop-owned viewer sends no resize; Web-owned viewer sends one initial resize and none for 30 output updates. Replay retains 80x24 then 120x32 grids. Live partial then incremental replay and replay-partial retried at same sequence render exactly once. Codex split CSI delayed-show/newer-hide tests passed. 11 large replay/disposal rounds passed; 5001 synthetic small frames coalesced to one xterm write (~51ms in this run, not an end-to-end network benchmark). Screenshot visually inspected.
- Installer: 5 isolated tests passed including exact-path process stop, different installation preservation, authenticated PTY/Web graceful shutdown, repeated cleanup, invalid-root rejection and both NSIS hooks compiled. No real user app/process was stopped.
- Transport: final full web_ suite 56 passed/1 environment-dependent ignored; protocol8 daemon suite17 passed. Local real socket wake test ~0.37ms proves removal of receive wait, not desktop-to-browser total latency. Bounded queue rejection retry and reserved error capacity tested; exhausted congestion requires reconnect, and history recovery remains limited to the PTY replay retention window.
- Final Chrome additions passed: inactive->active and simulated hidden->visible drain in ~7ms (not 250ms); actual PTY-style separate empty sequence0 replay terminator completes full replay and later live output advances checkpoint. Last synthetic5001-frame round41ms.
- Source provenance: this release preserves pre-existing working-tree database performance changes (src-tauri/src/usage_schema.rs and commands/history/request_logs.rs) and an unused TerminalProcessManager subscriber-query addition. These are not authored or staged by this task. Necessary pre-existing Web build/runtime dependencies are explicitly staged with this task; unrelated documentation and old installer remain untouched.
- Remaining environment checks: actual installed WebView2 minimize/tray ownership, actual installer upgrade/uninstall with user sessions, on-device language switching/settings restart and physical NetBird/Tailscale/reverse-proxy network performance were not exercised. Tests use isolated processes, real Chrome renderer and local sockets. Avoid claiming universal latency or zero-flicker guarantees.
- Post-edit index refresh/detect_changes unavailable (MCP Transport closed); source and Git diff are authoritative. Build/package result will be recorded after completion.
- Production build succeeded (Rust release19m41s). Generated NSIS inspection then found a pre-existing resource-map bug: conpty/**/* flattened three architecture runtimes into identical destination filenames, while conpty_sideload resolves resources/conpty/<arch>. Changed only bundle mappings to preserve architecture paths and extended cleanup to old flat plus all three architecture paths. Five isolated installer tests passed again with all OpenConsole path variants and a foreign installation process preserved. Re-bundle uses already compiled executables; no runtime source changed after production compilation.
- Legacy installer limitation: for this same-version1.3.9 update choose Add/Reinstall (or update mode) so the new PREINSTALL hook executes. An old uninstaller invoked first by legacy maintenance UI cannot gain new hooks retroactively. Once this package is installed its own uninstaller contains cleanup. Do not claim every legacy uninstall-first/Wix migration branch is covered.
