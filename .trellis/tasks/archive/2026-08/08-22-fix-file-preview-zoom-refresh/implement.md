# V1.3.8 实施计划

## Pre-implementation

1. Run `trellis-before-dev` and read the affected frontend/backend contracts.
2. Run GitNexus upstream impact analysis before changing each code symbol (`FileEditorContent`, refresh store/controller symbols, `FileExplorerSidebar`, SSH file helpers, Git Diff rendering symbol). Report LOW/MEDIUM/HIGH risk; stop for user direction if any result is HIGH or CRITICAL.
3. Reconfirm unrelated dirty `AGENTS.md` and `CLAUDE.md` are preserved.

## Implementation Steps

1. Fix file Markdown preview zoom.
   - Set the existing preview font size as `--markdown-preview-font-size` on `FileEditorContent`’s Markdown preview container.
   - Add a file-preview-scoped rule that makes `.ui-markdown-terminal` consume that variable, overriding the renderer’s fixed `text-xs` only in this context.

2. Make refresh lifecycle persistent.
   - Introduce an App-mounted nonvisual `ProjectFileRefreshController` under `src/components/files/`.
   - Move local watcher subscription/start/stop, WSL fallback timer, focus/visibility refresh, and changed-path scheduling from `FileExplorerSidebar` into it.
   - Keep only the sidebar-local `.gitignore` invalidation listener where needed.
   - Reuse `refreshVisibleState` coalescing; do not create a second queue or parallel data store.

3. Add quiet SSH automatic refresh.
   - Extend existing SSH remote list/read helpers with an explicit silent/background option that bypasses `backgroundOperationStore` only for automatic checks.
   - Thread the mode through `refreshVisibleState` / `refreshVisibleStateOnce` / remote file loading as needed.
   - Run SSH’s confirmed 15-second timer only when remote context is valid and there are opened files; refresh on foreground/focus as well.

4. Fix Git Diff Markdown table token layout.
   - Add a scoped Diff CSS reset for Refractor syntax token spans in `.diff-code`, preserving inline source-token layout despite Tailwind utility-class collisions.
   - Do not change `parseDiff`, hunk line accounting, Markdown AST parsing, or global `.table` utility behavior.

5. Add file editor tab close context menu.
   - Add a Radix context menu to ordinary `FileEditorTabs` entries with file-specific localized actions: close current, close others, close left, and close right.
   - Use the terminal Tab `terminal-skin` plus root terminal-theme variables for the file-tab menu surface, because Radix renders the menu in a body portal; do not use the file-explorer menu skin for this Tab-level menu.
   - Calculate ordered target file paths in the Tabs component and disable actions with no target. Do not attach the menu to `GitDiffEditorTabs`, and do not copy terminal/workspan/session actions.
   - Generalize the existing `FileEditorPane` close request so one selected target or a batch gets one dirty-file confirmation. Save only the selected dirty paths; cancel before any target is closed; preserve `closeFile` as the store-level active-file fallback action.
   - Cover a normal file workspace, a Worktree location, local/WSL/SSH read-only constraints, a split-pane file editor, and a visible pinned Git Diff tab. Window focus/minimized/tray and Hook installation are intentionally no-op presentation states: they neither broaden the target set nor produce terminal actions.

6. Add targeted regression coverage.
   - Extend file refresh tests for controller lifecycle independence, local/WSL fallback, SSH silent polling/no-local-fallback, dirty drafts, focus refresh and cleanup.
   - Extend Git Diff coverage with a Markdown table token regression guard covering table header, separator and data rows in both wrapping modes.
   - Add a focused static regression test for the file-tab menu's four actions, ordering/disabled guards, dirty-batch handoff, i18n keys, and explicit exclusion of terminal-only/Git Diff tab behavior.
   - Update existing source-architecture tests rather than duplicating unrelated test frameworks where practical.

7. Record the release.
   - Update `CHANGELOG.md` and `docs/功能清单.md` under `V1.3.8`.

## Validation

```powershell
npx tsc --noEmit
node --test scripts/fileExplorerProjectState.test.mjs scripts/fileExplorerWslGitRefresh.test.mjs scripts/gitStoreRemote.test.mjs
node --test scripts/gitDiffThemeWorkflow.test.mjs scripts/gitDiffViewerArchitecture.test.mjs scripts/gitDiffInteractionA11y.test.mjs
node --test scripts/fileEditorTabContextMenu.test.mjs scripts/fileExplorerProjectState.test.mjs scripts/gitDiffEditorPin.test.mjs
cd src-tauri; cargo check
cd src-tauri; cargo test file_watcher
```

Manual desktop verification:

1. In local, WSL and SSH projects, open clean text/Markdown/image files; hide the file side panel; modify externally; confirm automatic refresh and focus refresh.
2. Repeat with dirty text and Markdown drafts; confirm no overwrite.
3. Confirm SSH automatic checks create no recurring background-operation item and never use a local path fallback.
4. In both Git Diff dialog and editor, inspect added/modified Markdown tables in unified and split modes with wrap on and off; every source table row must remain one logical diff row.
5. Check Markdown preview zoom, source-mode stability and both `zh-CN` / `en-US` UI modes.
6. Right-click a clean and a dirty file tab in a single-file and multi-file editor. Verify the four close actions, disabled direction cases, Save/Discard/Cancel batch behavior, file-order semantics, unchanged pinned Git Diff tabs, and no terminal-specific menu item in `zh-CN`, `zh-TW`, and `en-US`.

## Expected Files and Rollback Points

- Likely frontend files: `src/components/files/FileEditorContent.tsx`, `src/components/files/FileEditorTabs.tsx`, `src/components/files/FileEditorPane.tsx`, `src/components/files/FileExplorerSidebar.tsx`, new refresh controller, `src/stores/fileExplorerStore.ts`, `src/lib/sshRemoteFiles.ts`, `src/components/git/diffViewer.css`, `src/lib/i18n.ts`, and focused test files.
- No expected Rust or SSH Agent source changes; if evidence requires a protocol change, stop and return to planning because that exceeds the agreed scope.
- Before commit run GitNexus `detect_changes()` and verify only the planned file editor, file refresh, SSH client, Diff CSS/tests, and release-document flows are affected.
