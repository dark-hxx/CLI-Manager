# Terminal Right Side Provider Quick Switch — UX Design v4

## Layout

- Keep the left project sidebar completely unchanged.
- Add `providers` as a new tab in the terminal right-side `TerminalSidePanel`, alongside Stats, System Resources, Replay, Git and Files.
- Reuse the existing resizable panel width, terminal-panel skin, top tab strip and single-open behavior.
- The provider content is a single-layer flat list sized for a 320–420px right panel.

## Popover content

1. CLI segmented tabs, defaulting to the active terminal's CLI type.
2. One flat provider list; the current provider is the selected row, not a separate card.
3. Sticky text link to Provider Settings for CRUD and advanced configuration.

## Interaction

- Opening the Providers panel defaults to the active terminal's CLI type; manual CLI selection remains until terminal context changes.
- Selecting another provider keeps the right panel open while preview/apply runs, then refreshes all CLI summaries.
- Current provider is not re-submitted. Disabled/key-missing providers remain visible with an explanation and a Settings affordance.
- Arrow keys move within tabs/list; Enter/Space applies selection. Closing the right panel follows the existing TerminalSidePanel focus behavior.

## Simplification rules

- No cross-CLI summary cards.
- No duplicate current-provider detail card.
- No content header, list section title or search field; the active side-panel tab already supplies context.
- No persistent workflow explanation block; switching feedback uses the selected row and toast/live region.
- Keep only one accent-filled surface: the selected provider row. Other rows use transparent/hover backgrounds.

## Visual language

- Backgrounds: `#101212`, `#151817`, `#191d1b`.
- Accent: `#39d98a`; warning: `#f2b84b`; muted text: `#8f9894`.
- Radius: 8–12px; borders use low-contrast green/neutral strokes rather than heavy shadows.
- Motion: color/border transitions only (150–200ms); no scaling that shifts layout.

## Scope boundary

- Included: right-panel tab, view, CLI tab selection, search, quick global switch, status/error feedback, settings deep link.
- Excluded: create/edit/delete/reorder, key maintenance, Home/WSL selection, environment repair, raw configuration editing.
