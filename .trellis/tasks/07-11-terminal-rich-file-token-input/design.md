# Design

## Decision

Use an active-input mirror layer backed by the existing xterm input buffer tracking. The PTY remains the source of the raw `@path` text; the mirror is a visual and interaction projection.

## Model

`terminalRichInput.ts` parses the current input into:

- text segments with raw start/end indices
- file segments with raw value, label, icon key, and raw start/end indices

Cursor mapping snaps positions inside a file segment to its nearest boundary.

## Rendering

When the tracked input is trusted and contains a file segment:

1. Compute the input start cell from the real xterm cursor and raw prefix width.
2. Cover the raw input cells with terminal background-colored mask rows.
3. Render the mirrored content from the same start point using monospace text and inline file chips.
4. Insert a synthetic caret element at the logical cursor boundary.

The mirror uses the xterm screen width and cell height. Plain text preserves whitespace. File chips use their intrinsic content width.

## Input Translation

- Ordinary text continues through xterm unchanged.
- ArrowLeft after a file token sends `rawLength` left sequences.
- ArrowRight before a file token sends `rawLength` right sequences.
- Backspace after a file token sends `rawLength` backspaces.
- Delete before a file token sends `rawLength` deletes.
- Clicking a token chooses its before/after boundary and sends the raw index delta.

## Buffer Validation Boundary

The mirror is enabled only when `inputBuffer` can be matched cell-by-cell against the current xterm buffer at the calculated input start. History recall, stale local tracking, or an unresolvable cursor/input start disable the mirror. Internal file paste also repairs the local input model when xterm bracketed-paste events do not update it as one logical insertion. Normal xterm rendering remains the fallback.

## Risks

- TUI redraws may move the hardware cursor independently of local input tracking.
- Raw and mirrored wrapping can use different row counts.
- IME composition must continue through xterm's textarea; the mirror only observes committed input.

The MVP avoids rewriting the entire terminal composer and limits the mirror to trusted active inputs containing file tokens.
