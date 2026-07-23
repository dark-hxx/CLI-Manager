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

### Pattern: Primitive persisted settings still need explicit load validation

**Problem**: New primitive settings can look too small to migrate. If `load()` spreads raw `settings.json` entries without validating type, old/manual/corrupt values such as `"true"` or `1` can silently enter React components and break boolean guards.

**Solution**: Add every persisted primitive to `Settings`, `DEFAULTS`, and the `load()` validation block. Booleans must use an explicit `typeof value === "boolean" ? value : DEFAULTS.key` fallback before the final `set()`.

```typescript
interface Settings {
  lowMemoryMode: boolean;
}

const DEFAULTS: Settings = {
  lowMemoryMode: false,
  // ...
};

entries.lowMemoryMode =
  typeof entries.lowMemoryMode === "boolean"
    ? entries.lowMemoryMode
    : DEFAULTS.lowMemoryMode;
```

**Tests Required**:

- Run `npx tsc --noEmit` after adding the setting.
- Manual smoke: toggle the setting, restart the app, and verify the value persists.

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

### Scenario: Replay snapshot patch file storage

#### 1. Scope / Trigger

- Trigger: changing AI Replay snapshot persistence, loading, rollback, fork, or startup DB cleanup behavior.
- Problem: AI Replay code snapshots can contain large unified diff text. Storing that text directly in `ai_replay_events.payload_json` makes `cli-manager.db` grow quickly and keeps routine metadata queries tied to large payload rows.

#### 2. Signatures

- SQLite table: `ai_replay_events(kind, session_key, event_index, payload_json)`.
- Snapshot DB payload fields: `checkpointId`, `patchPath`, `patchStorage`, `patchBytes`, optional legacy `patch`.
- Snapshot file path: `.cli-manager/replay-snapshots/<session>/<checkpoint>.patch`.
- Frontend store helpers: `writeSnapshotPatchFile(...)`, `hydrateSnapshotPayload(...)`, `persistReplayEvent(...)`.
- Startup backend command: `db_repair_known_migration_drift()`.

#### 3. Contracts

- Do not write snapshot patch files into the user project repository; they must stay under CLI-Manager's data directory.
- New snapshot DB payloads must persist `patchPath`, `patchStorage="file"`, and `patchBytes`, not the full `patch` text.
- Loading Replay events must hydrate `event.payload.patch` from `patchPath` before UI snapshot actions read it.
- Old rows with inline `payload.patch` must remain readable for compatibility.
- Startup DB repair must run the inline snapshot cleanup at most once per app version before `Database.load(...)`; when the current-version marker exists, it must skip the cleanup query entirely.
- If a patch file is missing, keep the snapshot metadata visible but leave diff, rollback, and fork unavailable for that event.
- For rollback/fork, compare the latest hydrated snapshot patch against the current worktree patch before mutating files.

#### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| New snapshot has non-empty patch | Write file, persist metadata only, keep in-memory event hydrated. |
| Legacy snapshot still has inline `patch` | Load directly and keep snapshot actions available. |
| Startup cleanup sees inline `patch` and no current-version marker | Write file, remove inline field, add metadata, checkpoint/VACUUM DB, then write the marker. |
| Current-version cleanup marker exists | Skip the cleanup query entirely. |
| Snapshot file missing or unreadable | Log warning, keep metadata visible, leave patch-dependent actions unavailable. |
| Malformed snapshot payload JSON during cleanup | Skip that row and continue; do not block app startup. |

#### 5. Good/Base/Bad Cases

- Good: after update, old inline snapshots are migrated once for that app version and `cli-manager.db` no longer carries large `payload.patch` fields.
- Base: already-checked installs on the same version start normally; cleanup is skipped by marker.
- Bad: writing patch files into the current project repo, because AI Replay metadata would pollute user worktrees.

### Scenario: SSH Hook events are not local Replay projects

- Trigger: `recordCliHookEvent` receives a Hook payload with `environmentType = "ssh"`.
- Remote `cwd` is an opaque display/reference value. Do not use it as `projectPath`, pass it to local Git snapshot commands, or route it through local file APIs.
- Persist the event metadata and raw remote reference for Replay visibility, but force the session's local `projectPath` to `null` and skip automatic code snapshots. Local and WSL payloads keep the existing `cwd` and snapshot behavior.
- Bad: deleting legacy inline `patch` before the patch file is written, because rollback/fork would lose the snapshot content.

#### 6. Tests Required

- Run `npx tsc --noEmit`.
- Run `cd src-tauri && cargo check`.
- Run `cd src-tauri && cargo test db_repair --lib`.
- Assert new snapshot `payload_json` has `patchPath` but no inline `patch`.
- Assert startup cleanup migrates inline snapshots to files, removes `patch`, and skips entirely when the current-version marker exists.

#### 7. Wrong vs Correct

##### Wrong

```json
{"checkpointId":"snapshot-1","patch":"diff --git ..."}
```

##### Correct

```json
{"checkpointId":"snapshot-1","patchPath":"replay-snapshots/session/snapshot-1.patch","patchStorage":"file","patchBytes":1234}
```

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

### Pattern: Workspans own pane trees; terminalStore exposes the active layout mirror

**Problem**: Multiple top-level terminal workspaces need independent pane layouts, but existing UI and actions read `terminalStore.paneTree`, `activePaneId`, and `activeSessionId` directly. Replacing those fields outright would create broad churn and make background events mutate the wrong workspace.

**Solution**: Persist a `TerminalWorkspan[]` collection where each item owns its pane tree and active state. Keep the three existing terminalStore fields as a compatibility mirror of the active Workspan. Every pane mutation must update the active Workspan and the mirror in the same Zustand `set()` call.

**Contracts**:

- Every live session belongs to exactly one Workspan; merging Workspans moves existing session IDs and never calls `pty_create`.
- `settingsStore.workspanEnabled` defaults to `true`. When disabled, keep one internal Workspan as the persistence container for the legacy global `paneTree`; do not introduce a second layout schema.
- Disabling Workspan preserves the active Workspan's complete Pane tree, appends sessions from other Workspans to the active Pane as tabs, and must not call `pty_create` or `pty_close`. Re-enabling keeps that complete tree as one Workspan; only later ordinary terminal creation starts new Workspans.
- Switching Workspans replaces the active mirror without unmounting or closing sessions in inactive Workspans.
- Every active Workspan change must scroll its top-level tab into the visible tab-strip viewport after render. This is presentation-only: keep Workspan order, tab widths, and manual horizontal scrolling unchanged.
- Keyboard and mouse side-button Tab navigation must prefer the existing active Pane resolver. If that resolver returns the current session because the active Workspan has no other navigable Pane/Tab, fall back to the adjacent Workspan's active session in top-level order; `setActive(sessionId)` then switches the Workspan mirror.
- The Workspan overflow dropdown is presentation state only. Render the dropdown trigger only when the complete tab contents exceed the full tab bar width, and list only tabs outside the current scroll viewport or partially clipped by it. Do not persist hidden-tab state or duplicate tab ordering in the store.
- Background events such as subagent transcript creation locate the parent session's Workspan and mutate that Workspan even when it is inactive; they must not steal focus.
- Closing the last session removes its Workspan and selects an adjacent Workspan. Closing a session in an inactive Workspan must keep the current Workspan active.
- Persist only Workspans containing persistable sessions. Filter transient file editor, synced history, and subagent transcript sessions before writing.
- `TerminalWorkspan.customTitle` is nullable and persists with the layout. A trimmed blank value clears it; the view then falls back to the single-session title or localized `Workspan · N` label.
- PTY restoration creates new session IDs. Restore Workspan trees through the old-to-new session ID map before selecting the active Workspan.
- Workspan edge-drop inserts the complete source pane tree beside the hovered target pane; it must preserve the full session ID set without duplicates.
- Inactive Workspans stay mounted but hidden so xterm scrollback and live output survive switching.
- With Workspan enabled, hide a local tab bar only when the visible layout has one pane with one session; split Workspan panes keep a compact tab bar with the session title, close, drag, fullscreen, and current-Tab restore controls. The Pane restore control detaches only the current Tab into a standalone top-level Workspan; the Workspan context-menu restore detaches every Tab. With Workspan disabled, every visible Pane keeps its local terminal Tab bar.
- Restoring a Workspan detaches each session into its own top-level Workspan in deterministic tree order without creating or closing PTYs. Restoring an individual Tab inserts its standalone Workspan beside the source Workspan and activates it; a single-session Workspan is not detached.
- Dragging a Pane Tab onto a top-level Workspan tab detaches only that session and inserts a standalone Workspan before the target; dragging onto the unused tab-strip area appends it. The action preserves the PTY and does nothing while a scoped terminal filter is active.
- Async PTY creation must re-resolve the source session's current Workspan and pane after every await. If the source session was closed, unsubscribe the new listener, close the abandoned PTY, and do not add an unowned session.
- Project/group/worktree scoped views may show a filtered Workspan layout, but bulk close actions must use only session IDs from that filtered tree; hidden sessions remain untouched.
- Multi-session close operations must be serialized so older persistence writes cannot overwrite the final Workspan/session snapshot.

**Tests Required**:

- Run `npx tsc --noEmit`.
- Assert Workspan merge preserves the complete session ID set with no duplicates.
- Assert legacy collapse preserves the active Pane tree, appends other Workspan sessions in deterministic order, and keeps every session ID exactly once.
- Assert sanitization keeps a session ID in only one pane even when persisted layout data contains duplicates.
- Assert adjacent Workspan navigation supports forward/backward movement and wraps at both ends without changing the existing multi-Tab or multi-Pane priority.
- Assert persisted custom titles are trimmed, blank titles migrate to `null`, and restore/sanitize operations preserve non-empty titles.
- Assert restoring a Workspan creates one standalone Workspan per session in deterministic order.
- Assert restoring one Tab detaches only that Tab into a standalone Workspan and leaves the source Workspan's remaining sessions intact.
- Assert single-Tab detachment supports adjacent, explicit-index, and end insertion without duplicate or lost session IDs; a single-session Workspan is unchanged.
- Manual desktop verification: switch Workspans, change split ratios, restart, and verify each layout restores with the correct active session.
- Manual desktop verification: with enough Workspans to overflow the tab strip, verify the dropdown trigger appears only while overflowing, the dropdown lists only hidden or partially clipped tabs, and activating the last Workspan through the dropdown, keyboard, or another navigation entry makes its tab visible without reordering tabs; mouse horizontal scrolling must still work.
- Manual desktop verification: close focused and inactive sessions, and verify Workspan selection remains correct.
- Manual desktop verification: start a split, then move/close its source Workspan before PTY creation completes; no orphan tab or stale layout may appear.
- Manual desktop verification: in a scoped view, closing a Workspan tab closes only visible sessions and preserves hidden project sessions.
- Manual desktop verification: split a Workspan until each pane has one session, then verify each pane still exposes its title, close, drag, and fullscreen/restore controls; use the Workspan context menu to restore the complete layout to the active pane without changing inactive focus.

### Pattern: Worktree records are project state; worktree sessions are terminal metadata

**Problem**: A Git worktree is a persistent checkout on disk, but an open terminal tab inside it is transient. If worktree identity lives only on `TerminalSession`, app restart loses the project-tree child item; if it lives only in the database, tab badges and finish-task menus cannot tell which checkout a running tab belongs to.

**Solution**: Store durable worktree lifecycle records in `worktreeStore` / the `worktrees` SQLite table, and store only the optional pointer on terminal sessions.

```typescript
interface WorktreeRecord {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  path: string;
  base_branch: string;
  deps_prompt_dismissed: number;
  status: "active" | "missing";
}

interface TerminalSession {
  worktreeId?: string;
}
```

**Contracts**:

- `worktreeStore.loadWorktrees()` runs during startup before the project tree needs worktree child nodes.
- `projectStore.buildTree()` may include worktree child nodes, but it must not own Git lifecycle actions.
- `TerminalSession.worktreeId` is metadata for badges, menus, stats, and install tabs; it is not the source of truth for whether a worktree exists.
- UI surfaces that operate on filesystem/history scope (file panel, realtime stats, history entry points, Git branch queries) must resolve the active worktree path when a session belongs to a worktree. Do not reuse the parent project path for these path-scoped views.
- History's visible project filter remains the parent project path for worktree history entry points; use a separate scoped/effective path for the backend history query when the list must be limited to one worktree.
- When a derived `Project` is needed for a worktree file context, keep the parent project id but replace `path` with the worktree path, and compare contexts by `id + normalized path`, not `id` alone.
- Sidebar/tree selection uses `TerminalSession.worktreeId` as the tab-to-worktree bridge: activating a worktree tab should select and reveal that worktree node; selecting a worktree node should activate an already-open PTY session for that worktree when one exists.
- Missing worktree directories remain visible as `status="missing"` until the user cleans the stale record; do not silently hide them from the project tree.
- Dependency prompt dismissal belongs to the worktree record, not the terminal tab, because multiple tabs may point at the same worktree.
- `disabled` isolation strategy preserves pre-worktree behavior: always open a normal project terminal, without Git validation, prompt, or automatic worktree creation.
- `prompt` / `autoParallel` isolation decisions are based on project CLI configuration plus an existing same-project PTY session, not visible tab `running` state, startup commands, or shell process liveness. Projects without a configured CLI tool must not trigger these two strategies for ordinary terminal usage.
- `always` still creates a worktree for every project launch, but only after Git validation confirms a local project that supports `git worktree`; non-Git and unsupported WSL paths open normally.

**Good/Base/Bad Cases**:

- Good: after app restart, no terminal sessions are restored, but the project tree still shows active/missing worktree records loaded from SQLite.
- Good: switching from worktree tab A to worktree tab B updates the selected project-tree child from A to B without opening new terminals.
- Base: an install-dependencies tab and the task tab share the same `worktreeId`, so both display the same worktree badge.
- Bad: closing the last tab for a worktree deletes the database record. Closing a tab is not equivalent to discarding a checkout.
- Bad: selecting a worktree row always opens another terminal even when a matching worktree tab is already open.

**Tests Required**:

- Type-check that `TreeNode` handles `worktree` nodes everywhere a project tree is rendered.
- Manual verification: restart app after creating a worktree; the worktree child row remains even though terminals are not restored.
- Manual verification: dismissing dependency prompt for one worktree does not affect a different worktree of the same project.

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
- The filtered tree controls presentation geometry only. Render every original Workspan/Pane leaf under its stable parent and key so scoped switches update `isVisible` without disposing or recreating `XTermTerminal`.
- Filtering must use resolved ownership for derived sessions such as subagent transcript tabs, not only `session.projectId`.
- Pane/tab bulk actions in scoped mode must operate on the filtered leaves, so hidden tabs from other projects are untouched.
- Disabling scoped mode must immediately restore the original all-project layout without rebuilding pane state.

**Good/Base/Bad Cases**:

- Good: project A scope shows only A tabs, and `close others` leaves hidden project B tabs intact in the store.
- Base: selecting "All Terminals" bypasses filtering and renders the original pane tree.
- Bad: removing non-matching sessions from `terminalStore.sessions` or rewriting `paneTree` during filtering.
- Bad: moving hidden PTY sessions into a separate offscreen render branch with a different parent or key; this serializes and replays full scrollback on every scope switch.

**Tests Required**:

- Type-check that scoped rendering paths consume `visiblePaneTree` / `visibleSessions` instead of raw `paneTree` / `sessions`.
- Regression-test that filtering collapses the visible tree without mutating the original mounted tree or its leaf identities.
- Manual desktop verification: scoped mode on/off restores the same tab layout; project empty state appears when the chosen project has no open terminals; hidden-project tabs survive scoped close operations.
- Manual desktop verification: repeatedly switch projects with long terminal scrollback and confirm the terminal does not progressively replay, flash black, or require a window resize to repaint.

---

### Pattern: Narrow selectors for always-mounted UI

**Problem**: Zustand store actions such as terminal output/status updates and sub-agent transcript appends can fire at high frequency. A component mounted in a persistent toolbar/sidebar that calls a whole-store hook (for example `useTerminalStore()` without a selector) rerenders on every unrelated store change, even when none of the fields it displays changed.

**Solution**: Always-mounted components must subscribe only to the fields they render or invoke. Use `useShallow` when selecting multiple fields, and keep popover/settings screens as the exception only when they are mounted on demand and not on a hot path.

```typescript
// Good: only rerenders when these fields change.
const { sessions, activeSessionId } = useTerminalStore(
  useShallow((s) => ({
    sessions: s.sessions,
    activeSessionId: s.activeSessionId,
  }))
);

// Bad: rerenders on every terminalStore mutation, including transcript appends.
const { sessions, activeSessionId } = useTerminalStore();
```

**Why**: This prevents background transcript/event traffic from stealing the main thread and making terminal typing or tab switching lag.

**Tests Required**:

- Type-check after selector changes.
- Manual profiling for toolbar/sidebar components during high-frequency terminal or transcript updates; unrelated components should not rerender each tick.

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
