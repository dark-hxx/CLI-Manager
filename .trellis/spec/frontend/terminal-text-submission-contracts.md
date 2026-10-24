# Terminal Text Submission

## Scope

Programmatic command-template execution, from both the template panel and global
command palette. This is not physical keyboard input, clipboard handling, startup
command formatting, or Web/Tap input.

## API / Ownership

- `registerTerminalTextSubmissionTarget(sessionId, terminal)` returns
  `{ captureInput, dispose }`, owned by `attachInputForwarding`. `captureInput`
  runs first in `onData` and only consumes events during a programmatic submit;
  `dispose` is identity-safe.
- `submitTerminalText(sessionId, text)` calls native xterm `terminal.paste(text)`
  (skipped for empty text) then `terminal.input("\r", true)`, captures the
  resulting `onData` events and awaits exactly one process-manager write.
- Callers import `features/terminal/api/terminalTextSubmission`; never append CR
  to raw template text themselves.

## Contract

- Native xterm paste owns normalization, bracketed-paste framing and ESC
  sanitization; do not reimplement them. The submit CR stays **outside** the
  paste. Raw text + CR is treated as a paste burst by Codex and CR becomes a
  newline.
- Disabled stdin, missing target, reentrant submit or no captured `onData`
  rejects; never fall back to raw writes.
- No CLI-name tests, mode inference from hooks, sleeps, split-write timing
  assumptions, raw fallbacks or retries.
- Use exact session identity, not later global active-session state. An old
  attachment's dispose must not remove a newer attachment, even when the
  terminal object is reused.
- Missing targets reject with localized text. Transport errors propagate to the
  caller's existing error toast/logger. Never treat a write ACK as model response.
- Do not change manual Enter, IME, startup formatting or PTY wire protocols.

## Validation

`node --test scripts/terminalTextSubmission.test.mjs scripts/codexManualInput.test.mjs scripts/terminalProcessManager.test.mjs`

Test actual submission bytes, installed xterm normalization/sanitization,
Unicode/multiline/empty/large text, mode changes, exact split-session identity,
stale disposal, localized missing targets and write rejection without retries.
Supplement with TypeScript and independent strict architecture checks.

Non-model live reproduction: in an isolated Codex PTY at the ready composer,
raw `/quit\r` stays open until a separate CR; bracketed `/quit` followed by an
out-of-paste CR exits immediately. Do not send test prompts to live user sessions.
