# Proposed commit plan

## Desktop acceptance and PR description follow-up
`docs: record user desktop acceptance for DSH TUI`

Only this task's `verification.md`, `prd.md`, `task.json` and `commit-plan.md` are changed. The user confirmed desktop testing with no issues and explicitly requested a PR-description update. Previous commit/push authorization remains valid; the verified TUI implementation is a fast-forward descendant of PR #273's old WebUI head. Publish this documentation commit to the TUI branch and fast-forward the same commits to the existing PR branch, then update its title/body without changing Draft status. The ignored body-file draft is not committed. This documentation-only follow-up requires a scoped diff check rather than rerunning unchanged code tests.

## Native startup follow-up (2026-10-02)
`fix(deepseek): launch native TUI without manager injections`

User's existing authorization covers committing/pushing this task to their fork. This follow-up was investigated and implemented by root only, as requested. Scope was checked by contracts, symbol references and Git diff because GitNexus is unavailable; no claim is made that detect_changes ran. Explicit files:

- `.trellis/spec/backend/deepseek-tui-contracts.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/design.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/prd.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/verification.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/commit-plan.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/task.json`
- `CHANGELOG.md`
- `docs/功能清单.md`
- `scripts/deepseekTuiReactPreload.test.mjs`
- `scripts/deepseekTuiRuntime.test.mjs`
- `src-tauri/resources/deepseek-tui-react-preload.mjs`
- `src-tauri/src/features/deepseek/commands.rs`
- `src-tauri/src/features/deepseek/preflight.rs`
- `src-tauri/src/features/deepseek/tests.rs`
- `src-tauri/tests/deepseek_tui_smoke.rs`
- `src/features/projects/components/ConfigModal.tsx`
- `src/features/projects/components/DeepSeekHarnessFields.tsx` (removed)
- `src/features/terminal/lib/terminalLaunch.ts`
- `src/shared/i18n/messages/projects.en-US.ts`
- `src/shared/i18n/messages/projects.zh-CN.ts`
- `src/shared/lib/deepseekTui.ts`

No ignored smoke log/preferences, user installation/profile, external repository, credentials, dependency or unrelated feature enters this commit. Full desktop/guest acceptance remains pending; task stays active.

## Work commit
`feat(deepseek): replace WebUI integration with DSH TUI`

The list below consists entirely of files changed by this implementation and its collaborating agents. No unrecognized user changes were found. No global dependency, user profile, .tmp log, credential or reference repository file is included.

- `.trellis/spec/backend/deepseek-web-contracts.md`
- `.trellis/spec/backend/index.md`
- `.trellis/spec/backend/pty-daemon-contracts.md`
- `CHANGELOG.md`
- `docs/功能清单.md`
- `scripts/deepseekHarness.test.mjs`
- `scripts/resumeCliArgs.test.mjs`
- `scripts/terminalProcessManager.test.mjs`
- `src-tauri/src/features/deepseek/commands.rs`
- `src-tauri/src/features/deepseek/pty_tests.rs`
- `src-tauri/src/infrastructure/pty/manager.rs`
- `src-tauri/src/infrastructure/pty/platform/windows.rs`
- `src-tauri/src/lib.rs`
- `src/features/projects/api/deepseekSource.ts`
- `src/features/projects/api/projectStartupCommand.ts`
- `src/features/projects/api/saveSessionToSidebar.ts`
- `src/features/projects/components/ConfigModal.tsx`
- `src/features/projects/components/DeepSeekHarnessFields.tsx`
- `src/features/terminal/api/TerminalProcessManager.ts`
- `src/features/terminal/api/deepseekWebRuntime.ts`
- `src/features/terminal/components/DeepSeekWebButton.tsx`
- `src/features/terminal/hooks/useTerminalToolbarRenderer.tsx`
- `src/features/terminal/lib/terminalLaunch.ts`
- `src/features/terminal/store/terminalStore.ts`
- `src/features/terminal/types/terminalStoreTypes.ts`
- `src/shared/i18n/messages/projects.en-US.ts`
- `src/shared/i18n/messages/projects.zh-CN.ts`
- `src/shared/i18n/messages/terminal.en-US.ts`
- `src/shared/i18n/messages/terminal.zh-CN.ts`
- `src/shared/lib/cliTools.ts`
- `src/shared/lib/deepseekHarness.ts`
- `.trellis/spec/backend/deepseek-tui-contracts.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/design.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/implement.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/prd.md`
- `.trellis/tasks/10-01-deepseek-harness-tui/task.json`
- `.trellis/tasks/10-01-deepseek-harness-tui/verification.md`
- `scripts/deepseekTui.test.mjs`
- `scripts/deepseekTuiBridge.test.mjs`
- `scripts/deepseekTuiRuntime.test.mjs`
- `scripts/deepseekTuiReactPreload.test.mjs`
- `scripts/deepseekTuiNodeOptions.test.mjs`
- `src-tauri/resources/deepseek-tui-bridge.mjs`
- `src-tauri/resources/deepseek-tui-react-preload.mjs`
- `src-tauri/resources/deepseek-tui-node-options.cmd`
- `src-tauri/src/features/deepseek/launch.rs`
- `src-tauri/src/features/deepseek/preflight.rs`
- `src-tauri/src/features/deepseek/tests.rs`
- `src-tauri/tests/deepseek_tui_smoke.rs`
- `src-tauri/tests/windows_conda_path_smoke.rs`
- `src/features/terminal/api/deepseekTuiRuntime.ts`
- `src/shared/lib/deepseekTui.ts`
- `.trellis/tasks/10-01-deepseek-harness-tui/commit-plan.md`

## Approval and bookkeeping
The user explicitly authorized desktop computer-use acceptance, committing code and pushing to their fork in this turn; no repeat confirmation is needed. The existing `jackie-cqz/CLI-Manager` fork is reused and receives this new branch. Desktop manual acceptance remains blocked by the computer-use capture/input failures recorded in verification.md, so the task stays active rather than being archived as complete. Journal recording may follow the implementation commit. Existing WebUI Draft PR #273 is not updated by this task's commit/push.
