# Mobile project drawer verification — 1.3.10

- Root cause: the <768px Web layout hides ProjectSidebar without an alternate project selection entry.
- Changed: Workbench header and drawer lifecycle; ProjectSidebar reused in drawer; mobile-only styles; existing bilingual strings reused. Desktop sidebar and ProjectTree launch/API implementation preserved.
- Scenarios: zero/multiple terminals, project/Worktree selection, empty projects, device offline, browser disconnected, new terminal snapshot, existing terminal, close/backdrop/Escape, narrow/wide, portrait/landscape and keyboard geometry.
- Passed: npm run build --prefix apps/web (TypeScript + production assets; existing >500kB chunk warning remains).
- Passed: node scripts/webSubagentPanel.smoke.mjs --run. Real headless Chrome renders production components with isolated fixture callbacks. Mobile tree selection, launch context, completion dismissal, offline gating, English/Chinese, width and existing terminal/subagent/keyboard regression passed without browser errors.
- Scope limit: no physical phone or real desktop PTY launch tested this round; existing API is unchanged. Phone tree drag disabled to preserve scrolling; shortcut launch is visible without hover.
- GitNexus tools unavailable; refreshed codebase-memory inbound trace and source/contracts used. detect_changes includes pre-existing dirty files; only this task's explicitly selected files are committed.
- Environment: native sandbox and apply_patch launcher failed with helper_sandbox_lock_failed; used approved elevated codex --codex-run-as-apply-patch and build commands.
- Delivery: Web static ZIP only; installer embedding deferred per user.
