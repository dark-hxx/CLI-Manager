# Design: preserve Radix portal and measurement boundaries

## Architecture and boundary

`FileExplorerSidebar` retains ownership of one menu Portal host, but renders that host through the existing `Portal` component directly under `document.body`. Every file explorer `ContextMenuContent` continues receiving the same `menuPortalContainer` reference.

The body-level host receives the existing `panelStyle` object. In panel mode this carries terminal semantic CSS variables across the React portal boundary; in sidebar mode the undefined style lets the menu inherit document/application theme variables. No action data or component state crosses a new boundary.

The shared `ContextMenuContent` and `ContextMenuSubContent` wrappers add a dedicated `radix-context-menu-content` class. The base `.context-menu` remains `position: fixed` for the manually positioned project/history menus, while the more specific Radix class sets `position: relative`. The Radix content therefore stays in normal flow and gives the Popper wrapper its complete width and height.

Each file/search row already uses `ContextMenuTrigger asChild`, so Radix writes `data-state="open"` directly onto `.ui-file-tree-row`. The row stylesheet aliases that state to the existing selected treatment, including ignored-row opacity. This provides menu-lifetime target feedback without introducing component/store state or changing the active editor file.

## Rendering flow

1. `FileExplorerSidebar` renders its visible tree in the sidebar or auxiliary panel.
2. A sibling React `Portal` creates an otherwise empty host under `document.body` and stores it in `menuPortalContainer`.
3. Each Radix `ContextMenuContent` portals into that host.
4. The Radix-only class keeps the menu content inside the wrapper's measurement flow.
5. Because the host is outside transformed/overflow-hidden layout ancestors, the measured fixed wrapper shifts/flips within the application viewport.
6. The host's inherited/inline CSS variables preserve the existing file explorer menu skin.
7. While the menu is open, the trigger row's Radix state reuses the selected-row highlight; closing the menu removes it automatically.

## Compatibility

- Keep the existing `portalContainer` API and all four call sites unchanged.
- Keep `panelStyle` as the single source of terminal-panel menu variables.
- Keep `.context-menu { position: fixed }` unchanged for the manually positioned menus in `sidebar/index.tsx` and `HistoryListPane.tsx`.
- Apply the Radix-only override to both root and submenu content so all shared wrapper consumers follow the same measurement contract.
- Keep `PathCopyMenu` inside the same Radix content so its in-place branch swap and focus handoff are unchanged.
- First-render `menuPortalContainer === null` remains safe: the shared wrapper already falls back to Radix's default body portal until the host ref is available.
- No IPC, persistence, schema, permission, process, or localization contract changes.

## Trade-offs

- A dedicated body child is preferred over removing panel `overflow-hidden`/`transform`, because those properties own panel geometry and animation.
- A dedicated host is preferred over using the default body portal alone, because it preserves panel-local semantic CSS variables without duplicating styles on every menu content.
- A Radix-specific class is preferred over changing `.context-menu` globally, because manual menus still require viewport-fixed coordinates.
- The shared wrapper is the narrowest safe ownership point: applying the override only in the file explorer would leave identical broken Popper semantics in other Radix consumers.

## Risk and rollback

Risk covers shared Radix context-menu geometry but not menu actions. Rollback consists of the body-host source hunk plus the Radix-only class/style hunk; the base fixed style must remain intact. Static tests guard both boundaries and ensure manual-menu positioning is not globally changed.
