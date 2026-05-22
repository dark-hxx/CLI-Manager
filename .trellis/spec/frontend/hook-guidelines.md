# Hook Guidelines

> How hooks are used in this project.

---

## Overview

Custom hooks are intentionally rare in this frontend.
The existing hooks wrap reusable UI behavior and side effects, not server-state frameworks or domain data loading.

Current reality:

- Hooks live in `src/hooks/`
- The app currently has only a small number of custom hooks
- Data fetching is usually triggered from components and executed through Zustand store actions
- Shared behavioral logic is extracted only when at least one full effect/listener sequence needs reuse

Examples of the current pattern:

- `src/hooks/useKeyboardShortcuts.ts`
- `src/hooks/useFocusTrap.ts`

---

## Custom Hook Patterns

### 1. Use hooks for reusable React behavior

Good hook candidates in this codebase are behaviors such as:

- global event listeners
- focus management
- keyboard handling
- lifecycle wiring that is reused across more than one component or is too noisy inline

`useKeyboardShortcuts` is the clearest example: it registers a global keydown listener, reads current store state, blocks shortcuts during text entry, and cleans up on unmount.

`useFocusTrap` is another clear example: it receives a container ref plus an `active` flag and manages focus loop behavior for modal-like UI.

### 2. Keep hooks thin and side-effect oriented

The current hooks do not become alternate state containers.
They usually:

- accept refs, flags, or simple configuration
- run one `useEffect`
- register listeners or manipulate focus
- clean up correctly

### 3. Prefer components + stores over data hooks

If the logic is really “load data from backend/DB and update app state”, it usually belongs in a store action plus a component `useEffect`, not in a new `useSomethingQuery` hook.

---

## Data Fetching

This project does not use React Query or SWR.
Async data loading follows this shape instead:

1. A Zustand store exposes async actions such as `load`, `fetchAll`, `loadSessions`, `loadStats`, `testConnection`
2. A component triggers the action from `useEffect` or an event handler
3. The store talks to Tauri `invoke(...)`, plugin storage, or the local DB directly
4. The component subscribes to store state and renders loading/error UI

### Examples

- `src/App.tsx`
  - boot sequence loads settings, sync config, persisted sessions, project list, and terminal restoration inside an effect
- `src/components/HistoryWorkspace.tsx`
  - calls `loadSessions()` on mount and uses more effects for debounced search and focus work
- `src/components/settings/pages/SyncSettingsPage.tsx`
  - calls `load()` when the sync store is not ready yet
- `src/stores/historyStore.ts`
  - owns the actual async work, normalization, and lightweight stats caching

### Guidance

- Put async domain logic in the relevant store
- Use component effects only to trigger or coordinate that logic
- Do not introduce a fetch hook unless there is a repeated UI behavior that genuinely cannot stay in the store

---

## Naming Conventions

- Custom hooks must start with `use`
- Use a behavior-based name, not a vague abstraction name
  - good: `useKeyboardShortcuts`, `useFocusTrap`
  - bad: `useHelpers`, `useCommonLogic`, `useManager`
- Keep one dominant responsibility per hook
- Prefer `.ts` for hooks unless JSX is unavoidable

---

## Examples

### Example: Global behavior hook

`src/hooks/useKeyboardShortcuts.ts`

- reads Zustand slices with selectors
- registers one global keydown listener in `useEffect`
- normalizes keys with `eventToCombo`
- skips shortcuts while focus is inside form fields or xterm
- performs cleanup on unmount

### Example: Focus management hook

`src/hooks/useFocusTrap.ts`

- accepts `containerRef` and `active`
- discovers focusable elements inside the container
- moves focus on activation
- loops Tab/Shift+Tab correctly
- removes the listener during cleanup

### Example: Data load stays out of hooks

`src/components/settings/pages/SyncSettingsPage.tsx`

- uses component `useEffect` to trigger `load()` from `useSyncStore`
- keeps local form draft state in the component
- does not create a custom `useSyncSettings` wrapper for one page

---

## Common Mistakes

### Common Mistake: Creating a hook just to move one component's local state elsewhere

**Problem**: The logic becomes harder to read because the hook hides simple state that is only used once.

**Preferred pattern**: Keep one-page draft state local, as seen in `SyncSettingsPage.tsx` and `HistoryWorkspace.tsx`.

### Common Mistake: Putting async domain fetching into ad hoc hooks

**Problem**: Fetch behavior drifts away from the store that owns the state, normalization, and persistence.

**Preferred pattern**: Put async logic in a domain store such as `historyStore.ts`, `projectStore.ts`, or `settingsStore.ts`, then trigger it from the component.

### Common Mistake: Forgetting cleanup for listeners or focus management

**Problem**: Keyboard handlers and document listeners leak across unmounts.

**Examples to copy**:
- `useKeyboardShortcuts.ts` removes the keydown listener in cleanup
- `useFocusTrap.ts` removes the document keydown listener in cleanup

### Common Mistake: Calling hooks conditionally

This repository follows standard React hook rules. Do not call hooks from conditionals, loops, nested functions, or event handlers.
