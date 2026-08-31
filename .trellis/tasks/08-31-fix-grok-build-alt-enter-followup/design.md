# Technical Design: Grok Build Alt+Enter follow-up

## Root Cause and Boundary

```text
typed `grok` + Enter
  → useTerminalInput input buffer observes the submitted command
  → XTermTerminal keeps component-local manual Grok runtime state
  → current viewport TUI prompt validates that Grok is still the active UI
  → custom Enter handler selects ESC + CR
  → TerminalProcessManager.write(sessionId, data)
  → existing PtyHostSocket / local, WSL, SSH PTY
```

The previous fix corrected the final byte choice for stable Grok metadata but did not provide identity for a CLI launched later inside a plain Shell, and the host handler still swallowed native Alt+Enter when another shortcut was selected. The smallest complete boundary is therefore the existing input-buffer submission callback, the existing xterm viewport inspection, and a pure host-key decision helper. PTY transport remains unchanged.

## Design Decisions

1. Add a pure `isGrokLaunchCommand(command)` predicate next to the terminal CLI context helpers.
   - Recognize a command whose executable token is `grok`, `grok.cmd`, `grok.exe`, or `grok.ps1`, including a quoted/path-qualified executable and normal arguments.
   - Do not classify arbitrary text containing `grok`, `echo grok`, or `grok-helper`.
   - Keep the broader startup-command classifier unchanged for configured sessions, because startup wrappers such as WSL are already represented by stable metadata.
2. Extend `TerminalInputForwardingOptions` with an optional command-submission callback.
   - Invoke it only for the existing `data === "\r"` submission path, using the input buffer captured before it is cleared.
   - Preserve PTY write ordering, shell cwd detection, suggestions, IME deduplication, and all existing input callbacks.
3. In `XTermTerminal`, maintain a `grokSessionDetectedRef` scoped to the mounted terminal component.
   - The callback sets the ref only after `isGrokLaunchCommand` returns true.
   - The newline resolver considers stable Grok metadata first; manual runtime evidence is accepted only when the current xterm viewport still contains a TUI composer prompt (`hasTuiComposerPromptViewport`).
   - If the viewport no longer contains that prompt, clear the manual ref. This prevents a Grok launch from permanently changing a later ordinary Shell after Grok exits, while keeping the state out of persisted sessions.
   - Reset the ref with the same terminal/session lifecycle effect that resets Codex runtime detection, and when the PTY/session is detached or exits.
4. Keep the managed-key policy unchanged except for the CLI-owned native shortcut.
   - The user-selected shortcut remains authoritative for host-generated writes.
   - For a matched combination, Codex or Grok uses `ESC + CR`; other terminals use the existing `LF` path.
   - When Codex or Grok owns the native `Alt + Enter`, an unmatched Alt+Enter is passed through to xterm so the CLI can emit `ESC + CR`; unmatched Shift/Ctrl+Enter and all other terminals remain suppressed by the host policy.

## Compatibility and Safety

- No new persistence field, IPC command, Rust change, or dependency.
- Current viewport is the only runtime UI evidence; scrollback/history must not establish Grok identity.
- Manual command evidence is session-component-local and must never update `TerminalSession.cliTool`.
- A configured Grok session remains recognized even if its prompt is temporarily not visible; only the manual fallback is viewport-gated.
- Ordinary Shell behavior stays `LF` after an unrelated command or after the manual Grok UI disappears.
- No user-facing text is added, so the existing zh-CN/en-US/i18n contract is unchanged.

## Test Strategy

- Export and test `isGrokLaunchCommand` with positive direct/path-qualified/argument cases and negative `echo`, helper-name, and empty cases.
- Add a pure newline-routing helper or equivalent testable decision path so tests assert `ESC + CR` for the manual runtime state only while the TUI prompt is visible, and `LF` after it disappears.
- Assert the actual input-forwarding callback is invoked with the pre-clear command and the component registers it for the same session.
- Retain configured Grok, Codex, ordinary Shell, Claude, and shortcut-matching regressions.
- Run focused tests, TypeScript checking, the existing frontend test suite when feasible, `git diff --check`, and GitNexus change detection before delivery.

## Rollback

Rollback is limited to the follow-up input callback, manual classifier/runtime ref, their regression tests, and the associated spec/release records. Existing stable Grok/Codex handling and PTY transport do not need rollback.
