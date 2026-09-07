# Technical Design: Grok Build Alt+Enter

## Boundary and Data Flow

```text
KeyboardEvent (xterm textarea)
  → XTermTerminal custom key handler
  → TerminalCliContext session/project/startup/title classification
  → newline byte selection (LF or ESC + CR)
  → TerminalProcessManager.write(sessionId, data)
  → PtyHostSocket.write
  → local / WSL / SSH PTY
  → Grok Build input parser
```

The defect is in the frontend classification-to-byte-selection step. The PTY transport is already byte-transparent and must remain unchanged.

## Change Design

1. Extend `TerminalCliContext.ts` with `isGrokTerminalContext()` beside the existing Codex classifier.
   - Treat normalized `grok`, `grokbuild`, and `Grok Build` tool values as Grok Build.
   - Match `grok`, `grok.cmd`, `grok.exe`, and `grok.ps1` as executable tokens in startup commands, including wrappers such as `wsl grok`.
   - Use the existing stable context fields only: `sessionTool`, `projectTool`, `titleTool`, and `startupCmd`.
   - Do not inspect arbitrary scrollback or persist a new runtime classification; no reliable Grok viewport signature is established by this task.
2. In `XTermTerminal.tsx`, retain the current managed-combination logic and settings behavior. When a matched combination is handled, choose `ESC + CR` if the session is Codex or Grok Build; otherwise keep `LF`.
   - Pass one captured context to both Codex and Grok checks so the key event uses one consistent session snapshot.
   - Continue calling `markAttentionInputHandled()` and `terminalProcessManager.write()` exactly once per matched keydown.
   - Keep unmatched managed combinations suppressed as they are today, and preserve xterm/native handling for un-managed combinations.
3. Extend `scripts/terminalNewlineShortcut.test.mjs` to execute the context classifier and assert source wiring for the key handler. This keeps the regression test lightweight without mounting a Tauri/xterm runtime.

## Contract and Compatibility

- `terminalNewlineShortcut` values and migration remain unchanged.
- `TerminalProcessManager.write(sessionId, data)` and the Rust PTY/daemon IPC contract remain unchanged.
- Existing Codex behavior remains `ESC + CR`; ordinary Shell and Claude remain `LF`.
- No new user-visible strings are introduced, so zh-CN/en-US translation parity is unchanged.

## Risk and Rollback

- Risk is limited to the terminal input component and shared CLI context classifier. GitNexus reports LOW impact and no HIGH/CRITICAL warning.
- The change is additive to Grok detection and changes only the bytes sent for matched newline shortcuts in recognized Grok sessions.
- Rollback is a two-file code revert plus test/spec/documentation reversion; no database migration or persisted-data rollback is needed.

## Verification

- Unit/source regression: `node --test scripts/terminalNewlineShortcut.test.mjs`.
- Type safety: `npx tsc --noEmit`.
- Full frontend regression: `node --test scripts/*.test.mjs` if the focused checks pass.
- Workspace hygiene: `git diff --check`.
- Before delivery/commit: GitNexus `detect_changes({ scope: "unstaged" })`, followed by review of affected flows.
