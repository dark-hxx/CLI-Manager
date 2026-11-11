# Design

## Root Cause

The programmatic template-to-PTY boundary loses the distinction between pasted
content and submission: both UI entry points append CR to raw text. Codex's
unbracketed paste-burst detector therefore consumes that CR as a pasted newline.
Fix the programmatic input boundary, not physical Enter or transport timing.

## Evidence

On 2026-10-24 an independent PTY running installed Codex 0.164.0 enabled DECSET
2004. Writing `/quit\r` did not exit; a later independent CR did. Writing
`\x1b[200~/quit\x1b[201~\r` exited immediately. No model prompts were sent.

The exact installed-version upstream sources were inspected:
- openai/codex, tag rust-v0.164.0:
  codex-rs/tui/src/bottom_pane/paste_burst.rs
  codex-rs/tui/src/bottom_pane/chat_composer/paste_input.rs
- Installed xterm source: src/browser/Clipboard.ts, prepareTextForTerminal and
  bracketTextForPaste. Escape sanitization must match this dependency.

## Boundary

Add one narrow terminal API. Each mounted input controller registers its xterm
mode/options reader under its exact session ID and unregisters on disposal.
Submission snapshots the target, reads live bracketed-paste mode, normalizes
LF/CRLF to CR like xterm, sanitizes ESC inside bracketed content like xterm, and
writes content plus an out-of-paste CR in one acknowledged transport write.
Non-bracketed shells retain unframed text plus CR. Empty templates retain bare CR.
An unavailable target fails explicitly; no raw fallback, retry or artificial delay.
An old attachment's cleanup cannot remove its replacement.

## Discovery / Impact

GitNexus MCP unavailable; contracts and symbol searches used instead.
Risk: medium, two programmatic UI callers and the terminal input attachment;
no IPC, persistence, Rust, transport or physical keyboard behavior changes.

- [x] CommandTemplatePanel.handleRun: raw text + CR; migrate.
- [x] CommandPalette template action inside useMemo: same raw write; migrate.
- [x] useTerminalInput.attachInputForwarding: own target registration lifecycle.
- [x] TerminalProcessManager.write / PtyHostSocket.write: checked; unchanged.
- [x] codexManualInput / physical Enter / IME: checked; unchanged.
- [x] templateStore and variable substitution: checked; unchanged.
- [x] Startup commands and Web/Tap submission: different owners; unchanged.
- [x] CLI hooks/history routing: unrelated; submission uses exact PTY session ID.
- [x] xterm native paste()/input(): owns normalization/framing/ESC; tests run the installed Clipboard.ts.

## Scenario Coverage

| Dimension | Decision / validation |
| --- | --- |
| Codex / Claude / other TUI | Use negotiated paste mode, never CLI names or hook installation. |
| PowerShell / CMD / pwsh / Bash / WSL / SSH | Same PTY input protocol; disabled mode remains raw. Native non-macOS acceptance remains manual. |
| Single / multiline / Unicode / CRLF / empty / ESC | Deterministic byte-level tests against xterm reference. |
| Focus / other window / minimized / tray / focus mode | No DOM focus, global keyboard or focused-window lookup; exact session target. |
| Split / nested split / Workspan / session switching | Registry keyed by session ID; no delayed active-session re-resolution. |
| Expanded / collapsed / compact sidebar | Both mounted entry points migrate; external-terminal compact mode stays unchanged. |
| Main repo / Worktree / missing directory | No cwd or filesystem dependency; existing variable substitution retained. |
| Hooks present / absent / mixed | No hook dependency. |
| Unmount / reattach / disconnected PTY | Reject missing targets; identity-safe unregister; propagate write rejection without retry. |

## Rollback

Revert only this task's source/doc changes and rebuild the previous app. Do not
reset the checkout or discard unrelated user changes. Keep the running app and
user sessions intact until the user chooses to switch builds.
