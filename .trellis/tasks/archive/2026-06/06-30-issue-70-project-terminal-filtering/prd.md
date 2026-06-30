# Issue 70: Sidebar Project Search And Terminal Filtering

## Goal

Optimize the left project list so users can quickly find projects and optionally make the terminal workspace focus on the selected project instead of always showing every open terminal.

## What I Already Know

* User initially requested project search/filter, current terminal count display, and project-click-based terminal area filtering.
* Search should support typing English directly when focus is inside the left project list, plus a shortcut similar to JetBrains menu search.
* Terminal count display is explicitly deferred and should not be implemented in this issue.
* Project-click filtering should be controlled by a terminal setting switch. The user described this as an "accordion" mode.
* Current sidebar click behavior: single-click selects a project and activates the first existing session for that project when present; double-click or the play action starts a new terminal.
* Current terminal workspace renders the full `paneTree` from `terminalStore`; sessions carry `projectId`, and pseudo sessions can be `subagent-transcript` or `file-editor`.
* Settings are persisted in `settings.json` through `useSettingsStore.update(...)`.
* New or changed user-visible frontend text must be added for both `zh-CN` and `en-US` in `src/lib/i18n.ts`.

## Requirements

* Add a transient project-list search input state that filters projects by English keyword while keeping matching groups and ancestors visible.
* Do not show a permanent search box in the left project list. The search box appears only after shortcut activation or direct typing while the project tree has focus, and can be dismissed by clearing it or pressing Escape.
* When the sidebar project tree has focus and the user types printable English characters, open/focus the transient search and seed the query with the typed character.
* Add a keyboard shortcut to focus project search. Recommended default: `Ctrl+F` only when focus is inside the sidebar/project tree, to avoid stealing global browser/app search semantics outside the sidebar.
* Add a persisted terminal setting switch for project-scoped terminal view. Recommended label: "按项目聚焦终端" / "Focus terminals by selected project".
* Project-scoped terminal view is disabled by default to preserve the existing global terminal workspace behavior for existing users.
* When the switch is enabled and the user selects a project, the terminal area should show only terminal sessions for that project.
* Sidebar focus must only affect project search input. Losing focus from the sidebar must not change which terminal tabs are shown.
* Project-scoped terminal view needs an explicit "All terminals" scope so users can return to the full terminal workspace without disabling the setting.
* The "All terminals" scope appears as a lightweight virtual item at the top of the left project list only when project-scoped terminal view is enabled. It must not be shown when the setting is disabled.
* Do not add a permanent terminal-tab header scope chip/button for the MVP; it was rejected as visually too noisy.
* Subagent transcript panes belong to their parent terminal's project. When project-scoped terminal view is enabled, selecting project A shows A terminals plus A-derived subagent transcript panes; B terminals and B-derived subagent panes remain alive but hidden until B is selected.
* Background activity from another project must not auto-switch the selected project or steal focus from the current filtered view.
* When no project is selected or the selected project has no open terminal, the terminal area should show an empty state for that project, with an action to start a terminal for the selected project.
* Existing global terminal behavior remains the default when the switch is disabled.
* Existing launch behavior remains unchanged: double-click/play/context-menu still starts terminals; single-click selects/focuses.

## Acceptance Criteria

* [ ] Project tree can be filtered by typing while the tree has focus, and the transient search box appears only during active search.
* [ ] Shortcut opens/focuses project search from the sidebar/project tree.
* [ ] Clearing search or pressing Escape hides search and restores the full tree and existing collapsed-group behavior.
* [ ] Matching search keeps ancestor groups visible so users can see where a project lives.
* [ ] With project-scoped terminal view disabled, terminal area still shows all open terminals.
* [ ] With project-scoped terminal view enabled, selecting a project filters the terminal area to that project's open terminals.
* [ ] With project-scoped terminal view enabled, users can switch back to "All terminals" and see the full workspace.
* [ ] The "All terminals" virtual item is visible only when project-scoped terminal view is enabled.
* [ ] Terminal scope remains stable when focus leaves the sidebar/project tree.
* [ ] Subagent transcript panes follow their parent terminal's project in filtered mode.
* [ ] Background subagent activity in a hidden project does not steal focus or switch the selected project.
* [ ] Empty selected project state offers a direct way to start that project's terminal.
* [ ] New labels, placeholders, aria labels, and empty states work in `zh-CN` and `en-US`.
* [ ] `npm run build` or at least `npx tsc --noEmit` passes.

## Technical Approach

* Keep this as frontend-only state and rendering work. Do not add backend commands or dependencies.
* Add selected-project terminal scope state near sidebar/terminal shared UI, likely via `terminalStore` or a small prop path from `Sidebar` to `TerminalTabs` depending on `App` composition.
* Add a new settings key in `settingsStore` with migration/default handling, following existing boolean switch patterns such as `terminalTabHoverInfoEnabled`.
* Filter the terminal view by deriving a project-scoped pane tree from the existing `paneTree` for rendering only. Avoid destroying or mutating underlying sessions when filtering.
* Prefer a helper in `terminalPaneTree.ts` if filtering a pane tree becomes non-trivial; keep it pure and tested if feasible.
* Search filtering belongs in `ProjectTree`/sidebar tree rendering; avoid changing project persistence or sort order.

## Decision (ADR-lite)

**Context**: The current app has two separate concepts: project selection in the sidebar and terminal sessions in a global split/pane workspace. Forcing every click to restructure sessions would be risky and surprising.

**Decision**: Implement project terminal filtering as a persisted opt-in view mode. The source `sessions` and `paneTree` remain global; rendering derives a filtered view when enabled.

**Consequences**: This preserves existing behavior by default and lowers risk. The main complexity is ensuring active session, side panels, drag/drop, and empty states behave sanely when the filtered render tree hides some global sessions.

**Default**: Off.

## Out Of Scope

* Fuzzy search, pinyin search, or Chinese tokenization.
* Per-project terminal count display.
* Backend changes or database schema changes.
* Changing project launch semantics.
* Automatically closing, moving, or re-parenting terminals when selecting a project.
* Redesigning split terminal persistence.

## Implementation Plan

* Step 1: Add transient project search UI/state and keyboard focus behavior in the sidebar tree.
* Step 2: Add persisted setting for project-scoped terminal focus mode, with i18n.
* Step 3: Add terminal workspace render filtering and selected-project empty state.
* Step 3a: Add an explicit all-project terminal scope interaction so filtered mode is reversible without changing settings.
* Step 5: Verify TypeScript build and manually test normal/global mode, filtered mode, no-terminal selected project, multiple projects with open terminals, and collapsed sidebar.

## Technical Notes

* Relevant files inspected:
  * `src/components/sidebar/index.tsx`
  * `src/components/sidebar/ProjectTree.tsx`
  * `src/components/sidebar/TreeNodeItem.tsx`
  * `src/components/TerminalTabs.tsx`
  * `src/components/SplitTerminalView.tsx`
  * `src/stores/terminalStore.ts`
  * `src/stores/settingsStore.ts`
  * `src/lib/types.ts`
  * `src/lib/i18n.ts`
* Existing project row single-click already selects and activates the first project session if present.
* Existing terminal session type has optional `projectId`; this is the right primary key for project terminal counting/filtering.
* Pseudo sessions need special handling so file editor panels and subagent transcript panels follow the right project in filtered mode.
* Confirmed decision: filtered view is non-destructive. It hides non-selected project sessions in the rendered view only; it does not mutate `sessions` or the real `paneTree`.
