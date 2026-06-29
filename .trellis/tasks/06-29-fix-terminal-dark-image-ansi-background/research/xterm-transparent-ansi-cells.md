# xterm transparent background and ANSI cell backgrounds

## Sources

- xterm.js `ITerminalOptions.allowTransparency`: https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/
- xterm.js `Terminal.onWriteParsed`: https://xtermjs.org/docs/api/terminal/classes/terminal/
- xterm.js `IBufferCell`: https://xtermjs.org/docs/api/terminal/interfaces/ibuffercell/
- xterm.js discussion #5244: https://github.com/xtermjs/xterm.js/discussions/5244
- xterm.js discussion #4496: https://github.com/xtermjs/xterm.js/discussions/4496
- xterm.js issue #5847: https://github.com/xtermjs/xterm.js/issues/5847

## Findings

- xterm's official option docs confirm `allowTransparency` must be set before `Terminal.open()` and cannot be changed later without recreating the terminal. The current code already does this correctly.
- xterm maintainers recommend implementing background images by enabling transparency and using a transparent theme background; a maintainer also points out that opaque `.xterm-viewport` styles can block the background image.
- xterm buffer cells keep their own foreground/background attributes. Official `IBufferCell` exposes background mode/color checks such as `getBgColorMode()`, `isBgDefault()`, `isBgPalette()`, and `isBgRGB()`.
- `Terminal.onWriteParsed` is explicitly documented as useful for reacting to buffer changes after parsing. The current code already normalizes in the `terminal.write(..., callback)` path and schedules another normalization after render.
- A 2026 xterm issue reports that in Tauri plus WebGL plus transparent theme backgrounds, lines with ANSI background colors can show rendering artifacts during streaming output. This is not the same bug report, but it confirms that transparent backgrounds plus non-default cell backgrounds are a fragile area.

## Review of the original plan

The original "enable existing TUI background normalization whenever a terminal background image is active" direction is still the best first fix, but it needs two clarifications:

1. It should be scoped to Claude/Codex-like TUI composer rows through the existing prompt-row detection. Do not clear backgrounds globally.
2. It should be presented as clearing bad xterm cell attributes in background-image mode, not as changing transparent theme alpha or WebGL behavior.

## Alternatives reviewed

### Disable WebGL when a background image is active

- Pros: may avoid WebGL-specific transparent-background artifacts.
- Cons: broad performance and rendering behavior change for all dark-theme background-image users.
- Verdict: keep as fallback only if the targeted cell cleanup does not fix issue #68.

### Change `applyTransparency()` dark alpha floor

- Pros: small change.
- Cons: does not remove explicit ANSI background cells; likely insufficient.
- Verdict: not recommended as the primary fix.

### Rewrite ANSI stream before xterm parses it

- Pros: could remove specific SGR background sequences.
- Cons: fragile across chunk boundaries and TUI render variants; project spec already warns against broadening ANSI filters after the first miss.
- Verdict: not recommended.

## Updated recommendation

Keep the first implementation minimal:

- Rename/replace the brightness-only gate with a background-image gate, e.g. `shouldNormalizeTuiComposerBackground() => isTransparentRef.current`.
- Keep the existing prompt signature, prelude/continuation scan, explicit-background checks, and wide-inverse handling.
- Do not disable WebGL in this task unless manual verification proves the targeted cleanup is insufficient.
- Add manual verification specifically for dark theme + background image + Claude/Codex, plus a regression pass for light theme and no-image mode.
