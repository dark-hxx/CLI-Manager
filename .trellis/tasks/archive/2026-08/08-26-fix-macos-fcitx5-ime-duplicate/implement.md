# Implementation Plan — macOS Fcitx5 IME duplicate input

## Ordered Work

1. Load `trellis-before-dev` and the terminal/frontend guidelines before changing source.
2. Add `src/lib/terminalImeInputDedup.ts` with the pure input-source type and controller contract from `design.md`.
   - Preserve the existing 80 ms cross-source rule.
   - Add only the macOS-controlled same-source CJK process-key checkpoint rule.
   - Bound checkpoint lifetime to 400 ms and reset it on a new composition.
3. Update `src/hooks/useTerminalInput.ts` to use the controller at `forwardTerminalInput` and to expose process-key/composition notifications on its forwarding controller.
4. Update `src/lib/terminalIme.ts` to notify the forwarding controller from the already-validated helper-textarea `keydown(229)` and `compositionstart` handlers.
5. Add `scripts/terminalImeInputDedup.test.mjs` covering:
   - unchanged cross-source deduplication;
   - same-source CJK duplication after input-before-229;
   - deferred multi-character post-key payload re-emission;
   - intentional identical commits separated by a new composition;
   - expiration / non-mac checkpoint disabled behavior.
6. Run focused tests, then `npx tsc --noEmit`. Review the diff for unchanged nonterminal code.
7. Update `CHANGELOG.md` and `docs/功能清单.md` under `V1.3.8`; run the full Trellis quality check and `detect_changes()` fallback review before handoff.

## Execution Record

- [x] Added the pure deduper and wired it through the shared terminal forwarding and IME lifecycle boundaries.
- [x] Added deterministic source-order regression coverage and ran it with the existing composition tests.
- [x] Ran `npx tsc --noEmit`.
- [x] Recorded the change in the V1.3.8 changelog and feature list.
- [x] Complete Trellis quality review and changed-symbol scope review before handoff (focused tests, TypeScript, production build, and GitNexus low-risk review).

## Validation

```powershell
node --test scripts/terminalImeInputDedup.test.mjs scripts/terminalImeComposition.test.mjs
npx tsc --noEmit
```

Manual macOS validation:

1. In a plain shell terminal, use Fcitx5 to commit Chinese candidates slowly and rapidly; test intentional repeated text such as `你你`.
2. Repeat in Codex and another CLI terminal; neither may duplicate one candidate commit.
3. Test Chinese/full-width punctuation, Shift symbols, ASCII input, Backspace, Enter, and paste.
4. Repeat in two split panes and after switching tabs to confirm no state crosses terminal sessions.

The user currently has no macOS + Fcitx5 environment. These manual checks are explicitly deferred; the handoff must report that limitation and must not claim device validation passed.

## Rollback Point

All behavior changes are in the new pure controller and its two frontend lifecycle calls. Reverting those files restores the previous forwarding behavior without a database, IPC, or migration rollback.
