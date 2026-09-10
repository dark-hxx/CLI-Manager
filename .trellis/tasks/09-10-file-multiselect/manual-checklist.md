# Human desktop acceptance checklist

The application/services were not launched for AI validation. Build this PR, then use disposable project files; deletion is permanent and does not use the recycle bin.

- [ ] In both zh-CN and en-US, Ctrl-click two files and a folder: all highlight and the selected count matches; no extra editor opens and folders do not expand. Ctrl-click again removes one; plain click selects one; Esc/list whitespace clears selection.
- [ ] Release Ctrl and drag an already-selected row into a target folder: the whole group moves, drag badge matches the deduplicated group, and source/target lists update immediately. Single-item dragging remains unchanged.
- [ ] Select a parent and its child: move/delete executes the parent only. Try same-folder move, self/descendant drop, and same-named files from two source folders: no unexpected overwrite or deletion occurs.
- [ ] Ctrl+X then click a destination folder and Ctrl+V; repeat through right-click Cut/Paste. Ctrl+C works for multiple files. Cancel an overwrite dialog; retry and confirm it with disposable files; completed items are not retried. Directory replacement is explicitly explained as replace, not merge.
- [ ] Delete key and right-click Delete show item count, paths and the permanent/no-recycle-bin warning. Cancel leaves all files intact. Confirm deletes only selected items. Test a locked/missing file alongside another item and verify partial-failure details.
- [ ] Keep a selected source or overwrite target dirty in the editor: it must be protected. Edit a buffer while a large operation is pending: the buffer must remain. Confirm save/close behavior yourself before retrying.
- [ ] Repeat selection, menus, deletion and dragging in filename and content search, normal sidebar and embedded/split panel, compact directory chains and ignored/dimmed directories. Linked Worktree `.git` files remain hidden.
- [ ] In the search box, rename input, Monaco editor and terminal, Ctrl+C/X/V and Delete retain their original meaning. Switch project/Worktree while an operation is pending: remaining operations are cancelled and the new project's files are untouched.
- [ ] SSH remains read-only through menu, Delete, Ctrl+X/V and filesystem drag-drop. WSL path case and spaces/non-ASCII filenames behave correctly; symbolic links/junctions are rejected rather than dereferenced by move/delete.
- [ ] Single and multi-item drops into the same-project terminal insert paths without moving files; cross-project terminal drops use absolute-path fallback and do not switch the source file panel.
- [ ] Built-in Live Server still opens local HTML in the default browser, reloads changes and stops from the root menu. Check normal/minimized/restored windows, focus mode and split/Workspan switching for selection/drag regressions.
- [ ] Switch interface language through Settings -> General; all new menus, summaries and confirmations translate and time formatting remains 24-hour.
- [ ] Git change files/directories still use the default single-item terminal drag; opening/closing another file panel must not cancel a drag it does not own.
