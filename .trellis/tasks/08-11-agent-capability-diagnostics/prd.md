# Agent MCP and Skills session diagnostics

## Goal

Add a session-bound Agent capability card to the terminal real-time statistics panel. It must show the effective MCP configuration, layered MCP health, and discovered Skills for the exact active AI Agent session across local, WSL, and SSH environments.

## Requirements

- Support Claude, Codex, Pi, Grok Build, and OpenCode.
- Bind strictly to the active terminal tab's `cliSessionId`; never guess from project history.
- Add one configurable summary card and a keyboard-accessible MCP/Skills detail modal.
- MCP activation is the session-effective configuration. Keep activation (`active`/`disabled`) separate from health (`healthy`/`error`/`checking`/`unknown`).
- Skills include all discovered user/project/plugin/package candidates with `available`, `disabled`, `denied`, `shadowed`, or `invalid` state and origin scope.
- Refresh on panel/session/hook events and explicit user action. Manual deep checks may only use Agent-native read-only diagnostics; never directly launch configured MCP servers.
- Run diagnostics in the terminal's environment: local Windows/macOS/Linux, WSL, or the compatible remote SSH Agent. Do not inspect SSH paths locally.
- Return normalized, redacted results. Do not persist or expose secrets, headers, tokens, raw environment values, or arbitrary command arguments.
- Add OpenCode session hook/plugin support. Remote diagnostics require the SSH Agent capability `agent-capabilities-v1`; old agents show an upgrade-required state.
- Preserve existing user changes in settings/provider files, `src/lib/i18n.ts`, `CHANGELOG.md`, and `docs/功能清单.md`.
- Changelog Target: `[TEMP]`.

## Scenario Matrix

- Window state: focused, another app/window focused, minimized/tray.
- Terminal topology: current pane, sibling/deep split, multiple sessions, Workspan switches, focus mode.
- Runtime: local PowerShell/CMD/Pwsh/Bash, WSL, SSH Agent.
- Project state: main checkout, worktree, missing worktree/cwd, trusted and untrusted project config.
- Hook state: installed, missing, partially installed, stale SSH Agent, Session ID rebound/restarted.
- Async state: rapid tab switching, stale/late response, concurrent refresh, timeout, partial adapter failure.

## Acceptance Criteria

- [ ] The card displays the exact Agent and bound Session ID plus active MCP health and Skill counts.
- [ ] The modal lists MCP/Skills with statuses, sources, timestamps, redacted errors, filters, refresh, and deep-check controls.
- [ ] Missing Session ID or hook produces an actionable localized state and never falls back to another session.
- [ ] Static MCP configuration without runtime evidence is `unknown`, not healthy or abnormal.
- [ ] Disabled MCPs are visible in details but excluded from active counts.
- [ ] Config changes after session start are identified without claiming they are already active.
- [ ] Five Agent adapters behave consistently; Pi reports unobservable extension MCP state as unknown rather than zero.
- [ ] Local, WSL, and SSH routing uses fixed backend-owned commands with timeouts and cancellation/stale-result protection.
- [ ] Existing real-time card visibility/order settings migrate additively.
- [ ] All new user-visible copy and ARIA labels work in zh-CN and en-US with 24-hour time formatting.
- [ ] TypeScript checks, Rust checks/tests, targeted frontend tests, and GitNexus change detection pass.

## Definition of Done

- Implementation and regression tests are complete.
- Relevant Trellis contracts, `[TEMP]` changelog notes, and feature inventory are updated.
- No unrelated dirty-worktree edits are overwritten or bundled.

## Out of Scope

- Support for AI Agents other than the five listed above.
- Universal direct MCP protocol handshakes or automatic server restarts.
- Persistent storage of diagnostic snapshots or secret-bearing configuration.
- Local fallback for an unavailable/outdated SSH Agent.

