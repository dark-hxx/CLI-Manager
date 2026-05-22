# Directory Structure

> How frontend code is organized in this project.

---

## Overview

The frontend is organized by technical layer first, then by feature clusters inside `src/components/`.
There is no route-driven `pages/` tree and no feature package per domain. Instead, the app keeps a small top-level shell and groups larger UI areas into subdirectories when they grow enough to deserve one.

Core rules from the current codebase:

- App shell and global styling live at the top of `src/`
- Reusable UI panels live in `src/components/`
- Larger UI families get their own subfolders inside `src/components/`
- Shared state lives in `src/stores/`, one store file per domain
- Shared business types and utilities live in `src/lib/`
- Custom hooks are rare and live in `src/hooks/`

---

## Directory Layout

```text
src/
├── App.tsx
├── App.css
├── main.tsx
├── components/
│   ├── CommandPalette.tsx
│   ├── HistoryWorkspace.tsx
│   ├── TerminalTabs.tsx
│   ├── WindowTitleBar.tsx
│   ├── history/
│   ├── prompts/
│   ├── settings/
│   ├── sidebar/
│   ├── stats/
│   └── ui/
├── hooks/
│   ├── useFocusTrap.ts
│   └── useKeyboardShortcuts.ts
├── lib/
│   ├── db.ts
│   ├── logger.ts
│   ├── types.ts
│   └── ...
└── stores/
    ├── historyStore.ts
    ├── projectStore.ts
    ├── settingsStore.ts
    ├── terminalStore.ts
    └── ...
```

---

## Module Organization

### 1. App shell stays shallow

Use top-level `src/` for application entry and cross-cutting setup:

- `src/App.tsx` composes `Sidebar`, `TerminalTabs`, `CommandPalette`, `StatsPanel`, and `WindowTitleBar`
- `src/App.css` owns theme tokens, semantic surfaces, and shared interaction classes
- `src/main.tsx` mounts the React app

Do not create a new root-level feature folder unless it is truly cross-cutting.

### 2. Put UI under `src/components/`

Top-level files in `src/components/` are used for shared shells or panels that span multiple areas:

- `src/components/HistoryWorkspace.tsx`
- `src/components/TerminalTabs.tsx`
- `src/components/ConfigModal.tsx`
- `src/components/CommandTemplatePanel.tsx`

When a UI area grows into multiple related files, move that family into a subdirectory.

### 3. Use feature subdirectories when a UI family has multiple parts

Current feature folders are practical, not theoretical:

- `src/components/sidebar/` for tree, header, search, footer, and context wiring
- `src/components/history/` for history list/detail panes, diff, search hits, meta editor
- `src/components/settings/` for settings shell, nav, and page-level sections
- `src/components/stats/` for charts and stats modal pieces
- `src/components/prompts/` for prompt library UI
- `src/components/ui/` for lightweight shared primitives

### 4. Keep hooks, stores, and lib separate from components

- `src/hooks/` is for reusable React behavior wrappers such as keyboard listeners and focus trapping
- `src/stores/` is for app-wide state and async actions
- `src/lib/` is for shared types, database access, logging, theme helpers, shell helpers, and similar non-visual code

Do not hide global store logic inside component folders.

---

## Naming Conventions

### Files

- React components use `PascalCase.tsx`
  - Examples: `TerminalTabs.tsx`, `HistoryListPane.tsx`, `SyncSettingsPage.tsx`
- Hooks use `useCamelCase.ts`
  - Examples: `useKeyboardShortcuts.ts`, `useFocusTrap.ts`
- Stores use `camelCaseStore.ts`
  - Examples: `historyStore.ts`, `settingsStore.ts`, `projectStore.ts`
- Shared utility/type files use `camelCase.ts`
  - Examples: `logger.ts`, `externalTerminal.ts`, `types.ts`
- Folder entry files may use `index.tsx`
  - Example: `src/components/sidebar/index.tsx`

### Folders

- Use lowercase folder names
- Use feature names, not abstract layers
  - `sidebar`, `history`, `settings`, `stats`, `prompts`, `ui`

### Types

- Shared business entities belong in `src/lib/types.ts`
- Component props and local helper interfaces stay close to the component that uses them
- Store state/action interfaces stay in the store file

---

## Examples

### Example: Shell + feature cluster split

- `src/App.tsx` keeps app startup and shell composition at the top level
- `src/components/sidebar/index.tsx` delegates sidebar internals to `SidebarHeader`, `SidebarSearch`, `ProjectTree`, and `SidebarFooter`

### Example: Settings area grouped by page

- `src/components/settings/SettingsTopBar.tsx`
- `src/components/settings/pages/GeneralSettingsPage.tsx`
- `src/components/settings/pages/SyncSettingsPage.tsx`

### Example: History area grouped by workflow pieces

- `src/components/HistoryWorkspace.tsx`
- `src/components/history/HistoryListPane.tsx`
- `src/components/history/SessionDetailPane.tsx`

### Example: Shared primitives separated from feature UI

- `src/components/ui/input.tsx`
- `src/components/ui/select.tsx`
- `src/components/ui/button.tsx`

---

## Anti-Patterns

- Do not introduce a new `pages/` or route-style folder tree for one modal or one panel.
- Do not put Zustand stores inside `src/components/` just because one feature currently uses them.
- Do not duplicate shared types across component files when `src/lib/types.ts` already defines the business entity.
- Do not create a new `utils/` or `shared/` subtree for every small helper; check `src/lib/` and the local feature folder first.
- Do not move one-off presentational helpers into `src/components/ui/` unless they are truly reusable across multiple areas.
