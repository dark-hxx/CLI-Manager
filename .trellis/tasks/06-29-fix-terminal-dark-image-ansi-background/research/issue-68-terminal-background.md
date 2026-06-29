# Issue 68 terminal background investigation

## Source

- GitHub issue: https://github.com/dark-hxx/CLI-Manager/issues/68
- Related archived PRD: `.trellis/tasks/archive/2026-06/06-26-codex-project-provider-switching/prd.md`
- Related terminal contrast PRD: `.trellis/tasks/archive/2026-06/06-28-fix-light-terminal-background-contrast/prd.md`
- xterm background research: `.trellis/tasks/archive/2026-05/05-25-terminal-background-customization/research/xterm-transparent-background.md`

## Confirmed issue facts

- Issue #68 title: "界面显示黑框较多，是否能进行优化呢".
- Reporter is using CLI-Manager V1.2.2.
- The black boxes appear after enabling a terminal background image and using Claude/Codex.
- Removing the background image removes the black boxes.
- Light terminal mode with a background image does not show the black boxes.
- The current failing scope is dark terminal mode plus background image.
- The issue comments explicitly say the light-mode black-box case was already fixed and dark-mode background-image behavior still needs a fix.

## Code findings

- `src/components/XTermTerminal.tsx` constructs xterm with `allowTransparency: true` and uses `applyTransparency(baseTheme, background.overlayDarken)` when a background image is active.
- `src/lib/terminalThemes.ts` currently makes transparent dark themes use `rgba(0,0,0,<floor>)`, while light themes use `rgba(255,255,255,<floor>)`.
- The existing TUI composer background cleanup is implemented in `normalizeTuiComposerBackground()` and mutates xterm buffer cell attributes after render/write.
- That cleanup is gated by `shouldNormalizeTuiComposerBackground()`, which currently returns `terminalBackgroundIsLightRef.current`.
- Therefore the cleanup runs for light terminal backgrounds only. It does not run in the dark terminal background-image case reported by issue #68.
- The cleanup is already scoped to visible TUI prompt rows by prompt signature and explicit background / wide inverse cells, which matches project guidance in `.trellis/spec/frontend/component-guidelines.md`.
- Follow-up screenshot after the first fix showed black strips on Codex hooks review/trust approval rows, not only the composer prompt. The affected text included `Hooks need review`, `Hooks can run outside the sandbox after you trust them.`, numbered review/trust options, and `Press enter to confirm or esc to go back`.

## Likely root cause

Claude/Codex TUI emits explicit background or wide inverse cell styling for composer/status rows. With a background image, those explicit cell backgrounds become visible as opaque black blocks. The previous light-theme fix clears those xterm buffer attributes, but the dark-theme path does not apply the cleanup.

The hooks approval screen uses the same kind of explicit background/wide inverse cell state outside the composer prompt area, so prompt-only scanning is insufficient.

## Candidate fixes

### A. Enable existing TUI background normalization whenever a terminal background image is active

- Change the gate from "light terminal background only" to "background image transparency active".
- Reuse the existing prompt-signature scan and cell-attribute mutation.
- Scope stays narrow because non-TUI lines without explicit background/wide inverse are skipped.
- Risk: true intentional TUI background blocks near Claude/Codex composer rows may become transparent.

### B. Lower dark-theme transparent cell alpha floor in `applyTransparency`

- Reduces default-cell darkness but does not remove explicit ANSI background cells.
- Low chance of fixing the black blocks because the issue is visible explicit cell backgrounds.

### C. Force Claude/Codex theme/startup options

- Similar to prior Codex theme attempts and provider-switching launch logic.
- Too tool-specific and does not cover Claude and Codex consistently.
- Avoid for this issue.

## Recommendation

Use approach A, with one constraint: keep the cleanup scoped to detected TUI composer/action rows and do not clear backgrounds globally. It is the smallest change and reuses the already accepted xterm buffer cleanup path instead of adding new ANSI rewriting or CLI-specific startup logic.

For action/approval rows, match known Codex/Claude-style menu and confirmation text, then still require explicit background or wide inverse attributes before mutating cells.

If issue #68 still reproduces after this targeted fix, evaluate WebGL fallback behavior for background-image mode as a separate change.
