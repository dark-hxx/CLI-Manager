# Verification in progress

## XTerm

- Controller 1811 lines, view 410, helpers 96/189/50, stable facade.
- Extraction script asserts all original top declarations exactly once, unchanged controller statements and complete JSX.
- TypeScript pass. 93 focused tests pass (IME/newline/mouse/Pi/OSC52/images/scroll/remount/background/markdown).
- Existing snapshot source assertions were stale before extraction: `finishInitialDisplayRestore(hasSnapshot)` already distinguishes snapshot/no-snapshot, and restore already uses a conditional Codex cursor sequence. Confirmed against 2d1eb7fe before adapting assertions, added post-fit output gate coverage. No runtime fix made.
- Workspace CSS test needed CRLF normalization; CSS untouched.
- Architecture: 918 sources, 2 oversized files, no new violations. Full terminal integration/build pending.
- No runtime app launch. Remaining manual checklist includes StrictMode remount, visible/hidden terminal, replay/reconnect/resize, both languages, IME/paste and context menu.

## TerminalTabs

- Existing tab/hover/drag/pane/dialog/toolbar declarations moved by responsibility; lazy boundaries preserved.
- Controller 1991 lines; unchanged view 514; toolbar renderer 338; scoped empty-state hook 65. Original useCallback/useMemo bodies and dependency arrays remain intact at the same hook positions.
- `verify-components.mjs`: 512 declarations/statements plus complete XTerm/Tabs JSX match 2d1eb7fe. Only explicit theme union annotation added to avoid TypeScript return-object widening.
- TypeScript pass. 80 Tabs-related tests pass; production build pass, 6957 modules, 1m43s.
- Existing pane marker test missed the already-present conditional marker wrapper; updated it against the baseline. The broad overflow Popover assertion actually targeted the close-confirm popover; now reads that owner explicitly. No UI behavior changed.
- PaneLeafView imports its feature-local XTerm owner directly to avoid a new facade/barrel cycle.
- Architecture: 934 sources, only terminalStore remains oversized, no new violations. Full directory convergence remains outstanding.

## Terminal Store

- One `create<TerminalStore>` remains. The runtime factory receives the exact same set/get/API once during initialization; it owns timers, counters and the serialized persistence queue. The orphan heartbeat remains a single post-initialization call.
- Type-only dependencies are explicitly `import type`; runtime module graph is acyclic. `state.ts` is a narrow state entry independent of terminal UI exports.
- `verify-store.mjs`: all 130 non-store declarations and all 61 state/action properties match fc92405e, including object-key order and all function bodies/literals after formatting.
- TypeScript pass. Existing affected tests 27 pass. New runtime tests 4 pass (timer-free construction/counters, same-API timeout behavior, bounded append/reset, serialized cloned snapshots with error recovery).
- Build pass: 6964 modules, 58.04 seconds. Architecture: 943 sources, zero oversized files, zero new violations. Long-line debt is still tracked separately; strict/final directory convergence remains pending.
- GitNexus reported CRITICAL import impact on types (39 direct importers), warned before edits; several actions were unindexed. Public exports remain compatible and direct declaration/type checks supplement the graph.
