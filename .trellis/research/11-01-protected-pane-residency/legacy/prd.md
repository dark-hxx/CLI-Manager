# Protected cold pane residency

Child of 11-01-memory-usage-hardening. Implementation authorized as part of the full audit request, but not implemented in the parent's first repair batch.

- Reduce long-hidden xterm/Monaco and clean inactive editor data residency.
- Never evict dirty text, undo models, conflict/diff drafts, pending terminal writes or input/mouse/keyboard state.
- Preserve detach/attach replay, full history, split panes, workspans and local/WSL/SSH routing.
- Acceptance: synthetic ownership regressions plus installed GUI split/switch/close/reopen checks. No global scrollback reduction or forced GPU shutdown.
