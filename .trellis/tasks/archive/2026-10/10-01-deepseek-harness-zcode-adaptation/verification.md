# Verification

## Implemented scope

Official DeepSeek Harness Web profile launch through the existing terminal lifecycle; installed `dsh` and selected local built source; project/Worktree cwd; actual readiness URL and WebUI reopen button; daemon attach/restart distinction; localized source errors and SSH forwarding boundary. Native DSH history/models/Hooks remain managed by the official WebUI. ZCode is deferred.

## Executed evidence

Results below were reported by the parent agent after execution. No desktop UI or full official page success is inferred from unit tests or HTTP status alone.

| Check | Status | Evidence |
| --- | --- | --- |
| Targeted Node resume/process/runtime/session regressions | Passed | Final combined targeted run: 63 tests across 9 scripts, including existing CLI regressions. |
| DSH pure command/readiness tests | Passed | 8 command/readiness tests included in the 63-test run. |
| Agent identity regressions | Passed | 4 tests reported passed. |
| Targeted Rust source validation tests | Passed | `cargo +1.96.1 test --manifest-path src-tauri/Cargo.toml commands::deepseek --lib`: 3 passed, 0 ignored; real ConPTY raw ETX interruption emits an independent marker with monitoring disabled and leaves PowerShell alive. |
| Frontend TypeScript check | Passed | `npx tsc --noEmit`. |
| Frontend production build | Passed | `npm run build`. |
| Web production build | Passed | `npm run web:build`. |
| Desktop Rust compilation | Passed | `cargo +1.96.1 check`; installed stable 1.90 is below sysinfo's required Rust 1.95. No toolchain installation was needed. |
| Independent architecture check | Passed | `npm run check:architecture`: 0 violations; strict: 0. Generated preview/npm artifacts ignored locally, no source-directory exemption. |
| Strict architecture check | Passed | Strict architecture reported zero violations. |
| Official local CLI service runtime | Passed | DSH `0.1.7-rc.2`: isolated HOME, project cwd with spaces, authenticated HTTP 200. Two simultaneous port-0 services (52220/52221); explicit port 52227; collision exits 1 with EADDRINUSE; test processes stopped. |
| Official WebUI page render | Passed | Browser loaded official main UI (new conversation, workspace selector, plugins, settings). No API key configured or paid model call made. Rebuilt official host, client and Web artifacts after removing an orphan generated settings-file directory; official tracked source unchanged and original `go/` preserved. |
| Desktop zh-CN/en-US create/edit/clone and WebUI button | Partial | Real new components rendered in a browser fixture with mocked desktop transport: zh-CN/en-US fields/buttons, environment preservation, open callback, readiness/stop, SSH disabled/forwarding message verified. Full Tauri create/edit/clone and Settings-page switching not manually exercised. |
| Live daemon attach/dead daemon restart | Partial | Automated process/session coverage passed; no manual desktop result supplied. See replay limitation below. |
| WSL and SSH/manual forwarding | Pending | No runtime environment result supplied; guest source rejection and SSH open restriction are code boundaries only. |
| Final diff whitespace and expected-symbol scope review | Passed | Manual contract/reference/diff review and `git diff --check`; no unexpected files. GitNexus MCP and CLI were unavailable, so automatic impact/detect_changes not claimed. |
| Fork push and upstream draft PR | Passed | Work commit `e62b6227a0d4867cf4abaf88e9b01204221ae533` pushed to `jackie-cqz/CLI-Manager`; upstream Draft PR [#273](https://github.com/dark-hxx/CLI-Manager/pull/273) verified against `master` and attached to this chat. |

## Endpoint ordering and recovery boundary

- Readiness and OSC 133/633 plus session-matching legacy 777 lifecycle cleanup are parsed in one ordered raw-output reader. Endpoint cleanup was removed from terminalRuntime to avoid ordering dependence on UI callbacks.
- Managed launch commands emit `DEEPSEEK_STOP_MARKER` on exit; the reader clears the endpoint even when optional shell monitoring is disabled.
- Daemon attach tracks the session before replay arrives, independently of active UI. Source quoting normalizes absolute cmd/pwsh/wsl shell executable identities and rejects unknown shells.
- A live daemon can preserve its running service without restarting it. Its browser endpoint is recovered only if retained replay still contains readiness. If checkpoint truncation removed readiness, the WebUI button waits for new readiness. Recovering an endpoint from a checkpoint alone remains unresolved; do not describe all live reattachments as restoring a usable browser button.

## Review references

- `.trellis/spec/backend/deepseek-web-contracts.md`
- `.trellis/spec/frontend/workspace-session-restore-contracts.md`
- `.trellis/spec/backend/wsl-path-contracts.md`
- `.trellis/spec/backend/ssh-remote-terminal-contracts.md`
- `design.md`: impact/discovery list and environment matrix.

GitNexus MCP is unavailable in this session. No automatic impact or detect_changes success is claimed. Use contract-guided symbol references and the final diff to review expected scope before commit.

## Runtime build finding

The reference checkout contained generated output from a retired package, `packages/settings/settings-file`, which made the official Host workspace glob fail on a removed SettingsProvider export. Its directory had no tracked source. Removing only that orphan generated directory, then rebuilding Host -> Client -> Web restored the official main page. The manager never installs/builds a selected source tree on save/launch; this preparation was test-environment work requested for this local checkout.

Full WSL/SSH desktop execution and paid conversation generation were not tested. Source rejection, SSH forwarding restrictions and PTY output/lifecycle behavior have automated coverage; these are not presented as full environment end-to-end tests.

## ConPTY interrupt result

The real Windows regression passes with raw ETX input, no runtime-monitoring injection, the same SIGINT registration used by official DSH, isolated Shell history, and a still-live parent PowerShell. The first interval-only fake process did not reproduce DSH's SIGINT registration; that fixture was corrected rather than ignored. The test verifies standalone output lines and closes its process tree through RAII. No existing keyboard protocol or PTY implementation was changed.
