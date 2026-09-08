# Implementation plan

## Preconditions

- [x] User approved Trellis task creation and requested version V1.3.9.
- [x] Branch check: `master` is synchronized with `origin/master` (0 ahead / 0 behind).
- [x] Dirty worktree recorded; preserve all pre-existing changes.
- [x] Root-cause triage and discovery list completed.
- [x] GitNexus impact attempted for `FileExplorerSidebar` and `ContextMenuContent`; stale index returned `UNKNOWN`, so contract/history/grep fallback was used.
- [x] After the first runtime rejection, branch synchronization was rechecked (0 ahead / 0 behind) and GitNexus impact was retried for both shared Radix content symbols; both remained `UNKNOWN`.

## Implementation

- [x] Import the existing `Portal` component in `FileExplorerSidebar.tsx`.
- [x] Remove `setMenuPortalContainer` from the visible `.ui-file-explorer-sidebar` root.
- [x] Render a dedicated body-level Portal host with `ref={setMenuPortalContainer}`, an identifying data attribute, and the existing `panelStyle`.
- [x] Keep all four `ContextMenuContent` consumers bound to that host.
- [x] Add `radix-context-menu-content` to shared root and submenu Radix content wrappers.
- [x] Override only that class to `position: relative`, preserving the base fixed positioning used by manual menus.
- [x] Add source-level regression tests asserting both the body Portal host and Popper measurement contracts.
- [x] Reuse Radix trigger `data-state="open"` for file/search-row selection highlighting, including ignored rows, without mutating active-file state.
- [x] Extend the source-level regression test to cover all four triggers and the open-state selectors.
- [x] Record both reusable Radix positioning boundaries in `.trellis/spec/frontend/quality-guidelines.md`.
- [x] Add the V1.3.9 repair note to `CHANGELOG.md` without disturbing existing entries.
- [x] Update `docs/功能清单.md` under “文件浏览器搜索与菜单”.

## Superseded first-pass validation

- [x] Portal-only source test, type-check and build passed, but user runtime verification disproved completeness: the menu still clipped at the right/bottom edge.
- [x] Failure classified as an incomplete cross-layer fix plus a test coverage gap; root cause and contracts were revised before the second edit.

## Corrected validation

- [x] `node --test scripts/fileExplorerPathActions.test.mjs` plus the full file-explorer static suite (36/36 passed).
- [x] Relevant adjacent context-menu tests (combined targeted run 22/22 passed).
- [x] `npx tsc --noEmit` (passed).
- [x] `npm run build` (passed; 6880 modules transformed).
- [x] Run GitNexus `detect_changes()` and review shared-wrapper scope (low risk; stale index mapped no symbols/processes).
- [x] Review `git diff` / `git diff --check`; only line-ending warnings, and unrelated `AGENTS.md` / `CLAUDE.md` changes remain excluded from this task.

## Manual verification handoff

- [x] Right-click near the bottom and right edge in project-sidebar mode.
- [x] Right-click near every viewport edge in merged and independent file panels, with both left and right docking.
- [x] Cover file, directory, both search result types and root blank area; include a long local menu, SSH read-only menu and HTML Live Server menu.
- [x] Confirm menus preserve terminal-panel colors in light/dark app themes.
- [x] Confirm arrow-key navigation, Enter selection, Escape/outside-click close and “复制路径为 / Copy path as” replacement.
- [x] Confirm the exact file/directory/search-result row stays highlighted while its menu is open and the prior selection returns after close.

## Rollback point

If body-host theme inheritance, Radix positioning or focus behavior regresses, revert the Portal-host and Radix-only positioning hunks together; do not change the base manual-menu fixed style or panel transform/overflow as a fallback.
