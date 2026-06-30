# State Management

> How state is managed in this project.

---

## Overview

This project uses **Zustand** for global stores and `tauri-plugin-store` for persistent settings (`settings.json`). Local component state via `useState` is preferred for ephemeral UI.

Real state files live under `src/stores/`:

- `settingsStore.ts` — user preferences (theme, font, terminal background, shortcuts), persisted
- `terminalStore.ts` — PTY sessions, active session, splits, in-memory session overrides
- `projectStore.ts`, `historyStore.ts`, `syncStore.ts`, `templateStore.ts`, `commandHistoryStore.ts`, `sessionStore.ts`, `updateStore.ts`

(Filling status: spec captures only patterns we have hit in practice. Other sections remain "To be filled by the team".)

---

## State Categories

(To be filled by the team)

---

## When to Use Global State

(To be filled by the team)

---

## Server State

### Convention: Use TanStack Query for historical stats dashboard server state

**What**: Historical usage analytics data fetched through Tauri commands should be loaded with TanStack Query in the dashboard component layer. Keep payload normalization and reusable fetch functions in `historyStore.ts`, but do not drive new dashboard loading states through ad-hoc `useEffect` request sequencing.

**Why**: Historical stats are server state: they are keyed by source, project, time range, and custom history paths, and they need cache freshness, background fetching, error state, and manual refresh. TanStack Query owns those concerns more directly than duplicating cache maps and request sequence guards in each component.

**Correct**:

```tsx
const statsQuery = useQuery({
  queryKey: ["historyStats", sourceFilter, projectKey, startAt, endAt],
  queryFn: () => fetchHistoryStatsPayload({ sourceFilter, projectKey, startAt, endAt }),
  enabled: open && startAt !== null && endAt !== null,
});
```

**Wrong**:

```tsx
useEffect(() => {
  let cancelled = false;
  setLoading(true);
  void loadStats(params).finally(() => {
    if (!cancelled) setLoading(false);
  });
  return () => {
    cancelled = true;
  };
}, [params]);
```

**Contracts**:

- Wrap the app once with `QueryClientProvider` from `src/main.tsx`; do not create per-panel clients.
- Query keys must include every field that changes the backend response: source filter, project key, start/end timestamps, and explicit manual-refresh nonce when forcing a backend refresh.
- Keep realtime terminal stats on the existing live session/store path unless a separate migration explicitly changes that contract.
- Keep backend command names and response payload normalization stable; React Query is a frontend cache/fetching mechanism, not a payload schema change.

**Tests**: Run `npx tsc --noEmit` and `npm run build`. Manually verify historical stats filter changes, manual refresh, empty/error states, and bucket session drilldown in the desktop app.

---

## Patterns

### Pattern: `migrate*` pure function for every persisted compound field

**Problem**: `tauri-plugin-store` writes whatever JSON shape you give it. Old installs have stale shapes when you add/rename fields. If `load()` trusts the disk blindly, the app crashes on rename or silently uses partial data after type evolution.

**Solution**: For every persisted compound field (object / enum union / list), define a **pure** `migrate*(value: unknown) -> T` that:

1. Returns the typed default if value is null/undefined/wrong-shape
2. For each sub-field: type-checks, range-clamps, or enum-validates; falls back to default per field
3. Is **pure** (no I/O, no store access) so it can be unit-tested in isolation

Then call it from `load()`.

**Example** (from `settingsStore.ts`):

```ts
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function migrateTerminalBackground(value: unknown): TerminalBackgroundSettings {
  if (!value || typeof value !== "object") return { ...DEFAULTS.terminalBackground };
  const v = value as Record<string, unknown>;

  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULTS.terminalBackground.enabled,
    imagePath: typeof v.imagePath === "string" || v.imagePath === null
      ? (v.imagePath as string | null)
      : DEFAULTS.terminalBackground.imagePath,
    imageSizeBytes:
      typeof v.imageSizeBytes === "number" && Number.isFinite(v.imageSizeBytes) && v.imageSizeBytes >= 0
        ? v.imageSizeBytes
        : null,
    opacity: clampNumber(v.opacity, 0, 100, DEFAULTS.terminalBackground.opacity),
    fit: (["cover","contain","center","tile"] as const).includes(v.fit as TerminalBackgroundFit)
      ? (v.fit as TerminalBackgroundFit)
      : DEFAULTS.terminalBackground.fit,
    // ...same for position, blur, overlayDarken
  };
}
```

**Tests** (when vitest is wired):

- `migrateX(undefined) === DEFAULTS.x`
- `migrateX(null) === DEFAULTS.x`
- `migrateX({})` returns defaults
- Each numeric field: out-of-range value gets clamped
- Each enum field: unknown literal gets default
- Each compound: type-mismatched sub-field falls back per-field (others survive)

### Pattern: Legacy key remapping next to the migration

When a field name or enum value changes between releases, keep a `LEGACY_*_MAP` next to its migrator and translate before validating.

**Example** (from `settingsStore.ts`):

```ts
const LEGACY_TERMINAL_THEME_MAP: Partial<Record<string, string>> = {
  luxuryCommerceLight: "saasAnalyticsDashboardLight",
  cryptoWalletDark: "investmentPlatformDark",
};

function migrateTerminalThemeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return LEGACY_TERMINAL_THEME_MAP[value] ?? value;
}
```

After migration, the store writes the new key back to disk:

```ts
if (storedX !== migratedX) await s.set("x", migratedX);
```

This keeps `settings.json` self-healing: one launch is enough to leave the legacy shape behind.

### Pattern: Transient flags live in the store but stay out of `Settings`

Some state belongs to the store object but **must not be persisted** — e.g. `terminalBackgroundMissing` (computed at load by file-existence check). Keep these fields on the Zustand store but exclude them from the `Settings` interface and from the `DEFAULTS` loop that writes to `tauri-plugin-store`.

**Anti-pattern**: putting `terminalBackgroundMissing` into the `Settings` interface — `load()` will read a stale boolean from disk and skip the actual file check.

**Pattern**:

```ts
interface Settings {
  // …persisted fields only
  terminalBackground: TerminalBackgroundSettings;
}

interface SettingsStore extends Settings {
  // …transient runtime flags
  terminalBackgroundMissing: boolean;
  clearTerminalBackgroundMissing: () => void;
}
```

`load()` recomputes the flag every launch; it is never written to `settings.json`.

### Pattern: Pane tree drag-split moves existing sessions only

**Problem**: A terminal tab represents a live PTY session. Dragging it to a pane edge must not create a new PTY or duplicate the terminal, otherwise the UI would show two tabs for different processes while the user expected a layout move.

**Solution**: Keep pane layout as a pure tree transform. The store action should accept the existing `sessionId`, `targetPaneId`, and edge, then move that session id into a new leaf created around the target pane.

```typescript
type TerminalPaneDropEdge = "left" | "right" | "top" | "bottom";

splitSessionToPaneEdge(sessionId: string, targetPaneId: string, edge: TerminalPaneDropEdge): void;
```

**Contracts**:

- Same pane + one tab: no-op; do not create an empty split.
- Same pane + multiple tabs: remove `sessionId` from the original leaf, create a new leaf on the requested edge, and keep the remaining tabs in the original leaf.
- Cross pane: remove `sessionId` from its source leaf, split the target leaf, and normalize any empty source leaf.
- Never call `pty_create`; this is a layout/session move, not terminal creation.

**Good/Base/Bad Cases**:

- Good: dragging tab A to the right edge of pane B creates a horizontal split where A is in the new right leaf.
- Base: dragging tab A to the center of pane B moves A into pane B without changing split structure.
- Bad: dragging the only tab in pane A to pane A's own edge creates an empty pane; this must stay a no-op.

**Tests Required**:

- Assert no duplicate `sessionId` exists after every move.
- Assert total session id set is unchanged after edge split.
- Assert same-pane single-tab edge split returns `changed: false`.
- Assert `activePaneId` and `activeSessionId` point to the moved tab when a split succeeds.

### Pattern: Project-scoped terminal filtering derives a visible pane tree

**Problem**: A project-only terminal view is a presentation concern. If the UI mutates the real `sessions` array or `paneTree` to hide other projects, background sessions disappear from state, pane operations close the wrong tabs, and leaving scoped mode cannot reconstruct the original layout.

**Solution**: Keep the store state authoritative and derive a filtered pane tree in the view layer. Filter by resolved project ownership per session, then pass the filtered leaves into tab rendering and pane-level close actions.

```typescript
const scopedSessionIds = new Set(
  sessions
    .filter((session) => resolveProjectForSession(session, sessions, projects, projectById)?.id === projectScopeProjectId)
    .map((session) => session.id)
);

const visiblePaneTree = filterPaneTreeBySessionIds(paneTree, scopedSessionIds);
const visiblePanes = collectPaneLeaves(visiblePaneTree);
```

**Contracts**:

- `sessions` and the persisted `paneTree` remain unchanged when toggling project scope.
- Filtering must use resolved ownership for derived sessions such as subagent transcript tabs, not only `session.projectId`.
- Pane/tab bulk actions in scoped mode must operate on the filtered leaves, so hidden tabs from other projects are untouched.
- Disabling scoped mode must immediately restore the original all-project layout without rebuilding pane state.

**Good/Base/Bad Cases**:

- Good: project A scope shows only A tabs, and `close others` leaves hidden project B tabs intact in the store.
- Base: selecting "All Terminals" bypasses filtering and renders the original pane tree.
- Bad: removing non-matching sessions from `terminalStore.sessions` or rewriting `paneTree` during filtering.

**Tests Required**:

- Type-check that scoped rendering paths consume `visiblePaneTree` / `visibleSessions` instead of raw `paneTree` / `sessions`.
- Manual desktop verification: scoped mode on/off restores the same tab layout; project empty state appears when the chosen project has no open terminals; hidden-project tabs survive scoped close operations.

---

## Common Mistakes

### Common Mistake: Replacing a refreshed tree branch and dropping loaded descendants

**Symptom**: A file tree folder is still marked expanded, but after moving/copying items the row collapses visually, the tree height changes, and the scroll container may jump toward the top.

**Cause**: Backend directory listing commands usually return only one level of children. Replacing a parent directory with that shallow result drops already loaded `children` on expanded descendants.

**Fix**: When refreshing one or more affected directories, preserve existing loaded descendant `children` for unchanged paths, then apply the explicitly refreshed directories from ancestor to descendant.

```typescript
const refreshPaths = Array.from(new Set([targetParentPath, sourceParentPath]))
  .sort((a, b) => pathDepth(a) - pathDepth(b));

set((state) => ({
  tree: refreshedDirs.reduce(
    (tree, dir) => replaceChildrenKeepingLoadedSubtrees(tree, dir.path, dir.children),
    state.tree
  ),
}));
```

**Prevention**: For file-tree move/copy/rename/delete flows, check whether the refreshed path can be root or an ancestor of an expanded folder. If yes, avoid intermediate `set()` calls that temporarily drop descendant children.
