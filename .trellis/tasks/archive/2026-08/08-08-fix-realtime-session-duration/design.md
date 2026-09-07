# Design: transcript-backed session timestamps

## Root-cause statement

The history backend derives session duration from filesystem creation/modification metadata, but current Codex rollout files can keep those values equal while their transcript event timestamps continue advancing; therefore the correction belongs in transcript scanning and computation, with filesystem metadata retained only as fallback.

## Data flow

`JSONL transcript timestamps -> SessionSummaryScan -> CachedSessionComputation -> HistorySessionSummary -> historyStore normalization -> SessionInfoCard duration`

## Decision

Extend the internal summary scan with earliest/latest valid event timestamps. The generic Codex/Claude JSONL scanner records timestamps from each JSON record, including nested session metadata timestamps. JSON-backed source scanners derive the same bounds from parsed messages. `build_session_computation` uses these bounds when present and keeps the existing fingerprint timestamps otherwise.

## Scenario coverage

| Dimension | Covered behavior |
|---|---|
| Source | Codex/Claude JSONL uses transcript timestamps; Cursor/Grok existing overrides remain authoritative; JSON sources use parsed message timestamps; timestamp-less files use filesystem fallback |
| Runtime path | Local and WSL fingerprint acquisition remains unchanged; only parsed transcript data changes |
| Session state | New, active, completed, and restored sessions use the same summary computation; cache re-scan still depends on file fingerprint |
| Project scope | Session identity/project filtering/Worktree scope remain unchanged |
| UI state | Current and switched terminal tabs consume the same `created_at`/`updated_at` contract |

## Compatibility

- No Tauri command or serialized field names change.
- Existing index fingerprints and cache invalidation remain unchanged.
- Existing Cursor/Grok metadata enrichment runs after the generic timestamp selection.
