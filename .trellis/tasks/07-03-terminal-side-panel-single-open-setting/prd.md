# Terminal Side Panel Single Open Setting

## Goal

Add a Terminal settings switch that controls whether terminal auxiliary side panels are mutually exclusive. The default behavior is to allow only one side panel open at a time.

## Changelog Target

[TEMP]

## What I Already Know

* User wants the sidebar/side panel area to only open one panel at the same time.
* User then clarified this must be controlled by a switch in Terminal settings.
* Default must be "only allow one open".
* Existing terminal auxiliary panels are session history, realtime stats, Git changes, AI Replay, and files.
* Existing `terminalSidePanelMerged` setting combines several right-side panels into one tabbed panel, but it lives in Sidebar settings and is not the requested behavior switch.

## Requirements

* Add a persisted setting for terminal side panel single-open behavior.
* Default the setting to enabled.
* Add the switch in Settings > Sidebar, below the merge realtime stats and Git changes panel setting.
* When enabled, opening one terminal side panel closes the other terminal side panels.
* When disabled, keep the current non-merged multi-panel behavior where applicable.
* Keep merged-panel behavior compatible with the new setting.
* Add Simplified Chinese and English UI copy through the i18n layer.

## Acceptance Criteria

* [x] New installs/default settings allow only one terminal side panel open at a time.
* [x] Settings > Sidebar has a switch for the behavior below the merge panel setting.
* [x] Turning the switch off preserves current multi-panel behavior in non-merged mode.
* [x] Opening history closes right-side panels when single-open is enabled.
* [x] Opening stats/Git/Replay/files closes history and other right-side panels when single-open is enabled.
* [x] TypeScript check passes.
* [x] `CHANGELOG.md` and `docs/功能清单.md` are updated.

## Definition of Done

* Tests or static checks run where practical.
* User-visible text supports `zh-CN` and `en-US`.
* Behavior changes are documented.
* No dependency or backend changes.

## Out of Scope

* Redesigning the terminal toolbar.
* Moving the existing "merge side panels" setting.
* Adding tests for the full Tauri desktop runtime.
* Changing terminal pane split behavior.

## Technical Notes

* Likely files:
  * `src/stores/settingsStore.ts`
  * `src/components/TerminalTabs.tsx`
  * `src/components/settings/pages/SidebarSettingsPage.tsx`
  * `src/lib/i18n.ts`
  * `CHANGELOG.md`
  * `docs/功能清单.md`
* Relevant guideline files read:
  * `.trellis/spec/frontend/component-guidelines.md`
  * `.trellis/spec/frontend/state-management.md`
  * `.trellis/spec/frontend/quality-guidelines.md`
* GitNexus impact analysis for existing panel handlers returned LOW risk before this expanded requirement.
