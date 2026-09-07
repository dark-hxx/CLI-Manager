# Implementation checklist

1. Read frontend/backend specs and run GitNexus impact for every edited component, hook, command, and persistence function.
2. Add the preferred-port command and hook action with validation/rollback behavior; add focused Rust coverage for invalid and persisted ports.
3. Refactor `NativeProviderRoutingSection` into the compact dependency-aware layout; remove the quick-control switch and move takeover/failover controls.
4. Simplify `NativeProviderFailoverSection`: collapsible outer section with an icon, queue-only status rows, distinct in-queue color, direct queue priority controls, no UUID/key-summary text, no separate health accordion; queue toggles update optimistically without a list-wide loading refresh.
5. Update Chinese and English i18n strings, remove the main-surface routing navigation entry, and remove obsolete quick-control copy where no longer referenced.
6. Use a real Codex Home profile for scoped project launches so the visible command uses `--profile`; keep legacy `-c` snapshot fallback for older snapshots.
7. Run `npx tsc --noEmit`, focused Rust tests/checks, and inspect `git diff`.
8. Treat Codex Responses `response.completed` as the streaming success boundary, immediately open the failed stream circuit, and promote the successful fallback provider for the next request; run GitNexus `detect_changes()` before delivery and update changelog/feature inventory per the delivery checklist.
9. Reconcile persisted routing intent with daemon runtime state so an enabled-but-stopped listener is restarted on routing refresh, while the UI reflects the actual daemon status.
10. Cache provider settings navigation/scroll state and make the active failover provider explicit in the queue.
11. Make the active badge high contrast and reset the active route provider to the queue head when circuits are reset.
12. Add per-request failover traversal logs for candidate order, circuit decisions, upstream results, stream outcomes, and final selection.
