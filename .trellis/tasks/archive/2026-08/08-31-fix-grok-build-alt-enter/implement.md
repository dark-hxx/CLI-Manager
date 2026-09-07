# Implementation Plan: Grok Build Alt+Enter

## Ordered Checklist

1. [x] Review the final planning summary and start the existing `08-31-fix-grok-build-alt-enter` task with `task.py start`; do not edit product code before this gate.
2. [x] Load `trellis-before-dev` context and the relevant frontend component/type/quality guidelines.
3. [x] Add a focused `isGrokTerminalContext()` classifier in `src/terminal/browser/TerminalCliContext.ts`, reusing the existing context-field pattern.
4. [x] Update `XTermTerminal` newline encoding so recognized Grok Build sessions receive `ESC + CR`, while Codex, Shell, Claude, settings matching, and single Enter behavior retain their contracts.
5. [x] Extend `scripts/terminalNewlineShortcut.test.mjs` with Grok detection and key-handler wiring regressions.
6. [x] Update `.trellis/spec/frontend/component-guidelines.md` to document the Codex/Grok `ESC + CR` input contract.
7. [x] Run focused tests, TypeScript checks, full frontend tests when feasible, and `git diff --check`.
8. [x] Run GitNexus `detect_changes()` before any commit/delivery review and verify only the expected terminal/context/test/spec/documentation scope changed.
9. [x] Update `CHANGELOG.md` under version `V1.3.9` and `docs/功能清单.md` in the terminal-related feature section.

## Validation Commands

```powershell
node --test scripts/terminalNewlineShortcut.test.mjs
npx tsc --noEmit
node --test scripts/*.test.mjs
git diff --check
```

## Validation Notes

- The focused terminal regression and `npx tsc --noEmit` pass.
- The full `scripts/*.test.mjs` run was attempted; its failures are existing unrelated static-contract mismatches in agent capabilities, history conversation/detail, smart-title, and terminal remount tests. The changed terminal regression remains passing.
- `git diff --check` reports only the pre-existing conflict markers in `AGENTS.md` and `CLAUDE.md`; no whitespace errors occur in the task changes.

## Review Gates and Rollback Points

- Before code edits: task status must be `in_progress`; existing user conflicts in `AGENTS.md` and `CLAUDE.md` and the pre-existing task directory must remain untouched except for this task's planning artifacts.
- After context classifier change: verify Grok, `grokbuild`, wrapped startup command, title label, and ordinary Shell cases.
- After key-handler change: verify the exact data contract (`ESC + CR` for Grok/Codex, `LF` otherwise) and that the PTY writer is called once.
- Before delivery: inspect GitNexus change impact, TypeScript/test output, localized UI unchanged, and both mandatory release records.
- If regression appears: revert only the new Grok classifier/condition and test/spec/documentation changes; do not alter settings migrations or PTY transport.
