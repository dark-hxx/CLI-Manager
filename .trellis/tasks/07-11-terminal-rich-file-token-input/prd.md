# terminal-rich-file-token-input

## Changelog Target

[TEMP]

## Goal

Make terminal file references behave as atomic inline tokens in the active input line. The visible file chip must occupy its own rendered width, and the visible caret must move before or after the token instead of disappearing behind an absolute overlay.

## Requirements

- Keep the real `@path` text in the PTY input buffer so Claude, Codex, and shells receive the existing input format.
- Remove artificial trailing-space reservation from internal file drag and editor-to-terminal insertion.
- Render the active input as a mirrored inline model containing plain-text segments and atomic file-token segments.
- Hide the native xterm input text/caret while the tracked input either matches the actual xterm buffer or remains attached to the last validated input anchor during application-controlled file insertion.
- Render a synthetic caret at the mirrored logical cursor position.
- ArrowLeft/ArrowRight must cross a file token atomically while sending the required repeated cursor sequences to the PTY.
- Backspace/Delete must remove a complete adjacent file token.
- Clicking the left/right half of a file token must place the caret before/after it.
- Fall back to normal xterm rendering when neither direct buffer validation nor the bounded trusted input anchor can establish ownership of the current input region.
- Keep submitted/history references on the existing passive visual treatment; only the active input gets rich interaction.

## Acceptance Criteria

- [ ] Consecutive file tokens have a normal one-character visual gap without padding hacks.
- [ ] File names render completely without ellipsis or overlap.
- [ ] The caret is always visible before or after a file token and never behind it.
- [ ] Left/right navigation treats a file token as one unit.
- [ ] Backspace/Delete removes a file token as one unit.
- [ ] Clicking a file token selects the nearest token boundary.
- [ ] Enter submits the original `@path` value unchanged.
- [ ] Enter, session changes, history navigation, and unknown control input clear the trusted anchor instead of showing stale content.
- [ ] `npx tsc --noEmit` passes.

## Out of Scope

- Replacing xterm's fixed cell renderer.
- A general-purpose contenteditable terminal composer.
- Rich tokens for arbitrary URLs, commands, or non-file values.

## Technical Notes

- `XTermTerminal` already tracks `inputBuffer` and `inputCursorIndexRef` and translates click/cursor movement into PTY control sequences.
- The existing per-token absolute overlay is suitable for passive history rendering but cannot provide correct active-input caret semantics.
- TUI screen redraws are not a stable source for reconstructing wrapped active input. Use the last directly validated input-start cell as a bounded anchor for subsequent application-controlled file insertions.
- No new dependency is required.
