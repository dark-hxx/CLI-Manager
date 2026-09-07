# Design — macOS Fcitx5 IME duplicate input

## Boundary and Root Cause

The defect is entirely in the frontend terminal-input boundary:

```text
WKWebView textarea events
  ├─ input / beforeinput → native recovery (nativeTextInput)
  ├─ keydown(229) → xterm CompositionHelper deferred textarea diff
  └─ xterm onData → shared forwardTerminalInput → PTY write
```

On macOS, an IME may deliver `input` before `keydown(229)`. xterm can emit the just-delivered CJK text directly and later re-emit the same payload from its deferred process-key fallback. Both reach the app as `onData`. The existing 80 ms protection only drops identical payloads when their sources differ, so it cannot reject this same-source branch.

The installed xterm source is `6.1.0-beta.288`; its `CoreBrowserTerminal._inputEvent` and `CompositionHelper._handleAnyTextareaChanges` contain the two producer paths. The same macOS WKWebView ordering and duplicate shape are documented upstream in xterm.js issue #6045. No xterm upgrade or private monkey patch is selected because the issue reports the path remains present in current upstream code and private internals would broaden the regression surface.

## Chosen Design

Add a small, pure IME forwarding deduper under `src/lib/terminalImeInputDedup.ts` and integrate it at the one existing forwarding point.

### Controller contract

The controller owns the existing cross-source duplicate rule and a macOS-only process-key checkpoint:

- `shouldForward(data, source, now)` returns whether the PTY write may proceed and records accepted input.
- `noteImeProcessKey(now)` snapshots the immediately preceding CJK `onData` payload and begins tracking CJK `onData` payloads that follow the `keydown(229)` event.
- `resetForComposition()` clears the checkpoint when a new composition starts, so two intentional identical candidate commits are never merged across compositions.
- Existing cross-source handling remains unchanged: matching printable input from `nativeTextInput` and `onData` inside 80 ms is still forwarded once.
- The new same-source rule is enabled only for macOS and only for non-ASCII `onData` while a recent process-key checkpoint is valid. It drops an exact re-emission of either the pre-key payload or the accumulated post-key payload; normal identical input without that checkpoint remains valid.
- Checkpoints expire using the existing 400 ms IME process-key recovery horizon. This bounds stale state and does not create a persistent input-history filter.

### Integration

1. `useTerminalInput` creates the controller inside `attachInputForwarding` and replaces its local time-window check with `shouldForward`.
2. `TerminalInputForwardingController` exposes two lifecycle notifications: one for a macOS process key and one to reset on `compositionstart`.
3. `attachTerminalIme` accepts optional lifecycle callbacks and invokes them only after confirming the event originated from xterm's helper textarea. `XTermTerminal` remains the sole assembly point; no CLI-specific condition is introduced.
4. No bytes, IPC payloads, session state, storage, or Rust code change.

## Compatibility and Scenario Matrix

| Scenario | Expected behavior / decision |
| --- | --- |
| macOS + Fcitx5, normal shell | Same-source CJK repeat tied to `keydown(229)` is dropped once before PTY write. |
| macOS + Fcitx5, Codex / other CLI | Same shared behavior; no Codex-only branch. |
| Two identical Chinese commits | A new `compositionstart` resets the checkpoint, so both commits are accepted. |
| macOS punctuation and Shift symbols | Existing native-text recovery and cross-source dedupe are unchanged. |
| Windows/Linux, local/WSL/Bash | The new same-source checkpoint is not armed; existing paths are unchanged. |
| Split panes / multiple Workspans | Each mounted terminal owns its own controller closure; state cannot cross sessions. |
| Focus in another window, minimized/tray, sidebar/focus mode | No focused helper textarea event reaches this controller; no new behavior. |
| Worktree and CLI Hook state | Unrelated to browser input forwarding; no code path changes. |

## Alternatives Rejected

- **PTY-side de-duplication:** by that boundary, IME origin and `keydown(229)` context are lost; it could delete an intentional repeated command/input.
- **Codex-only guard:** user confirmed ordinary terminals reproduce the defect, and the producer is shared xterm input.
- **Patching xterm private internals / dependency upgrade:** upstream behavior is still present in the installed/current line; a private patch would couple the app to internal xterm implementation details.

## Discovery List

- [x] `src/lib/terminalIme.ts` — source of helper-textarea `keydown(229)` and composition events; needs lifecycle callback wiring.
- [x] `src/hooks/useTerminalInput.ts` — sole shared `forwardTerminalInput` → PTY boundary; needs controller integration.
- [x] `src/components/XTermTerminal.tsx` — only consumer/assembler of `useTerminalInput`; confirmed no behavior change needed beyond existing callback plumbing.
- [x] `node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts` and `CompositionHelper.ts` — inspected as external root-cause evidence; never edit vendored dependency.
- [x] `scripts/terminalImeComposition.test.mjs` — existing IME test pattern; keep and run unchanged.
- [x] `src/lib/terminalImeInputDedup.ts` — new pure, testable controller.
- [x] `scripts/terminalImeInputDedup.test.mjs` — new behavioral regression coverage.
- [x] `CHANGELOG.md` and `docs/功能清单.md` — finish-gate product records for `V1.3.8`.

## Risk and Rollback

Risk is medium because the target is a shared terminal hot path. The guard is constrained by platform, CJK payload, exact payload match, helper-textarea origin, a 229 checkpoint, and a bounded lifetime. Rollback is confined to removing the new controller and lifecycle calls; no persisted data or backend migration is involved.

GitNexus impact queries were attempted for the two target symbols and files, but the current MCP index cannot resolve either despite reporting the same commit as up to date. The discovery list therefore uses the permitted contract + source-search fallback; direct source search confirms `XTermTerminal` is the sole hook consumer.
