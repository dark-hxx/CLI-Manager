# Terminal Keyboard Contracts

## 1. Scope / Trigger

Physical desktop keys, negotiated keyboard modes, checkpoint restoration and
Web/Tap native/virtual keys. Programmatic templates remain governed by
[Terminal Text Submission](./terminal-text-submission-contracts.md).

## 2. Signatures

- `createTerminalKeyboardOptions()` enables Kitty capability, not active mode.
  Production Win32 input capability is deliberately not enabled.
- `readTerminalKeyboardState(terminal)` returns a cloned
  `{ mode, flags, mainFlags, altFlags, mainStack, altStack }`.
- `encodeTerminalKey(terminal, key, phase?, repeat?)` delegates to xterm's native
  evaluator; `encodeTerminalKeyStroke` is down plus negotiated release.
- `createTerminalKeyRouting(terminal, send)` owns consumed physical-key pairing;
  `newline`, `wrap(handler, imeGuard)`, `release`, `dispose` are per-terminal.
- `serializeTerminalWithKeyboardState(terminal, serialize)` wraps SerializeAddon
  after the existing `serializeTerminalAfterWrite` barrier; compose with
  `serializeTerminalSnapshot` to retain mouse tracking/encoding too.
- `preserveTerminalKeyboardSnapshotPrefix(snapshot, tail)` retains only the
  bounded generated keyboard prefix when persisted snapshots are tail-trimmed.
- `applyTerminalScrollShortcut(terminal, combo, shortcuts): boolean` consumes
  only normal-buffer history navigation.

## 3. Contracts

- The desktop newline setting owns the physical chord. Matching Shift/Ctrl/Alt
  Enter maps to canonical Shift+Enter in enhanced LF-style composers; legacy LF
  and Codex/Grok ESC+CR compatibility remain separate policies. Nonmatching
  chords keep the existing swallow/native-Alt exception. Do not promise override
  of a TUI/plugin that rebinds the semantic target itself to submit.
- IME guard precedes remapping, including repeat. Candidate-confirmation Enter,
  Process/229 and existing Unidentified protection cannot submit a command.
- Track physical `code`, target and protocol until release, independent of live
  settings/modifier changes. Consume original keypress/keyup. Application/window
  capture-consumed keys must not leak enhanced keyup into the TUI.
- Blur releases active mappings only in the same protocol, then retains a
  release-suppression tombstone until physical up or a fresh nonrepeat press.
  Dispose clears tracking. Never encode an old release after mode/reset changes.
- Send mapped native bytes through the terminal's existing onData/session-bound
  path exactly once. Preserve legacy direct writes: LF through onData can replace
  selected input. Releases are not `wasUserInput`; no manual protocol grammar,
  DOM redispatch, CLI-name inference of negotiated mode, LF fallback or retries.
- Only `terminalKeyboardProtocol.ts` accesses keyboard internals. It is pinned
  to xterm `6.1.0-beta.288`, runtime validates encoder/state shape, and throws
  `Unsupported xterm keyboard API` on incompatibility. Dependency upgrades must
  pass real-library compatibility tests, not just TypeScript compilation.
- SerializeAddon does not preserve keyboard state. Preserve both raw saved flag
  fields (even stale values), both bounded 16-frame stacks and active flags.
  Seed screens before painting; set active flags after painting. Never toggle
  buffers after painting: alternate content/cursor can be destroyed. Redundant
  xterm screen toggles still swap saved keyboard flags.
- Persistence trims to 2000 tail lines after sending the full daemon checkpoint.
  Retain the exact bounded keyboard prefix before the trimmed content; the active
  flags and mouse-state suffix remain at the tail. Do not restore screen stacks
  with post-paint buffer toggles or invent an IPC/JSON snapshot schema.
- Web/Tap parse the same modes/checkpoints but never answer mirrored queries.
  Keep `installTerminalQueryPolicy`, including Kitty and DECRQM suppression;
  desktop remains the only reply owner, even hidden. Tap dock strokes use native
  encoding; its chat-composer paste/submit contract is unchanged. Desktop newline
  preference is not currently transported to browser clients.
- `scrollToTop` defaults to Ctrl+Home. Existing settings merge defaults with
  strings, preserving customization and explicit empty/disabled values. Local
  scrolling sends no PTY bytes; alternate buffers pass through. Preserve
  `scrollOnUserInput` and existing scroll indicators.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Kitty capability, no negotiated flags | Legacy encoding |
| Flags 1 or 3, modified Enter | Native modified encoding; no Enter release |
| Flags 11 | Native press/repeat/release |
| Unsupported internal API | Explicit compatibility failure, never LF fallback |
| Snapshot followed by nested pops/toggles | Same raw flags/stacks as original |
| Replay/mirror query and setter in same frame | Parse setter, suppress reply |
| Normal Ctrl+Home | Earliest retained history; zero PTY input |
| Alternate Ctrl+Home | TUI-owned, no local scrolling |

## 5. Good / Base / Bad Cases

- Good: Ctrl+Enter setting maps to native Shift+Enter while Kitty is active.
- Base: ordinary PowerShell remains legacy until an application negotiates.
- Bad: enable capability but continue replacing matched keys with LF, or restore
  only current flags while dropping screen-specific stacks.

## 6. Tests Required

Run `scripts/terminalKeyboardProtocol.test.mjs`, `terminalKeyRouting.test.mjs`,
`terminalKeyboardMirrors.test.mjs`, `terminalKeyboardSnapshot.test.mjs`,
`terminalSnapshotPersistence.test.mjs` and `terminalScrollShortcuts.test.mjs` with
`node --test`. Assert all three settings, native event types, IME, blur/refocus,
settings changes while held, old settings, disabled bindings, full stack bounds,
repeated checkpoints, content/cursor, query ownership and virtual strokes.
Include combined keyboard/mouse roundtrips in normal/alternate buffers and actual
2000-line persistence trimming followed by nested pops and screen switches.
Supplement with existing newline/composer/IME/replay/template/process tests,
desktop/Web/Tap typechecks, Tap tests and standalone strict architecture check.
No app/service launch for UI verification. Real OMP/ConPTY, WSL/SSH and bilingual
UI acceptance remain explicit human validation, not inferred from library tests.

## 7. Wrong vs Correct

Wrong: forward physical Ctrl+Enter unchanged after Kitty negotiation and assume
the TUI treats it as newline, ignoring the setting's intent.

Correct: resolve the configured physical chord to the supported semantic newline
target, consume the original and let xterm encode the target and its lifecycle.
