# File explorer multi-selection

## Approval and baseline
- User approved the previously proposed scope and creation of this Trellis task on 2026-09-10.
- Preserve built-in Live Server. Changelog version defaults to TEMP pending the user's optional version answer.

## Requirements
- Ctrl/Command-click toggles files/directories without opening files or expanding directories. Plain click selects one and retains existing open/expand behavior.
- Dragging an already-selected row preserves the entire selection; pointer dragging moves all selected roots to a project-local folder.
- Ctrl+X/C/V and context menus operate on the selection. Delete asks once, shows item count/paths and explicitly warns that deletion is permanent (not the recycle bin).
- Parent/child selections are deduplicated. Same-parent moves are skipped; self/descendant moves and root mutation are rejected. Never overwrite without explicit confirmation.
- Protect dirty editor buffers (including saved project workspaces). Aggregate per-item errors; a partial failure is not reported as total success. Avoid per-file Git refreshes.
- Selection, operation snapshots and delayed dialogs are bound to project location; switching project/Worktree never mutates the new project using old paths.
- Cover tree, filename search, content search, sidebar and embedded panel. SSH remains read-only, including keyboard and pointer routes.
- Keep single-file terminal drops and Live Server behavior. Multi-file terminal drops may reuse the existing text payload rather than alter terminal input handling.

## Acceptance and limits
- Behavioral tests for selection, hierarchy dedup, mixed outcomes, conflicts, dirty protection, scope changes and keyboard guards; existing file/terminal/Live Server regressions; TypeScript/build and relevant Rust checks.
- No cross-project filesystem transfer, OS clipboard file integration, recycle-bin implementation or batch rename.
- Repository quality rules prohibit starting CLI-Manager services/Tauri for AI UI verification. Deliver precise human checks for both UI languages, layouts, WSL and actual drag/focus behavior; do not claim these ran.
