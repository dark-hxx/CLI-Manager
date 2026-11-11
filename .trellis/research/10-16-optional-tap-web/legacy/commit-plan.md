# Proposed commit batch

Upstream Trellis Phase 3.4 requires one-shot user confirmation. The user explicitly confirmed this batch and Draft submission with “確認，提交之前再詳細複審一遍”. Execute only after the detailed review and its regressions pass; see `review.md` and `verification.md`. All paths below are this task's work, with no unrelated original Tap-Code source changes.

## 1. `refactor(web): share browser transport and terminal primitives`

- `src/shared/types/webBrowser.ts`
- `src/shared/lib/webBrowserHttp.ts`
- `src/shared/lib/webBrowserSocket.ts`
- `src/shared/lib/webRequestId.ts`
- `src/shared/lib/webTerminalStream.ts`
- `src/shared/lib/webImageUpload.ts`
- `apps/web/src/domain.ts`
- `apps/web/src/requestId.ts`, `requestId.test.mjs`
- `apps/web/src/terminalStream.ts`, `terminalStream.test.mjs`
- `apps/web/src/webClient.ts`, `reconnect.test.mjs`
- `apps/web/src/useAppModel.ts`
- `scripts/webProjectFiles.test.mjs`

The new Tap-specific frame assembler belongs in commit 2, since Classic continues to use its existing renderer.

## 2. `feat(web): add optional Tap workspace`

- `apps/web-tap/` (source, tests, design/product/README, SVG-generated icons, font plus OFL)
- `src/shared/lib/webTerminalRenderQueue.ts`, `webTerminalRenderQueue.test.mjs`
- `src/features/terminal/lib/webTerminalTranscript.ts`, unit/integration tests
- `src/features/terminal/lib/webManagement.ts`, `webManagement.menu.test.mjs`
- `apps/server/src/api.rs`, `src/lib.rs`, `tests/tap_static.rs`
- `src-tauri/src/commands/web_device.rs`, `src/web_daemon.rs`, `tauri.conf.json`
- `apps/web/src/views.tsx`, `i18n.ts`
- `package.json`, `package-lock.json`, `scripts/package-portable.ps1`
- `CHANGELOG.md`, `docs/功能清单.md`
- `.trellis/spec/backend/web-service-contracts.md`
- `.trellis/spec/frontend/web-ui-visual-guidelines.md`
- `.trellis/tasks/10-16-optional-tap-web/` including curated fixture screenshots

## Exclusions and follow-up

- `.impeccable/review/`: redundant working captures, not part of the PR; curated copies are in the task.
- `.trellis/workspace/codex/`: session bookkeeping only; not silently bundled with code. Record separately after approved work commits.
- No unrecognized dirty code paths in this isolated worktree.
- No original `/share/codeSpace/Tap-Code` analysis documents, dependencies, secrets, generated dist/targets or user work included.
- After approved commits, push only `feat/optional-tap-web` to the verified `nnnmdzz/CLI-Manager` fork and create a **Draft** PR against `dark-hxx/CLI-Manager:master` with `pr-body.md`. No merge, deploy, native install or broad cleanup.
