# Implementation Plan: Issue #293 / V1.4.5

Status: implementation complete; automated checks passing, live/manual acceptance
pending. The user approved the revised mapping design and task.py start was run.
Main session implemented and checked inline, without sub-agents. See validation.md.

## Gate 0: Review and Reproduction

- [x] Resolve ownership: the configured application newline shortcut wins.
- [x] Review revised design section 3.2; converge PRD without discarding evidence anchors.
- [x] Read trellis-before-dev and relevant frontend/terminal contracts.
- [x] Repeat read-only branch/upstream and worktree checks; preserve the existing
      unrelated deletion in the archived task.
- [x] Re-run GitNexus symbol impacts before editing; use file-UID impacts plus
      contract/reference tracing if symbol lookup remains unavailable. Report
      HIGH/CRITICAL findings. Do not interpret UNKNOWN as no impact.
- [ ] In an isolated Windows 11 PowerShell OMP session, record exact OMP version,
      default/custom keybindings and focused editor/autocomplete state. Capture
      only key-event/escaped-control-byte diagnostics, never prompt content.
- [ ] Confirm the old behavior; compare direct raw LF, native negotiated Shift+Enter
      and actual ConPTY-delivered bytes. Do not send prompts to live user sessions.

## Gate 1: Protocol Spike Before Broad Integration

- [x] Real installed-xterm tests: default opt-out, Kitty query/reply/push/pop,
      Win32 request/reset and encoder priority, Shift/Ctrl/Alt+Enter, Enter,
      repeat/release, normal/alternate buffers and exit to Shell.
- [x] Prove the native encoder adapter maps all three setting choices to a verified
      semantic newline target, not their unmodified physical bytes. Cover paired
      release/repeat and a settings/modifier change while Enter is held.
- [x] Demonstrate lossless keyboard state round-trip including inactive-buffer
      state and nested stacks; preserve content/cursor/viewport and barriers.
- [x] Demonstrate query reply ownership: startup allowance, repeated replay,
      reconnect, hidden desktop owner, classic Web/Tap mirrors, late mirror joins.
- [x] Record capability scope actually proven, including Win32. Return to design
      if lossless restore or native ConPTY forwarding cannot be demonstrated.

## Slice A: Scroll-To-Top (independently testable)

- [x] Add only ShortcutAction/action-list/default and existing settings label map.
- [x] Add zh-CN/en-US strings in the owning domain dictionaries.
- [x] Use existing settings migration; test missing old key, saved custom value,
      explicit disabled value and reset-to-defaults/conflict recording.
- [x] Extract a focused scroll decision helper if needed; normal buffer consumes
      top/bottom/page shortcuts with zero PTY bytes. Alternate buffer passes keys.
- [x] Preserve `scrollOnUserInput`; verify typing after local scroll returns to prompt.

## Slice B: Keyboard Routing and Lifecycle

- [x] Add narrow shared capability/mode adapter and keyboard-aware serializer.
- [x] Integrate desktop routing under the approved ownership semantics; IME first,
      preserve legacy Codex/Grok/LF behavior and exact session targeting.
- [x] Normalize a semantic target event for the installed native encoder without
      DOM redispatch, raw protocol reimplementation or a silent LF fallback.
- [x] Preserve unmatched managed-chord swallow/pass exceptions. Test that the
      original physical event cannot produce a second newline or submission.
- [x] Pair application-owned keydown consumption with appropriate keyup/repeat
      handling; clear per-terminal tracking on release/blur/dispose.
- [x] Audit input buffer/selection/attention/manual Codex observers; encoded keys,
      protocol replies and releases must not become user command text/submission.
- [x] Replace both checkpoint/write-barrier and cleanup serialization call sites
      with the same lossless wrapper. Preserve old snapshots and existing DTOs.
- [x] Compose with upstream mouse-state serialization; retain the bounded keyboard
      prefix across 2000-line persisted tails. Test real-library combined restore
      and the full persistence flush pipeline with 16-frame stacks and later pops.
- [x] Enable matching parsing/encoding on classic Web/Tap; keep query suppression.
- [x] Verify/adapt Tap native virtual keys without changing chat-composer paste/send.
- [x] Keep settings/help accurate in both languages: never label the configured
      newline shortcut as legacy-only or silently ignore it after negotiation.

## Validation Commands

Existing focused baseline (already 33/33 pass during planning):

```powershell
node --test scripts/terminalNewlineShortcut.test.mjs scripts/terminalComposerNewline.test.mjs scripts/terminalImeKeyGuard.test.mjs
```

Affected integration regression commands after implementation:

```powershell
node --test scripts/terminalReplay.test.mjs scripts/terminalTextSubmission.test.mjs scripts/codexManualInput.test.mjs scripts/terminalProcessManager.test.mjs
npx tsc --noEmit
npm run web:typecheck
npm run tap:typecheck
npm run tap:test
npm run check:architecture
npm run check:architecture -- --strict
```

Add and explicitly run new protocol/snapshot/scroll/settings tests using this
repository's `node:test` + transpile/real-installed-xterm conventions. File names
will be chosen with the owning helpers; do not claim nonexistent tests passed.
No Rust change is expected; run targeted Cargo checks only if that scope changes.

## Manual Acceptance and Finish Gate

- [ ] For EACH configured shortcut (Shift+Enter, Ctrl+Enter, Alt+Enter), OMP input
      `line 1`, chosen shortcut, `line 2`: newline only; Enter submits once.
- [ ] Test unmatched managed chords and supported OMP keybinding customization;
      identify unsupported plugin/TUI conflicts instead of claiming universal override.
- [ ] Ctrl+Home reaches earliest retained normal-buffer output; Ctrl+End returns
      bottom; alternate-screen editors retain their own Home navigation.
- [ ] Chinese IME candidate-confirmation Enter never submits prematurely.
- [ ] PowerShell/Pwsh/CMD + WSL + SSH; Codex/Grok/Claude/Pi/Shell compatibility.
- [ ] Split panes/nested panes, Workspans, hidden terminals, other windows, tray.
- [ ] Reconnect, daemon live-session reattach, checkpoint reset, old snapshots,
      late Web/Tap attach and TUI alternate-overlay return.
- [ ] Switch Settings -> General -> UI Language between zh-CN/en-US; verify new
      labels/help and unchanged 24-hour formatting. Record manual-only results.
- [x] Update CHANGELOG.md under V1.4.5 and docs/功能清单.md in terminal/shortcut
      sections after actual implementation. Do not bump package versions merely
      because the changelog target version was specified.
- [x] Run Trellis quality check inline, inspect expected diff only, run GitNexus
      detect-changes before any explicitly authorized commit.
- [x] User authorized fetching/merging remote master and commit/push after checks.
      Fast-forwarded four upstream commits to `12115cc3`; resolved the two snapshot
      call-site conflicts by composing serializers, preserving upstream fixes.
- [x] Commit verified task paths only as `3ba3d707`; exclude the unrelated archived
      cc-plan.json deletion. Push is authorized after session recording; do not
      close #293 or archive acceptance as passed before human verification.

## Rollback Points

- Slice A can ship alone if B's compatibility gate fails; #293 remains partially open.
- Slice B capability, routing and state-serialization changes are atomic as a
  release unit. Do not ship capability activation without snapshot restoration.
- Do not overwrite settings, alter IPC/daemon/DB protocol, add unproven timing
  workarounds, or restart/kill user sessions as part of rollback.

## Remaining Acceptance Boundary

The isolated real-library gates pass, including adapter-only Win32 tests. No
real OMP executable is on PATH and no CLI-Manager app/service was launched under
the frontend quality rule. Therefore OMP/ConPTY delivery and human UI/session,
WSL/SSH, custom TUI bindings and language-switch checks above remain unchecked.
Win32 capability is not shipped; no claim of native Win32 compatibility is made.
The task stays in_progress for acceptance; commit/push is authorized, but archival
must not imply the outstanding human acceptance has passed.
