# history transcript dialog mode

## Changelog Target

[TEMP]

## Goal

Change the history session "transcript/raw" view from generic message cards into a dialog-style conversation view. User messages should read as "my input", AI messages as "AI output", and long messages should be collapsed with an explicit expand action.

## Requirements

* Render the history transcript tab as a conversation flow.
* Label user messages as "我的输入" / "My Input".
* Label AI assistant/model messages as "AI 输出" / "AI Output".
* Keep other roles visible without falsely labeling them as AI output.
* Collapse long messages by default and allow expanding/collapsing the full content.
* Search matches and focused messages must remain visible, including hidden long-message content.
* Reuse the existing history transcript render layer for Markdown/transcript structures.
* Follow current app/system theme variables instead of hard-coded palette colors.
* Add zh-CN and en-US i18n entries for all new visible text.

## Acceptance Criteria

* [ ] Transcript tab shows user/AI messages as distinct conversation bubbles.
* [ ] Long messages show a bounded preview with an expand action.
* [ ] Expanded long messages show full content and can be collapsed again.
* [ ] Search-matched or focused long messages auto-expand.
* [ ] Styling uses existing CSS variables and works with theme changes.
* [ ] `npx tsc --noEmit` passes.

## Definition of Done

* Relevant code, i18n, changelog, and feature inventory are updated where applicable.
* Static verification is run.
* Manual verification items are listed for the desktop UI.

## Technical Approach

Update the existing frontend render path only. Keep `HistoryMessage` and backend parsing unchanged. Modify `SessionDetailPane.tsx` message rendering and `components.css` styles. Continue rendering message content through `SessionTranscriptContent`.

## Out of Scope

* No backend history parser changes.
* No database/schema changes.
* No new dependencies.
* No runtime auto-start of the Tauri desktop app.

## Technical Notes

* Main files inspected: `src/components/history/SessionDetailPane.tsx`, `src/components/history/SessionTranscriptContent.tsx`, `src/styles/components.css`, `src/lib/i18n.ts`, `src/lib/types.ts`.
* Frontend spec requires history transcripts to use `SessionTranscriptContent` before Markdown.
* Frontend spec requires user-facing text to go through `useI18n` / `src/lib/i18n.ts`.
