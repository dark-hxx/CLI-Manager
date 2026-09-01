# Design: Grok composer newline encoding

## Decision

Extract a pure key-decision helper. Codex and Grok share `\x1b\r`. Unmatched Alt+Enter is passed through only for those sessions.

## Encoding

| Session | Matched shortcut | Unmatched Alt+Enter | Unmatched Shift/Ctrl+Enter |
|---|---|---|---|
| Codex / Grok | `\x1b\r` | pass (xterm emits `\x1b\r`) | swallow |
| Kimi / Shell / others | `\n` | swallow | swallow |

## Recognition

`isGrokTerminalContext` mirrors Codex: sessionTool, projectTool, titleTool, startupCmd (`grok` / `grokbuild` / `grok.exe` / `wsl grok`). Viewport `hasGrokTuiViewport` plus a component latch covers a grok TUI started inside an existing shell.

## Why not author-only `isGrok ? \x1b\r`

That would leave default Shift+Enter users with Alt+Enter still swallowed. The issue asks for Alt+Enter to insert a newline.

## Why not environment branches

Local vs SSH is a symptom of `\n` vs `\x1b\r`, not a transport bug.
