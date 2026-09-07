# Fix terminal clear during streaming output

## Goal

Make the terminal context-menu clear action work while a foreground process such as `tail -f -n300` owns the PTY, without stopping that process or regressing shell/TUI redraw and IME positioning.

## Changelog Target

`[TEMP]`

## Root Cause

The bug lives at the PTY-input/xterm-display boundary: the menu currently sends only Ctrl+L to the foreground process, but `tail -f` ignores that input, so no erase sequence ever reaches xterm. The fix must clear through xterm's parser path while retaining Ctrl+L for shells and TUIs that redraw themselves.

## Requirements

- Clear only the current terminal viewport; do not stop the foreground process or affect other sessions.
- Enqueue `\x1b[2J\x1b[H` through the existing terminal display write path so clearing does not depend on the foreground process interpreting Ctrl+L.
- Continue sending Ctrl+L after the local clear so idle shells and interactive TUIs can redraw their prompt or screen.
- Do not use `terminal.clear()`, which bypasses parser cursor events and previously left the IME helper textarea at stale geometry.
- Do not send ED3; existing scrollback remains available.
- Keep existing `zh-CN` and `en-US` menu text unchanged.

## Acceptance Criteria

- [ ] Right-click clear visibly clears a terminal running `tail -f -n300` while `tail` continues running.
- [ ] New log lines continue rendering from the cleared viewport.
- [ ] Idle PowerShell/Pwsh/CMD, Git Bash, WSL shells, and TUIs can redraw after clear.
- [ ] Clearing one split pane or session does not alter another terminal.
- [ ] Chinese IME input remains anchored correctly after clearing.
- [ ] Scrollback remains accessible.
- [ ] A regression test protects the local ANSI clear, Ctrl+L redraw, and prohibition on `terminal.clear()`.
- [ ] Targeted Node tests and `npx tsc --noEmit` pass.

## Technical Approach

Destructure the existing `enqueueActiveWrite` function from `useTerminalDisplay`. In `handleMenuClear`, enqueue the ANSI erase/home sequence before keeping the existing PTY Ctrl+L write. Add a source-contract regression test and update the terminal component guideline and changelog.

## Decision (ADR-lite)

**Context**: PTY input cannot guarantee that the foreground process implements shell clear semantics, while direct `terminal.clear()` caused IME geometry drift.

**Decision**: Use an in-band ANSI display clear through xterm's normal write parser, followed by the existing Ctrl+L PTY input.

**Consequences**: Streaming programs remain alive and the visible screen clears immediately; subsequent output naturally repopulates it. Scrollback is preserved, and no backend protocol change is needed.

## Discovery List

- `src/components/XTermTerminal.tsx`: modify `handleMenuClear` and consume `enqueueActiveWrite`; GitNexus upstream risk LOW.
- `src/hooks/useTerminalDisplay.ts`: existing write API reused; confirmed no implementation change required.
- `src/lib/terminalIme.ts`: confirmed parser cursor movement repins the helper textarea; no change required.
- PTY daemon/Rust backend: confirmed unrelated because no transport or process-lifecycle change is required.

## Out of Scope

- Stopping or restarting the foreground process.
- Clearing every terminal or deleting scrollback.
- Adding a keyboard shortcut or changing terminal context-menu text.
