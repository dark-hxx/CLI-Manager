# Grok History Path Design

## Boundary

The frontend-owned history source settings define Grok's required location as
`locations.sessionRoot`. `getHistoryPathArgs()` passes that location through the
`grokSessionRoot` IPC field. The backend will make `HistoryRoots.grok_session_root`
and `resolve_grok_history_root()` represent that same directory.

## Data Flow

```text
settings.historySourceSettings.grok.activeInstance.locations.sessionRoot
  -> getHistoryPathArgs().grokSessionRoot
  -> history_roots(...).grok_session_root
  -> resolve_grok_history_root()
  -> collect_grok_session_files(root)
     / find_exact_grok_session_in_root(root, id, project)
  -> catalog/list/detail/search/stats/history UI
```

The current defect is the final transition: the explicit root is already
`<home>/.grok/sessions`, but two readers append `sessions` again.

## Implementation

- Change the default resolver to return the default session root directly.
- Keep explicit `grok_session_root` unchanged after normalization.
- Change Grok collectors and exact lookup to enumerate children directly under
  the supplied session root.
- Update test fixtures so they construct a session root explicitly and add a
  regression that passes an explicit `HistoryRoots.grok_session_root`.
- Keep all Tauri command signatures and frontend path argument shapes stable.

## Compatibility and Safety

- Existing callers that pass no Grok root still resolve to
  `<home>/.grok/sessions`.
- The source descriptor already advertises `.grok/sessions`, so no UI migration
  is necessary.
- No user files are written, moved, or deleted by this fix.
- WSL handling is unchanged; this change only removes an extra path component
  before the existing WSL-aware scanners receive the root.

## Rollback

Revert the uncommitted backend/doc changes. No data migration or persistent
format change is introduced.
