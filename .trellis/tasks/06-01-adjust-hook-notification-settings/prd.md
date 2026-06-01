# Adjust Hook Notification Settings

## Goal

Update Hook settings and CLI hook notifications so users can refresh Claude Hook status from the Claude card, disable popup reminders while keeping tab-dot status changes, remove grouped/overlaid popup behavior, and configure automatic popup closing.

## What I already know

* User reports the Claude Code Hook bridge card has no "刷新状态" button.
* Current `HookSettingsPage` has one "刷新状态" button only in the Codex card action row.
* Current hook toast rendering lives in `src/App.tsx` and groups multiple items for the same tab into one `toast.custom` stack.
* Current hook notification dot state lives in `src/stores/terminalStore.ts` and is updated by `handleCliHookEvent` before popups are shown.
* Existing settings are persisted through `src/stores/settingsStore.ts` via `tauri-plugin-store` `settings.json`.
* Current toast duration is `Infinity`; all hook popup cards must be manually dismissed.

## Assumptions (temporary)

* The new notification settings should be persisted in existing `settingsStore`, not in Rust backend config.
* "通知开关" controls only popup reminders; tab dot color should still update regardless.
* Hook popup settings apply to both Claude Code and Codex CLI notifications.
* "弹框叠加去掉" means each hook event should render as a separate Sonner toast arranged vertically from top to bottom, instead of grouped cards inside one toast.
* Default auto-close behavior is enabled with a default timeout of 60 seconds.

## Open Questions

(none)

## Requirements (evolving)

* Add a refresh-status button to the Claude Code Hook bridge card.
* Add a popup notification switch in Hook settings, default enabled.
* Popup notification, auto-close, and close-time settings apply to both Claude Code and Codex CLI hook popups.
* When popup notification is disabled, do not show hook popups, but still update tab-dot notification colors.
* Remove grouped/overlaid hook popup behavior; show all popups as separate top-to-bottom cards.
* Add an auto-close switch, default enabled.
* Add a default close-time setting, default 1 minute.
* The close-time input is editable only when auto-close is enabled.

## Acceptance Criteria (evolving)

* [ ] Claude Code Hook bridge card has a visible "刷新状态" button.
* [ ] Disabling popup notifications stops hook popup cards from appearing.
* [ ] Disabling popup notifications does not stop tab dot color updates.
* [ ] Multiple hook popups appear as independent top-to-bottom cards, not grouped/overlapped inside one custom stack.
* [ ] Auto-close defaults to enabled and closes hook popups after 60 seconds by default.
* [ ] Close-time control is disabled when auto-close is disabled.
* [ ] Settings persist after app reload.

## Definition of Done

* Typecheck passes.
* Rust check is not required unless backend code changes.
* UI behavior is verified manually if a dev build can be started.

## Out of Scope

* Changing hook installation script behavior.
* Changing Rust hook bridge payload validation.
* Changing tab notification color semantics.

## Technical Notes

* Relevant files inspected:
  * `src/components/settings/pages/HookSettingsPage.tsx`
  * `src/App.tsx`
  * `src/stores/settingsStore.ts`
  * `src/stores/terminalStore.ts`
  * `src/App.css`
  * `src-tauri/src/commands/hook_settings.rs`
  * `src-tauri/src/claude_hook.rs`
* Trellis specs read:
  * `.trellis/spec/frontend/index.md`
  * `.trellis/spec/frontend/quality-guidelines.md`
  * `.trellis/spec/backend/index.md`
  * `.trellis/spec/guides/index.md`
  * `.trellis/spec/guides/cross-layer-thinking-guide.md`
  * `.trellis/spec/guides/code-reuse-thinking-guide.md`
