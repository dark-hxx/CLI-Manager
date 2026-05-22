# State Management

> How state is managed in this project.

---

## Overview

Frontend state is managed with Zustand plus ordinary component state.
There is no Redux, React Query, SWR, or router-driven state layer.

Current architecture:

- App-wide state lives in domain stores under `src/stores/`
- One store file usually owns one domain
- Store actions perform async work directly through Tauri `invoke(...)`, plugin storage, or the local database
- Components use `useEffect` to trigger loading and `useMemo` to derive view-specific slices
- Local transient UI state stays inside the component that owns the interaction

Representative files:

- `src/stores/settingsStore.ts`
- `src/stores/projectStore.ts`
- `src/stores/historyStore.ts`
- `src/components/HistoryWorkspace.tsx`

---

## State Categories

### Local component state

Use component state for temporary UI concerns such as:

- modal open/close flags
- input drafts
- pagination cursors
- resize/drag transient state
- temporary match indexes and local filters derived for one screen

Examples:

- `HistoryWorkspace.tsx` stores `aliasDraft`, `tagsDraft`, `matchCursor`, `promptOpen`, `diffOpen`, and visible counts locally
- `sidebar/index.tsx` stores sidebar width preview, context menu state, selection UI state, and modal state locally
- `SyncSettingsPage.tsx` stores form drafts and reveal-password UI locally

### Global app state

Use Zustand when state is shared across areas, persisted, or represents a domain model:

- settings in `settingsStore.ts`
- projects/groups/tree in `projectStore.ts`
- terminals and sessions in `terminalStore.ts` / `sessionStore.ts`
- history sessions/search/stats/meta in `historyStore.ts`
- templates, command history, sync, and updates in their own stores

### Async backend/database state

This desktop app treats Tauri commands, plugin store data, and SQLite reads as async app data.
That work is usually owned by store actions rather than by a separate server-state library.

Examples:

- `settingsStore.ts` loads persisted settings from `@tauri-apps/plugin-store`
- `projectStore.ts` reads SQLite data through `getDb()` and runs `check_paths_exist` through `invoke(...)`
- `historyStore.ts` calls `history_list_sessions`, `history_get_session`, `history_search`, and `history_get_stats`

### URL state

There is effectively no URL state layer in the current frontend. This is a desktop app shell, not a route-centric web app.

---

## When to Use Global State

Promote state into a Zustand store when at least one of these is true:

| Use global state when... | Current examples |
|---|---|
| Multiple distant components need the same source of truth | history visibility/search state, terminal sessions, settings |
| The value must survive app reloads or app restarts | settings in `settingsStore.ts`, session persistence in `sessionStore.ts` |
| The state owns async commands, DB access, or normalization | `historyStore.ts`, `projectStore.ts` |
| The state represents a domain model, not a one-off widget | projects, groups, templates, sync config |

Keep state local when it only matters to one screen or one interaction.

Examples that should stay local:

- currently open context menu in `sidebar/index.tsx`
- visible message/page counts in `HistoryWorkspace.tsx`
- password visibility toggle in `SyncSettingsPage.tsx`

---

## Server State

There is no dedicated server-state cache library.
Instead, async state is handled with store-owned actions and a small amount of manual caching where needed.

### Current patterns

- Components trigger loads from `useEffect`
- Stores own loading flags, error state, and normalized payloads
- Some stores add tiny in-memory cache helpers only when needed

### Examples

- `src/stores/historyStore.ts`
  - owns `loadingSessions`, `loadingSessionDetail`, `searching`, `loadingStats`, `statsError`
  - normalizes raw `invoke(...)` payloads before writing them to store state
  - caches stats with `statsCache` and `STATS_CACHE_TTL_MS`
- `src/stores/projectStore.ts`
  - fetches groups/projects together and rebuilds `tree`
- `src/App.tsx`
  - triggers initial loads in sequence during app startup

### Derived state

Prefer deriving view data instead of storing duplicate copies when possible.

Current examples:

- `projectStore.ts` derives `tree` from `groups`, `projects`, and `searchQuery` via `buildTree(...)`
- `HistoryWorkspace.tsx` derives `filteredSessions`, grouped sessions, match indices, and visible slices with `useMemo`
- `settingsStore.ts` derives `resolvedTheme` from `theme`

---

## Common Mistakes

### Common Mistake: Putting one-screen draft state into Zustand too early

**Problem**: The store becomes noisy with modal flags, draft text, and interaction cursors that no other component needs.

**Better pattern**: Keep those values local, like `HistoryWorkspace.tsx` and `SyncSettingsPage.tsx` do.

### Common Mistake: Fetching the same backend data directly from multiple components

**Problem**: Loading flags, normalization, and error handling drift apart.

**Better pattern**: Put async work in one store action, then reuse that action from components.

### Common Mistake: Storing data that can be derived cheaply

**Problem**: Duplicate state gets out of sync.

**Better pattern**: Use `useMemo` or store-side helpers for derived values such as filtered/grouped lists or theme resolution.

### Common Mistake: Introducing web-style server-state tools by default

This repository does not currently use React Query or SWR. Do not add a parallel async state system for routine frontend work unless the project direction explicitly changes.

### Common Mistake: Letting presentational children mutate global state implicitly

Prefer explicit callback props and store actions over hidden state mutation buried inside deep child components.
