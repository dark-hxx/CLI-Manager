# Bug Analysis: WSL capability identity

## 1. Root Cause Category

- B/C/D/E: cross-process contract + incomplete propagation + producer coverage gap + implicit environment assumption.
- WSL guest `WSL_DISTRO_NAME` does not automatically become a Windows interop process variable. The Windows Hook reads a missing value because PTY launch did not declare the guest-only WSLENV entry.
- Native Pi/OpenCode bypass that executable and omitted the same field in their payloads.

## 2. Why Fixes Failed

- Prior c573a657 fixed session storage and request assembly, testing fabricated nonempty Hook identities. It did not verify the actual process/payload producers.
- Restarting WSL alone cannot change the unchanged launch environment merger or old installed extension source.

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific action | Status |
| --- | --- | --- | --- |
| P0 | Producer contract | Guest-only WSLENV entry independent of host value | Implemented |
| P0 | Behavioral regression | Execute native extension source, capture all lifecycle payloads | 8 tests red before / green after |
| P0 | Regression | WSLENV no-host-value, flags, dedup/idempotence, unrelated-entry preservation | Added |
| P1 | Spec | Explain interop producer boundary and upgrade lifecycle | Updated |

## 4. Systematic Expansion

- Covered shared Windows Hook users and both native producer paths. Hook command ownership, request schemas, frontend binding, path normalization, cache scope and backend validation were inspected and retained; see design.md discovery list.
- Window focus, minimize/tray and sidebar presentation do not select identity; each WSL process owns it. Exact Tab/session binding continues to isolate split/Workspan/Worktree activity.
- SSH does not use this WSL launch branch. Native local plugins report null rather than inventing a distro.
- Uninstalled Hooks stay unbound. Old daemon/PTY instances and installed extension copies cannot be retroactively updated by a frontend refresh.

## 5. Knowledge Capture

- Updated agent-capability-diagnostics-contracts.md and terminal-runtime-monitoring-contracts.md.
- GitNexus analyze refreshed the stale index; FTS remains unavailable and impact targets returned UNKNOWN/not found. Direct call references establish `create_with_launch` → WSL env merger, Pi install → source generator, and OpenCode bridge → post. No HIGH/CRITICAL result was returned; UNKNOWN is not a zero-risk claim.

## Validation

- Node targeted suite: 38/38 passed (8 added producer cases).
- Architecture strict: 1290 files, zero violations, zero files above 2000 lines.
- Rust WSLENV test first reproduced the missing field (1 failed on old implementation), then all 7 WSLENV tests passed on the fix.
- `npx tsc --noEmit` and `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- `git diff --check` passed. Scoped `rustfmt --check` reports only two existing formatting blocks in `create_with_launch`; unrelated formatting was deliberately restored to HEAD rather than expanding this patch.
- `gitnexus_detect_changes(scope=all)` returned low risk, identifying PtyManager/tests; graph coverage omits the native script producers and new test file, which were manually reviewed.
- WSL unavailable on this host; no actual guest/Windows interop or desktop UI was run. No visible copy changes, so no new locale strings.

## Manual acceptance on a WSL machine

0. 本轮新增：旧 Hook 没有发行版字段、但已经精确绑定且可读取 WSL 历史记录时，能力卡片刷新/深度检查应从历史来源识别正确发行版；切换不同 Agent、不同会话和 Worktree 后不得借用上一个页签的来源。源文件不在 WSL、仍未绑定或尚无历史来源时不猜测默认发行版。
1. Update the application and daemon, end old background terminal processes, create a new WSL Codex/Claude/Grok terminal for a Windows-path project and open Agent capabilities. Inspect/refresh/deep check must use that distro and a Linux cwd.
2. Repeat for Ubuntu/Debian (if installed), WSL UNC, and Worktree; switch split panes/Workspans and check each session keeps its own capabilities.
3. Reinstall/load Pi/OpenCode managed extensions in the applicable environment; lifecycle events must bind the current session and distro.
4. Verify a local/SSH tab retains its previous route and an unbound/no-identity session never scans a guessed environment.

## Follow-up: customer log and exact-history identity

### 1. Root Cause Category

- B/C/D/E: the exact-history-to-request boundary dropped available WSL provenance. History was accepted as MCP evidence, but its file_path was never passed to distro resolution.
- The supplied log has an exact matching Codex session in Ubuntu at 11:11:14 (line 2199). The warnings at 11:14:14 and 11:20:33 belong to pre-launch extension environment selection; no Hook-ingress/capability-request entry in that time window proves dev/release misrouting.

### 2. Why Fixes Failed

- The initial producer fix requires a new daemon/PTY or reloaded plugin. It did not help older Hook sessions whose identity was already available from exact WSL history.
- Shared Hook executable location is not callback ownership. The prior committed launch fix already injects the current app endpoint and prevents managed Codex shared-server reuse; overwriting Hook configuration was not supported by the new evidence.
- Three new regressions failed before the request-assembly fix (null distro for pure resolver, actual inspect request and Worktree scenario); all passed afterward.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific action | Status |
| --- | --- | --- | --- |
| P0 | Exact source boundary | Filter bound history once by nonempty CLI ID and Agent, use it for both provenance and MCP evidence | Done |
| P0 | Request regression | Run real React Hook callbacks with mocked IPC; inspect/probe must send distro and Linux cwd | Done |
| P0 | Isolation regression | Reject unrelated/unbound history; preserve explicit distro, Worktree and local/SSH route | Done |
| P1 | Contract | Record provenance precedence, extended UNC, cache scope and SSR/interop limits | Done |

### 4. Systematic Expansion

- Reused parseWslPath, including extended UNC. No new parser, default distro lookup, extra history query, Hook ownership rewrite, IPC field or persistence.
- New history arrival changes the existing WSL scope key. Async generation rejection and panel effects are unchanged; SSR verifies request construction, not mounted UI races.
- Per-Tab binding remains independent of focus, split, tray or Workspan. Project extension pre-launch environment selection is a separate feature and was not changed based on the unrelated warning.

### 5. Knowledge Capture and Validation

- Updated existing agent capability contract, V1.4.3 changelog and the Agent MCP/Skills feature inventory.
- This application has no src/templates/markdown/spec directory; no template copy is applicable.
- Node: 55/55 passed across agentCapabilities, wslHookIdentity, terminalHookBinding, opencodeHook and codexHookIsolation.
- Rust WSLENV: 7/7 passed. TypeScript noEmit passed. Strict architecture: 1293 files, no file over 2000 lines, zero violations.
- Final cargo check and git diff --check passed. No standalone lint script is configured in package.json.
- GitNexus change detection reports low risk for its indexed subset (PtyManager/tests and hookDistroName); missing symbols/native producers were reviewed directly. Its empty process result is not proof of complete graph coverage.
- No visible strings/styles were changed. Real WSL/desktop checks remain manual; the customer log establishes available provenance but does not capture a successful live diagnostic after this patch.
