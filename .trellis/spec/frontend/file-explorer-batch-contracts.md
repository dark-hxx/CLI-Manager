# File Explorer Selection and Batch Operations

## Scope
`FileExplorerSidebar` (tree, filename search, content search; sidebar and panel hosts),
`fileExplorerStore` and pure `fileExplorerOperations` helpers. Existing Tauri file command signatures remain unchanged.

## Selection and focus
- `selectedEntries` is ephemeral and independent of the active editor and `selectedTreePath` reveal/scroll marker.
- Ctrl/Command-click toggles selection without opening/expanding. Plain click replaces selection and keeps existing open/expand behavior.
- Right-click and pointer-down on a selected row preserve the set. Pointer-down on another row selects only that row. A completed drag suppresses the following click.
- Input, textarea, select and editable elements retain their own shortcuts; no global file action listener is installed. SSH write actions are blocked in UI and store.
- Clearing/changing a search view clears selection; rerunning the same search after an operation does not.
- The file explorer and Git panel share `useTerminalFilePointerDrag`. Optional payload/label callbacks carry the file selection snapshot; omitted callbacks retain single-item behavior. A changed file-panel `resetKey` cancels only that hook's drag, never another panel's drag or global selection style.

## Clipboard and operations
- Clipboard stores `{id, mode, entries, project, generation}`. Pending confirmations and drags capture their source scope; they never resolve paths against whichever project happens to be active later.
- Every batch is sequential and non-transactional; a mutation lock prevents overlapping batches. Root/path containment remains a Rust responsibility.
- Deduplicate descendants of selected directories, keeping path-component boundaries and local Windows versus WSL/POSIX case semantics.
- Same-parent moves are no-ops. Reject duplicate destination names within one batch, source/destination overlap and self-descendant moves before IPC.
- Default `overwrite=false`. A conflict confirmation retries only captured conflict entries; never replay successful entries or consume a newly replaced clipboard. Directory overwrite replaces, not merges.
- Deletion confirmation explicitly says permanent deletion and no recycle bin. Batch results expose succeeded/skipped/conflicting/failed entries separately; do not show unconditional success.
- Protect dirty source/target buffers before mutation and retain buffers dirtied while IPC is pending. Update successful results only in the source project's editor workspace.

## Refresh invariant
- `refreshVisibleState` accepts changed **entry paths**, not their parent directory paths. Passing parents refreshes one level too high and leaves nested listings stale.
- Include expanded descendants when refreshing a replaced directory. Gate stale in-flight refresh snapshots with the mutation revision/lock and preserve editor buffers changed while a refresh awaited I/O.
- Suppressed watcher events trigger a full visible refresh after the batch. Otherwise coalesce affected entry paths and refresh Git/search once per batch.

## Regression checks
Run `node --test scripts/fileExplorerMultiSelect.test.mjs scripts/fileExplorerBatchStore.test.mjs scripts/fileExplorerMultiSelectUi.test.mjs scripts/terminalFilePointerDrag.test.mjs`, existing file explorer/terminal path tests, and the frontend production build. Rust file command tests cover link guarding and no-op/ancestor moves.

Per repository quality rules, do not launch CLI-Manager or its services for AI runtime UI verification. Human checks must cover both locales, theme/layout variants, actual Ctrl-click and pointer dragging, terminal focus, SSH read-only and WSL/Worktree paths.
