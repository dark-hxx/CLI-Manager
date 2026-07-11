# Implementation Plan

1. Add a pure rich-input parser and cursor-boundary helpers in `src/lib/terminalRichInput.ts`.
2. Remove artificial file-token spacing from `XTermTerminal` insertion paths.
3. Track whether the current `inputBuffer` is trusted for mirrored rendering.
4. Build mirrored input geometry from the current xterm cursor, cell size, and token model.
5. Render mask rows, inline text/file segments, and a synthetic caret.
6. Intercept token-boundary arrow/delete operations and mirror clicks.
7. Keep the existing passive chip scan for non-active terminal content, excluding the mirrored active-input range.
8. Update `[TEMP]` changelog and feature inventory.
9. Run `npx tsc --noEmit`, `git diff --check`, and GitNexus change detection.
