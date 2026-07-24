# Design

## Data Flow

`CLI Hook -> hook_client -> daemon HTTP listener -> App event -> terminalStore binding -> TerminalStatsPanel -> history list/detail`

## Boundaries

- Hook transport: payload carries one stable `remoteEventId`; retries reuse it.
- Daemon admission: a bounded recent-ID cache suppresses duplicate sink delivery.
- Frontend binding: exact Tab ID wins; fallback binding requires one unambiguous local candidate.
- Stats recovery: later valid Hook events rerun the same safe resolver; existing detail lookup remains unchanged.

## Binding Rules

1. Exact local `tabId`.
2. Legacy split primary mapping when it resolves to an existing session.
3. External/unknown `tabId`: filter PTY sessions by CLI source and project/worktree/cwd.
4. One candidate binds immediately.
5. Multiple candidates bind only when exactly one has recent PTY output; otherwise reject.
6. A candidate session ID already bound to another Tab is always rejected.

## Recovery Rules

- A later Hook event may recover an old or external terminal only through the binding rules above.
- The stats panel never calls the project-latest detail path without a verified session ID.
- No Hook means a safe empty state; ambiguous candidates are not repaired by polling history.

## Compatibility

- Hook requests without `remoteEventId` keep existing behavior and are not deduplicated.
- No dependency, database schema, Tauri command, or persisted-session schema change.
- SSH keeps its existing exact remote identity behavior.
