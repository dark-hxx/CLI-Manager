# Research: cc-pane terminal pane reference

- **Query**: Research the Rust project at https://github.com/wuxiran/cc-pane as a reference for CLI-Manager's JetBrains-style terminal split feature. Include: (1) what cc-pane implements, (2) its pane/tree/layout model if visible, (3) relevant UX conventions, (4) what is applicable to this React/Zustand app, (5) what to avoid copying.
- **Scope**: external code search via GitHub raw/API
- **Date**: 2026-06-05

## Findings

### Files Found

| File Path | Description |
|---|---|
| `README.md` | Project overview; describes CC-Panes as a Claude Code first multi-agent workspace and mentions split-pane terminal layout. |
| `README.zh-CN.md` | Chinese overview; states support for split screen, tabs, multi-pane layout, and terminal size synchronization. |
| `docs/00-overview.md` | Architecture overview; confirms Tauri 2 + React 19 + Zustand 5 + Immer, xterm.js + portable-pty, and Allotment as split dependency in docs. |
| `docs/11-tauri-gui-basic.md` | Older/basic GUI phase doc; lists `PaneContainer + SplitContainer + Panel`, `TerminalView`, and `TabBar` as completed. Note: this doc contains older Vue/splitpanes wording that differs from current React code. |
| `web/types/pane.ts` | Outer pane tree type model: `PaneNode = Panel | SplitPane`; panel owns tabs; split owns direction, children, and percentage sizes. |
| `web/types/terminal.ts` | Terminal tab model; each terminal tab can itself contain a nested `TerminalPaneNode = TerminalPaneLeaf | TerminalPaneSplit`. |
| `web/stores/paneTreeHelpers.ts` | Helper functions for creating panels/tabs and traversing pane tree (`findPane`, `findParent`, `collectPanels`). |
| `web/stores/usePanesStore.ts` | Main Zustand + Immer store for pane layout, tabs, tab movement, panel split/close/resize, terminal-in-tab split/close/resize, and persisted layout. |
| `web/components/panes/PaneContainer.tsx` | Recursive dispatcher: renders `Panel` for leaf panels and `SplitContainer` for split nodes. |
| `web/components/panes/SplitContainer.tsx` | Renders outer split nodes with `SplitView`; normalizes dragged sizes and calls `resizePanes`. |
| `web/components/panes/SplitView.tsx` | Custom draggable divider implementation using pointer events, `requestAnimationFrame`, percentage sizes, and min-size constraints. |
| `web/components/panes/Panel.tsx` | Per-pane panel component: owns tab bar, active tab rendering, panel focus, split/move/terminal split handlers, and terminal session cleanup. |
| `web/components/panes/TabBar.tsx` | Per-pane tab bar with sortable tabs, context menu, split/move commands, pin/rename/close actions, and density variants. |
| `web/components/panes/DndPaneProvider.tsx` | dnd-kit provider; handles tab reorder within a pane and move across pane tab bars. |
| `web/components/panes/TerminalTabContent.tsx` | Renders nested terminal splits inside one tab using the same `SplitView` primitive. |
| `web/i18n/locales/en/panes.json` | User-facing labels for split/move/close/pin/rename actions. |
| `web/i18n/locales/zh-CN/panes.json` | Chinese labels for the same pane/tab UX actions. |
| `web/stores/usePanesStore.test.ts` | Unit tests for split right/down, close pane normalization, resize notifications, and tab operations. |
| `src-tauri/src/commands/terminal_commands.rs` | Rust/Tauri terminal command layer; relevant to PTY sessions, not the UI pane tree. |
| `cc-panes-core/src/services/terminal_service.rs` | Rust terminal service; relevant to PTY lifecycle, not the frontend pane layout algorithm. |
| `cc-panes-core/src/models/session_restore.rs` and `cc-panes-core/src/services/session_restore_service.rs` | Session restore metadata support; not needed for CLI-Manager MVP if layout restore is explicitly excluded. |

### What cc-pane Implements

- CC-Panes is a Tauri 2 desktop app for running multiple AI coding sessions side by side. The README states: "Run multiple AI coding sessions in a split-pane terminal layout" and "Flexible split panes and tabbed terminals backed by xterm.js and portable-pty" (`README.md:24`, `README.md:45`).
- It is not just a terminal splitter. It includes workspaces/projects/tasks, launch profiles/providers, local history, Git tools, session resume, screenshots, voice input, notifications, and popup terminal windows (`README.md:18-29`, `README.md:43-75`).
- Current implementation is a React/Zustand frontend with Rust backend PTY/session services. `docs/00-overview.md:7-21` says Tauri 2 + React 19 + TypeScript, Zustand 5 + Immer, xterm.js + portable-pty, SQLite, and a split UI library entry in docs.
- For terminal layout specifically, the visible implementation has two split layers:
  - Outer application pane tree: panels with per-panel tab bars.
  - Inner terminal pane tree inside a single terminal tab: one tab can contain multiple terminal leaves/splits.

### Pane / Tree / Layout Model

#### Outer pane tree

`web/types/pane.ts:8-26` defines a small tree model:

```ts
export type PaneNode = Panel | SplitPane;

export interface Panel {
  type: "panel";
  id: string;
  tabs: Tab[];
  activeTabId: string;
}

export interface SplitPane {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: PaneNode[];
  sizes: number[];
}
```

Important conventions:

- `direction: "horizontal"` means left/right split; `direction: "vertical"` means top/bottom split (`web/types/pane.ts:23`).
- `sizes` are percentage ratios (`web/types/pane.ts:25`).
- `SplitDirection` user commands are `"right" | "down"` (`web/types/pane.ts:28-30`).
- Tree traversal helpers are simple recursive functions: `findPane`, `findParent`, `collectPanels` (`web/stores/paneTreeHelpers.ts:72-106`).

#### Store operations

`web/stores/usePanesStore.ts:353-416` exposes operations including:

- Layout: `split`, `splitRight`, `splitDown`, `closePane`, `resizePanes`.
- Tabs: `addTab`, `closeTab`, `togglePinTab`, `renameTab`, `reorderTabs`, `moveTab`, `splitAndMoveTab`, `selectTab`.
- Terminal-in-tab split: `splitTerminalPane`, `closeTerminalPane`, `resizeTerminalPanes`.

Split algorithm (`web/stores/usePanesStore.ts:464-515`):

- Maps `right -> horizontal`, `down -> vertical`.
- If splitting root panel, replaces root with a `SplitPane` containing `[targetPane, newPane]` and `[50, 50]` sizes.
- If parent split already has same direction, inserts a sibling after target and resets all child sizes to equal percentages.
- If parent split direction differs, wraps target into a new nested split `[targetPane, newPane]`.
- Sets the new pane active and emits `cc-panes:terminal-layout-changed` via `requestAnimationFrame` (`web/stores/usePanesStore.ts:27-45`, `usePanesStore.ts:509-511`).

Close algorithm (`web/stores/usePanesStore.ts:517-587`):

- Saves recoverable terminal tab snapshots before closing.
- Root panel close resets to a new empty panel.
- Non-root close removes child and size slot, normalizes remaining sizes, selects a nearby surviving panel, then runs `normalizePaneTree`.
- `normalizePaneTree` collapses degenerate split nodes with 0/1 children (`web/stores/usePanesStore.ts:292-310`).

Move tab algorithm (`web/stores/usePanesStore.ts:641-714`):

- Removes tab from source panel and inserts into target panel at optional index.
- Activates the moved tab in target pane and makes target pane active.
- If source panel becomes empty, calls `closePane` and then restores target focus.
- Emits layout changed event with reason `tab.move`.

Split-and-move algorithm (`web/stores/usePanesStore.ts:716-805`):

- Only works when source panel has more than one tab (`sourcePane.tabs.length <= 1` returns).
- Removes the tab, creates a new `Panel` containing only that tab, then inserts/wraps it using the same split direction logic as ordinary split.

Resize (`web/stores/usePanesStore.ts:590-597`):

- Finds a split node by id and replaces `sizes`, then emits layout changed.

Persistence (`web/stores/usePanesStore.ts:1548-1597`):

- Uses Zustand `persist` with name `cc-panes-layout`, version `3`.
- `partialize` persists `rootPane` and `activePaneId`; runtime-only popped windows are excluded.
- It has migration and merge cleanup for old persisted state.
- This is explicitly more than CLI-Manager MVP needs if no layout restore is planned.

#### Inner terminal tree

`web/types/terminal.ts:47-78` defines terminal splits inside one tab:

```ts
export type TerminalPaneNode = TerminalPaneLeaf | TerminalPaneSplit;

export interface TerminalPaneLeaf {
  type: "leaf";
  id: string;
  sessionId: string | null;
  // resume/provider/ssh/wsl metadata omitted here
}

export interface TerminalPaneSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: TerminalPaneNode[];
  sizes: number[];
}
```

The same direction and ratio idea is reused for terminal leaves inside one tab. `TerminalTabContent.tsx:192-203` recursively renders terminal split nodes using `SplitView`, and calls `resizeTerminalPanes(tab.id, node.id, normalizeSizes(sizes))` on drag end.

For CLI-Manager's JetBrains-style feature, this inner terminal tree is likely not needed for MVP because the planned model is pane-tree layout with per-pane tab bars, not multiple terminal leaves inside a single tab.

### Rendering and Drag Patterns

- `PaneContainer.tsx:10-15` recursively dispatches between `Panel` and `SplitContainer`.
- `SplitContainer.tsx:14-27` normalizes drag-end sizes to one decimal and writes them back through `resizePanes`.
- `SplitContainer.tsx:37-48` passes split orientation, sizes, min size, stable child keys, and child `PaneContainer`s into `SplitView`.
- `SplitView.tsx:4-15` takes `vertical`, percentage `sizes`, `minSize`, `onDragEnd`, `children`, and stable `keys`.
- `SplitView.tsx:64-108` handles pointer movement with `requestAnimationFrame`, adjusts adjacent sibling sizes only, enforces minimum size, and calls `onDragEnd([...sizesRef.current])` on pointer up.
- `SplitView.tsx:123-125` comments that stable keys are used to avoid unnecessary unmount/remount when node counts change, specifically to avoid terminal re-creation/freeze.
- `DndPaneProvider.tsx:66-117` uses dnd-kit drag end handling. If source and target pane are the same, it calls `reorderTabs`; otherwise it calls `moveTab` with a target insertion index.
- `TabBar.tsx:162-165` marks each tab as sortable with data `{ type: "tab", paneId, tab }`.

### Relevant UX Conventions

Visible UX labels from `web/i18n/locales/en/panes.json:17-39` and `web/i18n/locales/zh-CN/panes.json:17-39`:

| UX Action | English label | Chinese label |
|---|---|---|
| Split active terminal inside tab right | `Terminal · Split Right` | `终端 · 右切` |
| Split active terminal inside tab down | `Terminal · Split Down` | `终端 · 下切` |
| Split panel right | `Panel · Split Right` | `面板 · 拆分到右侧` |
| Split panel down | `Panel · Split Down` | `面板 · 拆分到下方` |
| Close panel | `Close Panel` | `关闭面板` |
| Close terminal pane | `Terminal · Close Pane` | `终端 · 关闭窗格` |
| Move tab to newly split panel right | `Panel · Move Right` | `面板 · 移至右侧` |
| Move tab to newly split panel down | `Panel · Move Down` | `面板 · 移至下方` |
| Tab management | Rename, Pin/Unpin, Minimize, Close, Close left/right/others | 重命名、固定/取消固定、最小化、关闭、关闭左/右/其他 |

Context-menu behavior in `TabBar.tsx:290-370`:

- Rename and pin are always available.
- Panel split right/down commands are available from tab context menu.
- If a pane has more than one tab, move-right/move-down into a new split is available.
- Terminal split right/down is separate from panel split right/down.
- Close-left/right/others are only useful when multiple tabs exist.
- Pinned tabs cannot be closed from the normal close action.
- Double-clicking a tab triggers fullscreen (`TabBar.tsx:223-224`); this is outside CLI-Manager MVP unless already present.

Per-pane tab bar conventions:

- `Panel.tsx:405-427` passes pane-specific callbacks into `TabBar`, so each pane owns its own tab bar.
- `Panel.tsx:431-449` keeps all tab content mounted but hides inactive tabs with `display: none`; that avoids destroying terminal components when switching tabs.
- `TabBar.tsx:452` changes density based on tab count: normal <= 3, compact <= 6, dense beyond that.
- Tabs include status indicator, pin icon, close button, rename-on-double-click label, and sortable drag handle behavior (`TabBar.tsx:162-226`, `TabBar.tsx:227-283`).

### What Is Applicable to CLI-Manager React/Zustand App

Applicable directly as reference patterns, not code copying:

1. **Simple discriminated tree model**
   - Use a discriminated union with `panel` leaf and `split` internal nodes.
   - Store `direction`, `children`, and percentage `sizes` on split nodes.
   - Store `tabs` and `activeTabId` on panel leaves.
   - This matches CLI-Manager's planned pane-tree layout with per-pane tab bars.

2. **Recursive rendering**
   - A small `PaneContainer` dispatcher plus `SplitContainer` plus `Panel` maps cleanly to React.
   - This avoids special-case layout code for nested splits.

3. **Split insert/wrap rules**
   - Same-direction split: insert new panel as sibling.
   - Different-direction split: wrap current panel in a new split.
   - This supports nested splits naturally and maps to JetBrains-style right/down behavior.

4. **Close/unsplit normalization**
   - Removing a pane should collapse parent splits with only one remaining child.
   - Active pane should move to a surviving sibling/descendant.
   - Ratios should be normalized after removal.

5. **Drag divider ratios**
   - Percentage sizes are sufficient for MVP.
   - Pointer-event + `requestAnimationFrame` divider logic is easy to reason about and avoids adding a dependency if CLI-Manager does not already rely on a split library.
   - Stable child keys matter for terminal components to avoid remounting xterm instances.

6. **Tab movement**
   - Drag tab to another pane tab bar can be modeled as `moveTab(fromPaneId, toPaneId, tabId, toIndex?)`.
   - If the source pane becomes empty, close/normalize that pane.
   - Reordering within the same pane is a separate `reorderTabs` operation.

7. **Move to Other Split / Split-and-move**
   - `splitAndMoveTab` is a useful direct model for JetBrains "Move to Right/Down Split".
   - Guarding against moving the only tab out of a pane prevents accidental empty pane creation.

8. **Terminal layout changed event**
   - Emitting a layout-change event after split/close/resize/move lets terminal views schedule fit/resize without coupling every action to xterm internals.
   - CLI-Manager already uses xterm/FitAddon; a similar layout notification may be useful.

9. **Tests worth mirroring**
   - Tests in `web/stores/usePanesStore.test.ts` cover root split, nested close normalization, resize state update, and event dispatch.
   - CLI-Manager can use equivalent store-level tests without involving actual terminal rendering.

### What to Avoid Copying

Avoid copying these parts for CLI-Manager MVP:

1. **The inner terminal-in-tab split tree**
   - CC-Panes supports both outer panels and nested terminal panes inside a single tab (`TerminalPaneNode`).
   - CLI-Manager's planned MVP is pane-tree layout with per-pane tab bars. Adding terminal splits inside one tab would double the model complexity.

2. **Layout restore/persistence machinery**
   - CC-Panes persists `rootPane` and `activePaneId` with migrations under `cc-panes-layout` (`usePanesStore.ts:1548-1597`).
   - User context explicitly says no layout restore for MVP. Persisting tree layout now is extra risk.

3. **Large AI-agent/session/provider metadata in tabs**
   - CC-Panes tab objects contain resume id, workspace/provider/launch profile, SSH/WSL, popped-out state, restore metadata, etc. (`web/types/terminal.ts:80-118`).
   - CLI-Manager should keep tab metadata limited to its existing terminal/session/project fields.

4. **Popup/popped-out tab support**
   - CC-Panes tracks `poppedOutTabs` and excludes it from persistence (`usePanesStore.ts:357`, `usePanesStore.ts:1586-1590`).
   - Not relevant to JetBrains-style split MVP unless CLI-Manager already has popup terminals.

5. **Advanced tab actions outside requested scope**
   - Pin, minimize, restore closed tabs, close-left/right/others, fullscreen, reveal in explorer, and dirty editor checks are useful in CC-Panes but not required for the planned terminal split MVP.

6. **Historical docs that no longer match current implementation**
   - `docs/11-tauri-gui-basic.md` mentions Vue 3 and `splitpanes`; current overview and code are React/Zustand and custom `SplitView`/dnd-kit. Treat that doc as historical context only.

7. **Direct source-code copying**
   - Repository license is GPL-3.0 (`README.md:7`, `LICENSE`). CLI-Manager should use it as a design reference only unless license compatibility is explicitly handled.

### External References

- https://github.com/wuxiran/cc-pane — source repository researched.
- https://github.com/wuxiran/cc-pane/blob/HEAD/README.md — project overview and high-level feature claims.
- https://github.com/wuxiran/cc-pane/blob/HEAD/web/types/pane.ts — visible outer pane type model.
- https://github.com/wuxiran/cc-pane/blob/HEAD/web/stores/usePanesStore.ts — visible Zustand pane operations.
- https://github.com/wuxiran/cc-pane/blob/HEAD/web/components/panes/DndPaneProvider.tsx — visible tab DnD behavior.
- https://github.com/wuxiran/cc-pane/blob/HEAD/web/components/panes/SplitView.tsx — visible draggable split implementation.

### Related Specs

- No `.trellis/spec/**/*.md` files were required to answer this external reference query.
- Target task context is `F:/github/CLI-Manager/.trellis/tasks/06-05-jetbrains/`.

## Caveats / Not Found

- This research used GitHub raw/API reads, not a local clone. Line numbers refer to `HEAD` at query time and may shift if the remote repository changes.
- The repository name is `cc-pane`, but the product/crates use `CC-Panes` / `cc-panes-*` naming.
- Rust backend files appear focused on PTY/session/restore services. The pane tree/layout algorithm is visible in frontend TypeScript, not Rust.
- No direct evidence was found that Rust owns the pane layout tree; the relevant tree state is in `web/stores/usePanesStore.ts`.
