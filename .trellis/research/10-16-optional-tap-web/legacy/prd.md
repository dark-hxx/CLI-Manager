# Optional Tap Web workspace

## Goal

Add a complete optional `/tap/` Web workspace to CLI-Manager, retaining Tap-Code's phone-first session navigation, native terminal, composition and read-only chat experience. Keep the classic Web available. The user approved the optional-client proposal and explicitly requested implementation with Trellis, interaction care and upstream boundary discipline.

## Requirements

- R1: Independent Vite/React client and UI at `/tap/`; classic `/` keeps working. Both ship in the same distribution and reuse the existing same-origin Cookie authentication and device authorization.
- R2: Select registered device/project/worktree, start a native project terminal, attach an existing terminal, switch sessions, send text and native keys, detach without terminating. Ending a process requires explicit confirmation.
- R3: Preserve IME composition; phone Enter inserts a newline, desktop Enter sends, modifiers can send; support Shift+Tab, one-shot Ctrl/Alt, repeating arrows, draft persistence scoped by user/device/session, mobile drawers and keyboard-aware input.
- R4: Preserve terminal replay sequence/reset/fragment boundaries and desktop size ownership. Disconnect never silently re-sends input. Switching devices or logging out clears subscriptions and sensitive transient content.
- R5: Show read-only native CLI messages and refresh while visible. Bind terminal-to-CLI IDs on the authoritative host; never guess by cwd/time or invoke structured conversation to send a PTY message. Expose unsupported/unbound history honestly.
- R6: Offer useful file/Git reads through existing operations, retain registered context IDs and existing write confirmation boundaries. New UI has zh-CN and en-US and light/dark/system modes.
- R7: Keep handwritten files below 2000 lines, share browser transport primitives rather than importing classic UI/application state, document source attribution and limitations, update TEMP changelog and feature inventory.

## Acceptance

1. Old Web, new Web, new deep links and new assets resolve correctly; missing new assets do not return the classic index. Installed/portable resources include both clients.
2. Real protocol tests cover owned device/context routing, native project start, ordered terminal output, stale-context rejection, logout/unauthorized and operation completion races.
3. New input tests cover Chinese composition, multiline bracketed paste, keyboard modifiers/repeat cancellation and preserving drafts on failed dispatch. No automatic retry of input of uncertain delivery.
4. Browser verification covers desktop and 390px phone layouts, drawers, input, themes/language, terminal/chat switching and connection errors against an isolated deterministic protocol host; real device/CLI limitations are recorded.
5. Affected TS builds, targeted Rust server/protocol checks and strict architecture checks pass, or exact platform/environment constraints are reported without claiming unrun checks passed.

## Boundaries

No replacement of existing authentication/DB/project state or PTY manager. No arbitrary browser cwd/commands, remote SSH fallback, injected hooks, bypassed native confirmations, or new independent agent host. Full Tap-only queue/Web Push/menu automation is deferred until the shared upstream host advertises those capabilities; do not show inert controls for them.
