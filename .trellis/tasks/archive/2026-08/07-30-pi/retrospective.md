## Bug Analysis: Pi Windows IME candidate window drifts right

> **Outcome: UNRESOLVED.** All synthetic regressions pass, but Windows Pi manual verification still reproduces the second-composition drift. The causes below are investigated hypotheses and partial contracts, not a confirmed end-to-end root cause.

### 1. Root Cause Category

- **Category**: D - Test Coverage Gap; E - Implicit Assumption
- **Specific Cause**: Not yet confirmed end to end. The attempted fixes cover Process-key timing, Pi inverse-cursor priority, and post-render anchor refresh, but the real Windows native IME/xterm/Pi sequence still produces a right-edge second composition.

### 2. Why Fixes Failed

1. Pi viewport parsing: It improved static anchor selection but did not control when the native IME reads that anchor.
2. Resize and composition re-pinning: It verified the eventual DOM geometry, not the geometry at the Process-key boundary where Windows creates the candidate window.
3. Static buffer fixtures: They did not instantiate `attachTerminalIme` or dispatch the real capture-phase event order, so the timing gap remained invisible.
4. Process-key-only correction: It synchronized the resolver earlier, but the resolver itself still preferred a stale hardware cursor whenever that cursor remained inside the editor. The visible inverse cursor was never consulted, so both the composition position and its remaining width stayed wrong.
5. Static software-cursor priority: It handled a stable Pi frame but still assumed the anchor captured at `compositionstart` remained valid. Consecutive input can start before Pi finishes rendering the previous committed candidate, so the second composition freezes a transient right-edge anchor and ignores the later correct render.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|----------|-----------|-----------------|--------|
| P0 | Test Coverage | Instantiate the IME controller, simulate xterm writing the helper textarea to the right, dispatch keyCode 229, and assert synchronous restoration before any RAF or timeout. | DONE |
| P0 | Test Coverage | Model a stale right-edge hardware cursor and a left-side inverse software cursor inside the same Pi editor, then assert software-cursor priority. | DONE |
| P0 | Test Coverage | Model consecutive compositions where the second starts at the right edge, then assert a later Pi render refreshes both `left` and `maxWidth` to the visible cursor. | DONE |
| P0 | Documentation | Record the Process-key-before-compositionstart geometry contract in the frontend component guidelines. | DONE |
| P1 | Code Review | For native IME bugs, review the browser/xterm/native event boundary instead of validating only final buffer coordinates. | DONE |

### 4. Systematic Expansion

- **Similar Issues**: Any CLI-specific resolver can fail if xterm rewrites the helper textarea immediately before a Windows IME session, even when its static anchor algorithm is correct.
- **Design Improvement**: Keep one resolver pipeline and invoke it synchronously at the earliest observable Process-key boundary; do not add CLI-specific timers.
- **Process Improvement**: Regression tests for native input positioning must assert event order and immediate DOM state, not only eventual resize/composition state.

### 5. Knowledge Capture

- [x] Updated `.trellis/spec/frontend/component-guidelines.md`.
- [x] Added an executable Process-key event regression.
- [x] Updated task PRD, design/implementation records, Changelog, and feature inventory.
- [x] Confirmed `src/templates/markdown/spec/` does not exist, so no template sync applies.
- [x] Marked the task and release notes as unresolved.
- [x] Commit the diagnostic implementation and regression record as explicitly requested by the user.
