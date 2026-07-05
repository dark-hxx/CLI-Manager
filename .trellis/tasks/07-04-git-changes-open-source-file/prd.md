# Git changes open source file

## Changelog Target

[TEMP]

## Goal

Implement GitHub issue #81: add an "Open Source File" action to the Git changes file-list context menu so users can jump from a changed file to the existing file editor pane.

## Requirements

- In the Git changes file tree, right-clicking a file shows an "Open Source File" menu item.
- Selecting it opens the file in the existing project file editor pane.
- Deleted files cannot be opened and should have the action disabled.
- When the active tab is a file editor, the right Git panel still resolves the editor's project path.
- Keep existing click-to-diff behavior unchanged.
- Add zh-CN and en-US translations for the new user-visible text.

## Acceptance Criteria

- [ ] Right-clicking a modified/added/untracked/renamed/copied file in Git changes exposes the source-file action.
- [ ] Selecting the action opens or focuses the file editor pane with that file active.
- [ ] Deleted files do not trigger a failing open attempt.
- [ ] Git changes panel is not empty when the active tab is the project file editor.
- [ ] Existing Git actions such as copy AI path, stage, unstage, track, and revert still work.
- [ ] `npx tsc --noEmit` passes.

## Definition of Done

- Minimal frontend-only implementation.
- No new dependencies.
- `CHANGELOG.md` updated under `[TEMP]`.
- `docs/功能清单.md` updated for the user-visible behavior.
- Commit message references issue #81.

## Technical Approach

Reuse existing file explorer behavior:

- `useFileExplorerStore.openProject(project)` loads or focuses the project file state.
- `useFileExplorerStore.openFile({ name, path, kind: "file", sizeBytes: 0 })` opens the source file.
- `useTerminalStore.openFileEditorPane(project)` opens or focuses the file editor pane.

The Git tree components only need to pass a new file-level callback from `GitChangesPanel` through `GitChangesTree` into `GitTreeNode`.

## Out of Scope

- No external editor integration.
- No backend command changes.
- No change to left-click Git diff behavior.
- No attempt to open deleted source files from Git history.

## Technical Notes

- Issue: https://github.com/dark-hxx/CLI-Manager/issues/81
- Current Git tree menu: `src/components/git/GitTreeNode.tsx`
- Git panel owns project resolution: `src/components/git/GitChangesPanel.tsx`
- Existing file editor open flow: `src/components/files/FileExplorerSidebar.tsx`
- Existing file open store: `src/stores/fileExplorerStore.ts`
- Existing editor pane API: `src/stores/terminalStore.ts`
