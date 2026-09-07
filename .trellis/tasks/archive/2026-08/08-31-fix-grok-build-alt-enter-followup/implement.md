# Implementation Plan: Grok Build Alt+Enter follow-up

## Ordered Checklist

1. [x] After the user approves this follow-up planning summary, start the task with `task.py start`; do not edit product code before that gate.
2. [x] Re-run `trellis-before-dev` context for the terminal frontend package and verify the existing unresolved `AGENTS.md` / `CLAUDE.md` conflicts remain untouched.
3. [x] Run GitNexus upstream impact for every product symbol to be edited; stop and report if any result is HIGH or CRITICAL.
4. [x] Add and unit-test exact manual Grok command detection in `src/terminal/browser/TerminalCliContext.ts`.
5. [x] Extend `src/hooks/useTerminalInput.ts` command-submission forwarding without changing PTY write order or shell input-buffer semantics.
6. [x] Wire the callback and bounded runtime viewport gate into `src/components/XTermTerminal.tsx`; reset state on terminal/session lifecycle boundaries.
7. [x] Adopt the shared newline decision path so an unmatched native `Alt+Enter` is passed through for confirmed Grok/Codex sessions while other managed combinations retain their existing swallow behavior.
8. [x] Strengthen `scripts/terminalNewlineShortcut.test.mjs` to execute the command classifier and assert the command callback plus `ESC + CR` / `LF` routing path.
9. [x] Update `.trellis/spec/frontend/component-guidelines.md` and any required spec index; no `src/templates/markdown/spec` mirror exists in this checkout, so verify whether a generated mirror is applicable before creating one.
10. [x] Update `CHANGELOG.md` under `V1.3.9` and the terminal section of `docs/功能清单.md`.
11. [x] Run focused tests, `npx tsc --noEmit`, relevant frontend tests, `git diff --check`, and GitNexus `detect_changes()`; inspect that only expected files/symbols changed.
12. [ ] Complete with `trellis-check` and `trellis-finish-work`; report that the branch is 4 commits ahead of `origin/master` and contains pre-existing unresolved conflicts unless those conditions change with explicit user authorization.

## Planned Files

- `src/terminal/browser/TerminalCliContext.ts`
- `src/hooks/useTerminalInput.ts`
- `src/components/XTermTerminal.tsx`
- `src/terminal/browser/TerminalNewlineShortcut.ts`
- `src/lib/terminalTuiDisplay.ts` only if the existing current-viewport prompt helper needs a narrowly scoped reusable predicate
- `scripts/terminalNewlineShortcut.test.mjs`
- `.trellis/spec/frontend/component-guidelines.md`
- `CHANGELOG.md`
- `docs/功能清单.md`

## Validation Commands

```powershell
node --test scripts/terminalNewlineShortcut.test.mjs
npx tsc --noEmit
node --test scripts/*.test.mjs
git diff --check
```

GitNexus:

```text
impact({ target: "<edited symbol>", direction: "upstream" })
detect_changes({ scope: "unstaged" })
```

## Review Gates

- Stable configured Grok path remains unchanged.
- Manual `grok` path is recognized only from a submitted exact executable command.
- The manual fallback clears when the current viewport no longer shows the TUI prompt and never persists identity.
- Native `Alt + Enter` remains available to confirmed Grok/Codex sessions even when another host shortcut is selected.
- Ordinary Shell and Claude retain `LF`; Codex retains `ESC + CR`; bare Enter still submits.
- The PTY/IPC and settings contracts remain untouched.

## Validation Note

- Focused terminal regression tests: 33/33 passed.
- `npx tsc --noEmit` and `npm run build` passed.
- The full `node --test scripts/*.test.mjs` run still exits with seven unrelated pre-existing contract/snapshot failures (Agent capability diagnostics, history conversation/detail, smart-title IPC, and terminal remount snapshots); no failure was reported by the focused terminal suite.
- GUI/PTY manual smoke testing remains for a human on Windows PowerShell, WSL, SSH, and post-exit Shell recovery; the agent must not start the desktop app.
