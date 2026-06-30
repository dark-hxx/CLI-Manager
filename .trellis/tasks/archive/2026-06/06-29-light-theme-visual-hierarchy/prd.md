# Optimize Light Theme Visual Hierarchy

## Goal

Improve the CLI-Manager light theme so dense developer workflows are easier to scan: stronger text contrast, clearer selected states, and cleaner panel hierarchy. The change should be visual only and should not alter terminal, Git, project tree, or session behavior.

## What I Already Know

* The user reviewed a light-theme screenshot and asked what could be optimized.
* The highest-value improvements identified from the screenshot are contrast, selected-state clarity, and terminal/code readability.
* The user chose MVP option 1: foundation-only visual fixes. Git panel structural cleanup is out of scope for this task.
* This is a desktop developer tool; the UI should stay dense, quiet, and work-focused. Avoid landing-page style spacing, decorative gradients, or large card layouts.
* User-visible copy must stay i18n-compatible for `zh-CN` and `en-US` if any text changes are needed.
* No new dependency should be added for this task.

## Assumptions

* MVP should focus on foundation styling visible in the current light theme: left project tree, top terminal tabs/chrome, central terminal transcript, right panel shell, and small toolbar buttons.
* Existing light palettes should not be removed. If palette token changes are needed, they should be conservative and avoid breaking dark themes.
* This task should not redesign layout, navigation, Git behavior, terminal behavior, or settings structure.

## Requirements

* Improve light-theme text contrast for primary, secondary, and muted text used in dense panels.
* Make selected/active states more obvious and consistent across project tree, terminal tabs, action sidebar, and right-side panel shells.
* Improve light-theme surface and border hierarchy so panel boundaries are clear without adding decorative treatment.
* Keep the existing compact desktop-tool density; avoid large spacing increases.
* Preserve existing interactions, keyboard access, and drag behavior.
* Preserve dark theme behavior.

## Acceptance Criteria

* [ ] Light-theme primary text is clearly readable in terminal transcript, sidebars, tabs, and Git panel.
* [ ] Selected project, selected tab, and active side-panel button are visually distinct without relying only on subtle tint.
* [ ] Light-theme panel boundaries and toolbar button states are clearer without increasing layout size.
* [ ] No new hard-coded user-facing strings are introduced outside `src/lib/i18n.ts`.
* [ ] Dark theme screenshots remain visually unchanged or intentionally equivalent.
* [ ] `npx tsc --noEmit` passes.

## Definition of Done

* Relevant frontend specs are consulted before implementation.
* Visual changes are scoped to existing theme/style/component surfaces.
* Type check passes.
* Manual visual check covers light and dark themes at desktop size.
* Notes/spec updates are considered if a reusable light-theme rule is discovered.

## Out of Scope

* New theme picker UI.
* New light palette family.
* Reworking terminal rendering, xterm behavior, Git logic, or project tree data model.
* Git panel row/counter/filter structural cleanup.
* Adding dependencies.
* Broad responsive/mobile redesign.

## Technical Notes

* Semantic search found likely theme/style entry points:
  * `src/styles/themes.css` defines light palette and semantic tokens, including `--surface-*`, `--on-surface`, and `--interactive-*`.
  * `src/styles/components.css` defines left tree selected states and terminal chrome/action sidebar styles.
  * `src/components/git/GitChangesPanel.tsx` owns Git changes panel layout, counters, filters, and commit controls.
  * `src/components/TerminalTabs.tsx` owns terminal toolbar/action button rendering.
  * `src/components/terminal/TerminalSidePanel.tsx` may affect right-side panel shell styling.
* Frontend guideline index: `.trellis/spec/frontend/index.md`.
* Screenshot concern: light theme currently reads as too flat because surfaces, borders, muted text, and selected states are close in value.

## Open Questions

* None. MVP scope is foundation-only visual fixes.
