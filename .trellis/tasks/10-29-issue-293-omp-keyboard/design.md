# V1.4.5: OMP keyboard and terminal scroll-to-top

Status: revised settings-first mapping approved by the user; implementation in
progress. Evidence is in
`research/findings.md`; source anchors there are authoritative.

## 1. Root-Cause Statements

### Modified Enter

The terminal/browser-to-PTY boundary discards modifier intent: enhanced keyboard
capabilities are disabled, and the application consumes modified Enter before
native encoding and substitutes a generic LF for non-Codex/Grok sessions. Fix the
capability/shortcut-routing boundary, not OMP prompts, backend newline replacement,
timers, or shell-specific retries.

Qualification: the exact path from LF to the reporter's OMP submission is not yet
reproduced. Current upstream handles bare LF as newline in its editor. Capture
the reporter's OMP version/keybindings and real delivered bytes during the first
implementation spike; do not claim the issue fixed from source inspection alone.

### Ctrl+Home

The application lacks a normal-buffer scroll-to-top action, so Ctrl+Home reaches
xterm as input and can trigger the existing user-input scroll-to-bottom behavior.
Consume the scroll shortcut before native input encoding; do not globally disable
the useful "typing returns to prompt" behavior to hide a missing shortcut.

## 2. Proposed Boundaries

| Boundary | Responsibility |
| --- | --- |
| shared terminal keyboard adapter | Common capability options, effective negotiated-mode reads, native event encoding and keyboard-state snapshot support |
| desktop terminal key handler | IME first; application-owned actions; protocol-aware modified-Enter routing |
| xterm | Protocol queries/setters, native modifier/repeat/release encoding, mode stacks |
| shared query policy | Exactly one existing query-reply owner; mirror/replay suppression |
| settings + settings UI | Additive configurable scroll-to-top, legacy shortcut compatibility and bilingual copy |
| Web / Tap native terminal | Same capability parsing and native encoding; no duplicate replies |
| Tap virtual keys | Explicitly verify/adapt to negotiated modes; do not assume native DOM routing covers them |
| Rust PTY / transport | Preserve bytes, session identity and existing protocol; no proposed wire/DB/schema changes |

The shared helper must not import a feature or aggregate UI/state. Keep helpers
cohesive, avoid broad barrels, and keep handwritten files under 2000 lines.
Current `settingsStore.ts` is 1939 lines and `useXTermController.ts` is 1862 lines;
put new protocol logic in a small helper, not additional large inline branches.

## 3. Enhanced Keyboard Design

### 3.1 Capability is not negotiated state

Enable Kitty support and evaluate Win32 support on the installed pinned xterm
without a dependency upgrade. Do not manually force `CSI > 1 u` / `?9001h` into a
process: the program selects the mode; xterm encodes it. Win32 must pass the
native Windows and mirror/virtual-input tests before it is enabled for release.
If it cannot pass, narrow the shipped capability explicitly rather than silently
falling back or claiming complete Win32 support.

Use a shared capability factory for desktop, classic Web and Tap. Preserve existing
options by merging unrelated VT extensions instead of replacing their object.

The effective mode is `win32 | kitty | legacy`, reflecting xterm's actual encoder
priority, NOT `vtExtensions` booleans, CLI-name/title detection or a remembered
query. Kitty flags can be pushed/popped per buffer and must follow live xterm state.

The pinned public API exposes Win32 mode but not full Kitty state or a semantic
keypress encoder. A small typed internal adapter that reads negotiated state and
calls xterm's native keyboard evaluator is an explicit compatibility boundary;
pin it with real-library tests and fail its compatibility gate on shape changes.
Do not scatter `_core` access, mutate xterm's protocol state to force a key, or
implement a second independent protocol parser/keyboard encoder.

### 3.2 Modified-Enter ownership (settings first, user required)

The application setting is authoritative for the physical newline shortcut in
both legacy and enhanced modes. The previous native-pass-through-only proposal
is superseded: it would not meet the user's explicit acceptance criterion.

```text
IME composing / Process / keyCode 229
  -> existing IME guard, before all shortcut or protocol handling
other application-owned shortcut
  -> consume locally, including corresponding enhanced release events
modified Enter matching the configured newline shortcut
  -> consume original chord; resolve semantic newline target for this session
  -> legacy: preserve existing Codex/Grok Esc+CR / other LF compatibility
  -> enhanced: native xterm encoder encodes a normalized target key event
  -> forward once to the exact terminal session, with paired repeat/release
other managed modified Enter
  -> preserve existing swallow/pass policy, not unconditional native forwarding
other events
  -> existing routing / xterm
```

Do not synthesize raw Win32 INPUT_RECORD sequences or hardcode `13;2u` as a
universal newline. Map the selected physical chord to a semantic target key,
then delegate encoding to the installed xterm evaluator for the active protocol.
Keep the same mechanism for Shift+Enter, Ctrl+Enter and Alt+Enter; do not special
case only the default setting or fall back to LF after a failed enhanced mapping.

The first spike must demonstrate OMP's canonical newline key (normally
Shift+Enter) on the pinned version. For example, with OMP's default keybindings,
an app setting of Ctrl+Enter maps that physical event to canonical Shift+Enter;
it must not forward native Ctrl+Enter and hope OMP treats it as newline. The
existing Codex/Grok newline compatibility remains a distinct verified policy;
do not globally replace their Esc+CR path with an unverified canonical chord.

Native encoder access stays in the typed adapter. Normalize an event-like value
without modifying or redispatching the original DOM event. Preserve key location,
repeat and event phase as required by the verified target. Use the existing
session-bound forwarding/observer contract exactly once; the original physical
Enter must not also reach xterm after the mapped event is emitted.

Store each held physical key's mapped target and encoding mode until release,
not until the next settings read. A setting change or modifier release between
keydown and keyup must not release a different key. Cover repeated keydown and
REPORT_EVENT_TYPES/Win32 release; suppress an original release when its press was
swallowed. Define safe blur/dispose/reset behavior so tracking cannot stick.

Do not claim a protocol defines an application's semantic newline action. OMP's
supported editor keybindings must be tested, including relevant custom bindings.
If a TUI/plugin rebinds every available newline target to submit, report the
unsupported conflict rather than silently passing through or declaring success.

Settings copy must not say the shortcut is legacy-only. Explain the setting
consistently in zh-CN/en-US only if clarification is needed.

### 3.3 Lifecycle and associated input paths

- Application-consumed keydown must not leak a matching native keyup into a
  REPORT_EVENT_TYPES/Win32 process. Track consumed physical keys per terminal;
  clear on release/blur/dispose, cover repeat, and do not consume unrelated keys.
- Audit `useTerminalInput` observers/selection/manual-Codex-Enter against encoded
  Enter/backspace/text. They may observe semantics, but must not rewrite structured
  bytes or interpret protocol replies/releases as user command submission.
- Preserve existing programmatic `submitTerminalText` paste/CR contract. This is
  physical-keyboard work, not a reason to change templates or startup commands.
- Exit/pop/reset must return the same xterm to legacy naturally. Cover an OMP
  overlay's alternate-buffer push/pop, then return to PowerShell/other CLI.
- Do not make Hook availability, project/worktree identity or active-tab global
  state a prerequisite for correct key encoding.

### 3.4 Replay and snapshot (required, not a follow-up)

Enabling enhanced protocols without fixing serialization is incomplete. Installed
SerializeAddon loses both modes; reconnecting a still-running OMP can recreate the
original Shift+Enter failure even after the initial launch works.

Introduce one keyboard-aware serialization wrapper at all desktop snapshot call
sites, retaining `serializeTerminalAfterWrite` and its sequence/write barrier.
Preserve effective Kitty flags, both screen-specific stacks and inactive-screen
state, plus Win32 mode. Preserving only the current flags is insufficient when a
later OMP pop restores a parent state.

Prefer deterministic ANSI state restoration integrated around normal/alternate
serialization; preserve cursor, viewport, active buffer and existing content.
Validate the wrapper on real xterm before selecting its exact integration shape.
Do not merely append a current-flags setter, re-negotiate by writing probes to a
live process, or alter the existing checkpoint DTO/daemon protocol. If ANSI-only
lossless restoration cannot be demonstrated, return to design review.

Integration on master `12115cc3` composes the keyboard wrapper with the upstream
mouse snapshot serializer at both desktop sites, retaining mouse tracking and
encoding. The existing 2000-line persistence trim preserves the exact bounded
generated keyboard prefix before the retained tail. Full daemon checkpoints stay
untrimmed; no new snapshot/wire field is introduced. Real-xterm tests cover both
buffers, mouse encoding, visible content/cursor, repeated restoration, full
16-frame stacks and future pops after persistence trimming.

Mirrors must parse state setters but never reply to replayed/mirrored queries.
Keep `installTerminalQueryPolicy` in place, especially `CSI ? u` and DECRQM. A new
process's first startup replay still has its existing limited reply allowance.
Old pre-feature snapshots lack enhanced state and remain legacy-compatible.

## 4. Scroll-To-Top Design

Add `scrollToTop` to ShortcutAction, the action list, default map (`Ctrl+Home`),
settings label map and both language dictionaries. Existing migration merges a
default map with known persisted strings, so old settings acquire the new action
without resetting custom bindings; an explicit empty string remains disabled.
Test this rather than adding a new database migration or changing store versions.

In the same normal-buffer-only branch as scroll-to-bottom/page-up/page-down:
match the configured combo, prevent browser default, call `terminal.scrollToTop`,
and return false. Let existing `onScroll` update the away-from-bottom indicator.
Keep `scrollOnUserInput` unchanged. Ctrl+End and ordinary typing keep their current
behavior; the local scroll action sends no PTY bytes in any negotiated mode.

Alternate-buffer Ctrl+Home stays TUI-owned. Do not convert it to plain Home:
that can move a composer cursor instead of scrolling. "Top" means the earliest
retained xterm normal-buffer line, not unlimited history beyond scrollback limits
and not an independent OMP conversation-history API.

## 5. Discovery Checklist / Scenario Matrix

| Touchpoint | Disposition |
| --- | --- |
| TerminalNewlineShortcut + useXTermController | Modify mode-aware routing and normal-buffer top action |
| shared keyboard options/state adapter | Add narrow shared responsibility |
| useTerminalInput + IME + manual Codex override | Audit and extend only if structured-input tests expose a mismatch |
| settingsStore + ShortcutSettingsPage + i18n | Add top binding and explain ownership; no store refactor |
| terminalQueryPolicy | Preserve; add replay/mirror negotiation regression tests |
| snapshot call sites + SerializeAddon boundary | Lossless keyboard mode state preservation required |
| WebTerminal + Tap Terminal | Match capability/state restoration, keep mirror reply suppression |
| Tap virtual keys / composer | Test separately; adapt only native key encoding, not chat draft semantics |
| TerminalProcessManager / PtyHostSocket | Byte-preservation/identity regression, no wire changes expected |
| Rust ConPTY flags / WSL / SSH | Flags confirmed present; no backend change indicated, E2E required |
| templates / startup / clipboard / Hook scripts | Confirmed separate owners; preserve existing behavior |
| CHANGELOG + feature inventory | Update under V1.4.5 only after implementation exists |

| Scenario dimension | Required behavior |
| --- | --- |
| local PowerShell / Pwsh / CMD; WSL; SSH | Negotiate with actual program, never infer from shell name |
| legacy / Kitty / Win32 / push-pop / app exit | Native encoding only while actually active, restore legacy correctly |
| current pane / nested split / other pane | Only focused terminal handles physical keys; exact session writes |
| same window / other window / app unfocused / tray | No key broadcast; hidden owner still handles allowed queries |
| normal / alternate screen | Local scroll-to-top only normal; TUI owns alternate navigation |
| old settings / customized / disabled / conflicts | Add default without overwriting user choice; use existing conflict UX |
| launch / reconnect / checkpoint / mirror joins later | Same negotiated state; no duplicate query replies |
| Chinese IME / composition end / key repeat / release | No premature send, duplicate characters or orphan key releases |
| single / multiple Workspans; focus mode; sidebar modes | Session identity and key ownership unaffected |
| main checkout / worktree / missing worktree; Hook on/off | No dependency on these states; keyboard routing remains local |
| zh-CN / en-US | New labels/help accurate in both; 24-hour time convention unchanged |

## 6. Alternatives and Rollback

- Only enable vtExtensions: rejected; application interception still writes LF,
  and mirrors/checkpoints remain inconsistent.
- Only disable scrollOnUserInput: rejected; masks missing navigation and changes
  normal typing behavior for every CLI.
- Only add `isOmp` -> Esc+CR / CSI-u: not the recommended root fix; CLI identity
  misses manual launches/aliases and does not implement negotiation/restoration.
  A narrowly pinned compatibility mode is a separate scope decision if required.
- Native-pass-through modified Enter after negotiation: rejected by the user's
  settings-must-work requirement. Standard terminal behavior alone is not the
  product's acceptance criterion. Use section 3.2's semantic remapping instead.
- Ship only scroll-to-top first: a safe independent slice if the keyboard spike
  does not pass, but it must not close the Shift+Enter part of #293.

No dependency bump or backend schema migration is planned. Keep scroll-to-top
separable from keyboard changes. Roll keyboard capability/routing/serialization
back together; never leave only one of them deployed. Preserve user customization
and never kill a live PTY to work around a failed negotiation.

File-level GitNexus risk: controller/newline LOW, query policy MEDIUM,
settingsStore CRITICAL (105 direct/345 within three import levels). These coarse
file scores do not reduce the behavioral risk of changing all terminal input.

## 7. Product Decision and Review Gate

The user has resolved ownership: the configured application newline shortcut
must work, including when an enhanced protocol is negotiated. Version remains
V1.4.5. No further ownership interview is needed.

This materially changes the previously recommended pass-through design, so
submit the revised mapping behavior for review before `task.py start`. The review
summary must explicitly promise all three setting choices, Enter exactly once,
IME safety, and checkpoint/reconnect consistency; it must not misrepresent the
new requirement as approval of the superseded legacy-only setting behavior.
