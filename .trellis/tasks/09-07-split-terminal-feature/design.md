# Terminal decomposition

Keep stable entry exports while moving ownership to features/terminal. Separate XTerm
controller from unchanged rendered view and named link/diagnostic helpers. Its shared
fallback flag and attachment cleanup promise retain their single module owners. Do not
split/reorder the terminal lifecycle effect, attach, subscription, snapshot or dispose sequence.

TerminalTabs: extract existing hover, sortable tab, pane bar/leaf, drag/drop and toolbar
components first; then separate cohesive controller/view responsibilities if still above
the cap. Dynamic imports must retain lazy-loading behavior and resolve to the same owners.

Terminal store: split pure helpers/types and named action groups using Zustand's existing
set/get instance. Keep module counters/timers and heartbeat singletons with their owners;
do not introduce a second store or lazy getter cycle. Preserve original action bodies.

Scenarios: local/WSL/SSH, CLI/shell, fresh/restore/reconnect, mounted/hidden/StrictMode,
Replay/Reset/live ACK, resize, Workspan/splits, stale async responses, IME/paste/search,
markdown/file/Git panels and both languages. Static/test validation only; no app launch.
