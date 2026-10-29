# Issue #293 evidence (2026-10-29)

## Scope and evidence levels

- Issue: https://github.com/dark-hxx/CLI-Manager/issues/293 (open, no comments).
- Report: CLI-Manager V1.4.4 / Windows 11 / PowerShell; OMP version unspecified.
- Repository: master `e4b0c3d2`; installed xterm `6.1.0-beta.288`.
- No OMP executable was found on PATH. No live OMP/ConPTY reproduction was performed.
- Findings below distinguish local source, isolated installed-library experiments,
  current upstream source, and assertions still requiring a real terminal.

## Confirmed local input path

1. `src/features/terminal/hooks/useXTermController.ts:897` constructs xterm without
   `vtExtensions`; the mouse options spread only sets `mouseEventsRequireAlt`.
2. Installed `node_modules/@xterm/xterm/typings/xterm.d.ts:465` documents
   `kittyKeyboard` and `win32InputMode` as opt-in, both false by default.
3. `src/features/terminal/browser/TerminalNewlineShortcut.ts:21` handles modified
   Enter before native xterm encoding. A matching setting writes LF unless the
   caller classifies the TUI as Codex/Grok; unmatched managed chords are swallowed.
4. `src/features/terminal/hooks/useXTermController.ts:1323` invokes that helper,
   writes its result directly to the exact session PTY, and returns false. Thus
   adding `vtExtensions` alone would not change this Shift+Enter path.
5. `src/features/terminal/hooks/useXTermController.ts:1260` keeps the IME guard first.
6. `src/features/terminal/hooks/useTerminalInput.ts:794` forwards native `onData`
   to PTY, with a Codex-specific manual-Enter override. Its local input observer
   recognizes raw CR, printable text, paste and a few cursor sequences, not a
   complete enhanced keyboard protocol. Audit it before enabling raw Win32 keys.

## Confirmed scrolling path

- `src/shared/preferences/settingsStore.ts:210`, `:269`, `:330`: shortcut action,
  action list and defaults have bottom/page-up/page-down, but no top action.
- `src/features/terminal/hooks/useXTermController.ts:1392`: normal-buffer-only
  scrolling consumes recognized shortcuts; Ctrl+Home has no matching branch.
- `node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts:849`: the custom
  handler executes before native key evaluation. Returning false prevents native
  forwarding, so consuming a scroll shortcut here is the correct boundary.
- `node_modules/@xterm/xterm/src/common/services/CoreService.ts:82`: real user input
  requests scroll-to-bottom when `scrollOnUserInput` is true and viewport is away.
  The issue's bottom jump is consistent with this path. `_keyDown` is not an
  unconditional scroll-to-bottom before the custom handler.
- xterm normal-buffer scrollback is not an application's internal scroll model;
  alternate-screen applications must retain their own navigation.

## Isolated experiments using installed xterm (no app launch)

An in-memory Node experiment constructed real xterm objects, wrote negotiation
sequences through `terminal.write`, captured `onData`, and called the installed
keyboard service with a Shift+Enter event. Private access is a test probe only.

| Options | Kitty query reply | After `CSI > 1 u`, Shift+Enter | After `CSI ? 9001 h` |
| --- | --- | --- | --- |
| extensions false | none | CR (`\r`) | Win32 inactive; CR |
| both extensions true | `ESC [ ? 0 u` | `ESC [ 13 ; 2 u` | Win32 active; `ESC [ 13 ; 28 ; 13 ; 1 ; 16 ; 1 _` |

Important: enabling capability is not activating it. xterm selects native Win32
first when active, then negotiated Kitty, otherwise legacy. See installed
`src/browser/services/KeyboardService.ts:36`.

A second experiment enabled Kitty + Win32 on one real terminal, serialized it
using installed `@xterm/addon-serialize`, and wrote the result to a new terminal:

```text
original: kitty=true, win32=true
restored: kitty=false, win32=false
```

`node_modules/@xterm/addon-serialize/src/SerializeAddon.ts:558` serializes several
modes but not these keyboard modes. This is a release-blocking compatibility gap
if enhanced keyboards are enabled: reconnect/checkpoint/new mirror can lose the
negotiated encoding while the still-running process expects it.

## Query ownership, mirrors and snapshots

- `src/shared/lib/terminalQueryPolicy.ts:39` already suppresses Kitty queries,
  DECRQM and other replies on replay/mirror paths. Keep this single-owner rule.
- Desktop installs the policy at `useXTermController.ts:962`; hidden desktop
  terminals still parse output. Classic Web and Tap always deny query replies:
  `apps/web/src/WebTerminal.tsx:184`, `apps/web-tap/src/Terminal.tsx:139`.
- Both browser xterm constructors also lack keyboard extensions. Enabling only
  desktop would leave mirrored physical keyboard input on legacy encoding.
- Tap has a separate virtual key encoder in `apps/web-tap/src/input.ts:9`; its
  toolbar cannot be assumed to follow a new native xterm keyboard mode.
- `useXTermController.ts:1075` registers serialized snapshots/checkpoint uploads;
  `:1148` also serializes on cleanup. Both require a keyboard-state-aware wrapper.
- `src/features/terminal/api/sessionSnapshotPersistence.ts:39` provides a write
  barrier. Preserve it, exact session identity, throttling and existing wire DTOs.
- `src-tauri/src/infrastructure/pty/platform/windows.rs:380` already retains the
  ConPTY Win32-input compatibility flag. No Rust flag fix is indicated.

## Upstream OMP: evidence, not the reporter's pinned version

Source pinned for this investigation:
https://github.com/can1357/oh-my-pi/tree/b0756921ed231869ea92feef0056629a429d3fe1

- `packages/tui/src/terminal.ts:1643`: a Kitty reply means support; on ConPTY the
  application chooses flags 1 or 3 rather than alternate-key reporting. Source
  also contains Win32 fallback, modifyOtherKeys handling and shutdown resets.
- `packages/tui/src/keys.ts:549`: delegates matches/parse to native implementations.
- `packages/tui/src/components/editor.ts:2348`: current upstream explicitly has a
  bare-LF newline branch before plain-Enter submit. Therefore "OMP always submits
  LF" is NOT established by this investigation. Version, upstream keybindings,
  autocomplete/input focus and real ConPTY-delivered bytes remain to be checked.
- Native modifier-preserving encoding fixes a confirmed terminal capability gap;
  it is not yet proof of the reporter's exact submit failure being resolved.

## Discovery / impact tooling

- `.codegraph/` absent; CodeGraph skipped as instructed.
- GitNexus MCP unavailable. Ran CLI `analyze --index-only` because its index was
  stale; finished successfully without rewriting AGENTS/CLAUDE files.
- FTS extension unavailable. Symbol-name query/context/impact did not find the
  requested symbols; their UNKNOWN results are not a zero-blast-radius verdict.
- File-UID impact works; direction upstream, depth 3:

| File | Direct dependants | Total impacted files | Reported risk |
| --- | --- | --- | --- |
| useXTermController.ts | 2 | 6 | LOW |
| TerminalNewlineShortcut.ts | 1 | 5 | LOW |
| terminalQueryPolicy.ts | 5 | 32 | MEDIUM |
| settingsStore.ts | 105 | 345 | CRITICAL |
| sessionSnapshotPersistence.ts | 4 | 12 | LOW |

These are import/file results, not complete runtime call paths. The graph reported
no affected execution processes for these file nodes; this does not mean no UI
flow is affected. Re-run symbol/file impacts immediately before implementation.
Settings-file CRITICAL risk was reported to the user; limit edits to one additive
shortcut action/default/migration path, with no store refactor.

## Validation performed

```text
node --test scripts/terminalNewlineShortcut.test.mjs scripts/terminalComposerNewline.test.mjs scripts/terminalImeKeyGuard.test.mjs
33 tests passed; 0 failures
```

Existing passing tests intentionally assert LF for legacy Shell/Kimi; they lack
enhanced negotiation, mode restoration and scroll-to-top regression coverage.

## Implementation Evidence (2026-10-29)

The reviewed settings-first implementation is now present. Full results and
remaining live-acceptance limitations are in `../validation.md`:
151 focused terminal regressions, 120 Tap regressions, desktop/Web/Tap typechecks
and standalone normal/strict architecture checks pass.

Two pinned-library details changed the initial spike: Enter release requires
REPORT_ALL_KEYS as well as REPORT_EVENT_TYPES, and snapshots must preserve even
stale raw mainFlags/altFlags because redundant screen toggles swap them. Full
16-frame stacks and repeated checkpoints now have real-xterm regression tests.
Production only enables Kitty; adapter-only Win32 tests do not constitute native
ConPTY approval. OMP/Windows UI/WSL/SSH acceptance remains explicitly pending.

After authorized fast-forward to master `12115cc3`, both snapshot sites compose
keyboard restoration with upstream mouse tracking/encoding preservation. Review
found that 2000-line persistence trimming could drop keyboard stacks; preserving
only the bounded generated prefix fixes it without changing checkpoint DTOs.
Combined real-xterm normal/alternate tests and the production persistence flush
test retain full 16-frame stacks, content/cursor and mouse SGR state. Web clipboard
consumption also now suppresses orphan enhanced key releases after selection or
modifier changes and blur/refocus.
