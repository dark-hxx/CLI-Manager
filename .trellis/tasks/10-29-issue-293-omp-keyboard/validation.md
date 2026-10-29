# V1.4.5 Implementation / Verification

## Delivery State

Implementation and inline automated quality review completed on 2026-10-29.
Task remains in_progress pending real OMP/ConPTY and UI acceptance. The user
explicitly authorized fetch/merge of remote master and commit/push after checks.
No archive, app/service launch, dependency upgrade, release version bump or IPC/DB
change was performed.

Branch baseline: master fast-forwarded four upstream commits to `12115cc3`,
0 ahead / 0 behind fetched origin/master before the task commit. The
pre-existing deletion of archived-task cc-plan.json is unrelated and untouched.
Both stash-apply conflicts were in snapshot call sites and were resolved by
composing keyboard and upstream mouse serializers. Upstream checkpoint-identity,
live daemon attach and replay changes remain intact.

## Implemented Touchpoints

| Touchpoint | Result |
| --- | --- |
| Shared keyboard adapter | Pinned/runtime-checked native encoder; actual mode, cloned screen flags/stacks; Kitty enabled, production Win32 disabled |
| Desktop key routing | All three chosen newline chords map to Shift+Enter under Kitty for LF-style composers; legacy LF and Codex/Grok ESC+CR stay explicit |
| Lifecycle | Physical press/repeat/release pairing; settings/modifier changes, blur/refocus tombstones, mode/reset drops, release before onData teardown |
| IME/application shortcuts | Guard before remap; candidate-confirmation Enter/Process/229 protection; consumed original keypress/keyup suppressed, including window-capture consumption |
| Input observers | Native structured bytes use exact-session onData; ESC payloads bypass replacement/dedup/command-submission handling; legacy direct writes retained to avoid LF replacing selected input |
| Serialization | Both snapshot sites compose keyboard/mouse preservation; existing write barrier/checkpoint DTO preserved; raw saved flags, active flags, both full 16-frame stacks survive normal/alternate/repeated roundtrips, including 2000-line persisted tails |
| Query policy | Existing owner/startup/replay policy unchanged; real xterm tests verify mirror/replay queries never reply while setters still parse |
| Web / Tap | Kitty parsing enabled consistently; Web clipboard-consumed press/release remains paired through selection/modifier changes and refocus; Tap virtual strokes use native encoder; composer/template submission unchanged; desktop newline preference is not a browser wire field |
| Scroll-to-top | New action/default/settings label, Ctrl+Home; custom/disabled values survive existing migration; normal buffer only, zero PTY data |
| Records / prevention | V1.4.5 changelog, feature inventory and terminal-keyboard code contract updated |

## Automated Results

All commands below passed:

```powershell
node --test --test-concurrency=1 scripts/terminalKeyboardProtocol.test.mjs scripts/terminalKeyRouting.test.mjs scripts/terminalKeyboardMirrors.test.mjs scripts/terminalKeyboardSnapshot.test.mjs scripts/terminalScrollShortcuts.test.mjs scripts/terminalNewlineShortcut.test.mjs scripts/terminalComposerNewline.test.mjs scripts/terminalImeKeyGuard.test.mjs scripts/terminalReplay.test.mjs scripts/terminalTextSubmission.test.mjs scripts/codexManualInput.test.mjs scripts/terminalProcessManager.test.mjs scripts/terminalSnapshotMouse.test.mjs scripts/terminalSnapshotPersistence.test.mjs
# 151 passed, 0 failed
npm run tap:test
# 120 passed, 0 failed
npx tsc --noEmit
npm run web:typecheck
npm run tap:typecheck
# all exit 0
npm run check:architecture
npm run check:architecture -- --strict
# 1447 source files, 0 over 2000 lines, 0 violations
git diff --check
# exit 0
```

No lint script exists in the root package. No Rust files changed; no Cargo build
or test is claimed. Current controller/settings store are 1874/1942 lines.
Commands ran sequentially to limit resource load; terminal test files also used
test-concurrency=1. No frontend production build was needed or launched.

GitNexus symbol lookup remained unavailable; file-UID impacts were used and the
settings CRITICAL warning was reported before implementation. Additional setting
UI/Web/Tap file impacts were LOW (1/1/2 direct dependants). detect-changes returned
"No changes detected" despite the visible diff, so it is NOT evidence of a clean
or zero-impact change. Direct diff/source review and executable tests are the
quality evidence. The final `--scope staged` retry also returned the same false
empty result; all staged paths and diffs were reviewed directly. The only
unstaged path is the pre-existing unrelated archived-task deletion.

## Explicit Manual Gaps

OMP is not installed on PATH. No exact reporter-version reproduction or live
ConPTY byte capture was performed, and no CLI-Manager UI/service was launched.
The upstream pinned evidence supports Shift+Enter and also accepts raw LF;
therefore do not claim that OMP always submits LF or close #293 from unit tests.

Human acceptance still required:

1. Record OMP version/keybindings. For EACH Shift+Enter/Ctrl+Enter/Alt+Enter setting,
   type line 1, chosen shortcut, line 2: newline only; ordinary Enter submits once.
   Test unmatched chords and any customized OMP/plugin bindings explicitly.
2. Ctrl+Home reaches earliest retained normal history; Ctrl+End returns bottom;
   alternate-screen navigation stays in the TUI. Test custom/disabled shortcuts.
3. Chinese IME candidate confirmation, held keys, settings changes while held,
   window blur/refocus and terminal unmount/reconnect do not duplicate input.
4. Local PowerShell/Pwsh/CMD, WSL/SSH, split/nested panes, Workspans, other/hidden
   windows, tray, hook on/off and worktrees. Confirm Codex/Grok compatibility.
5. Live daemon reattach, checkpoint/reconnect, old snapshots, late Web/Tap attach,
   alternate overlays and exit back to shell. Win32 is not enabled in production.
6. Switch Settings -> General -> UI Language zh-CN/en-US; inspect new labels/help
   and unchanged 24-hour time. Dictionary/static tests are not UI-switch evidence.

## Root-Cause / Prevention Review

- Categories B/E/D: terminal capability/shortcut ownership contract was implicit,
  modifier intent was replaced before native encoding, and tests covered only
  legacy bytes. Ctrl+Home lacked an application scroll action.
- A capability-only fix would still lose settings intent. A flags-only snapshot
  suffix loses inactive stacks; even redundant xterm screen switches use raw saved
  flags. The first snapshot spike exposed this and was corrected before wiring.
- Enter release with flags 3 is intentionally empty: native xterm requires flags
  8 plus event reporting for Enter/Tab/Backspace release. Tests follow the native
  behavior rather than inventing a protocol sequence.
- Review also caught legacy LF selection replacement via onData and blur/refocus
  orphan releases. Direct legacy writes and tombstones preserve those boundaries.
- Post-merge review caught loss of keyboard prefix under the existing tail-line
  trim. Preserve only the bounded generated prefix verbatim before painting;
  never append its screen toggles after alternate content. Real-xterm tests and
  the actual flush pipeline cover full 16-frame stacks and subsequent pops.
- Real-library adapter/stack/lifecycle/mirror tests and the new frontend contract
  now pin these non-obvious behaviors for dependency upgrades and future fixes.

## Rollback

Keyboard capability, semantic routing and serialization are one rollback unit;
never ship only capability activation. Scroll-to-top remains separable. Preserve
user settings and live PTYs; do not kill sessions or alter transport/DB schemas.
