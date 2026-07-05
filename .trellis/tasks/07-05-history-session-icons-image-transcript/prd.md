# history session list icons and image transcript rendering

## Changelog Target

[TEMP]

## Goal

Improve the history session list visual polish and make image attachments in the transcript readable: render existing local images from transcript image markers, and fall back to the original text when the image cannot be loaded.

## What I already know

- The screenshot highlights three list visuals: parent expand/collapse, row close/delete, and subagent badge.
- Transcript image markers appear as raw text like `<image name=[Image #1] path="C:\...\image.png"> [Image #1]`.
- `HistoryListPane.tsx` renders the session tree row, subagent badge, expand button, and row delete button.
- `SessionTranscriptContent.tsx` is the required history transcript render layer before Markdown.
- Shared `MarkdownContent.tsx` intentionally keeps normal Markdown images as placeholders and should not be widened for arbitrary image loading.
- `file_read_image(root_path, relative_path)` already reads local images as base64 with an image type whitelist and 10 MB cap.
- `convertFileSrc` is not suitable for arbitrary transcript temp images because `assetProtocol.scope` is currently limited to `$APPLOCALDATA/backgrounds/**`.

## Requirements

- Restyle the history session list expand/collapse, close/delete, and subagent badge with a simple clean style.
- Keep list density stable and avoid layout shifts.
- Detect transcript image markers with local `path="..."`.
- If the local image loads, show the image inline in the transcript.
- If the file is missing, unsupported, too large, or unreadable, display the original raw marker text.
- Keep the behavior scoped to history transcript rendering, not global Markdown rendering.

## Acceptance Criteria

- [ ] Parent rows show a cleaner expand/collapse control.
- [ ] Row close/delete button is visually quieter by default and clear on hover/focus.
- [ ] Subagent badge is compact and readable without dominating the row title.
- [ ] A transcript marker for an existing PNG/JPEG/GIF/WebP/BMP/SVG image displays the image.
- [ ] A transcript marker for a missing image displays the original text marker.
- [ ] TypeScript check passes.

## Definition of Done

- Tests/static checks run where practical.
- `CHANGELOG.md` updated under `[TEMP]`.
- `docs/功能清单.md` updated if needed for product behavior.
- Manual UI verification items listed because the desktop app is not started by AI.

## Out of Scope

- Changing backend history parsing/storage contracts.
- Expanding Tauri asset protocol scope.
- Loading remote images from Markdown/history content.
- Redesigning the entire history panel.

## Technical Notes

- Relevant files inspected:
  - `src/components/history/HistoryListPane.tsx`
  - `src/components/history/SessionTranscriptContent.tsx`
  - `src/components/ui/MarkdownContent.tsx`
  - `src/styles/components.css`
  - `src-tauri/src/commands/fs.rs`
  - `src-tauri/tauri.conf.json`
- Frontend specs consulted:
  - `.trellis/spec/frontend/component-guidelines.md`
  - `.trellis/spec/frontend/quality-guidelines.md`
  - `.trellis/spec/frontend/history-session-contracts.md`
- GitNexus impact:
  - `SessionTranscriptContent`: LOW
  - `HistoryListPane`: LOW
  - `MarkdownContent`: LOW
