# Root-cause design and discovery

The failures live at resource ownership boundaries: replay state owns loaded payloads without a cross-session lifetime; synchronous resource IPC owns expensive sampling on the UI thread; daemon spill failure falls back to unbounded RAM. Repairs must change these producers, not merely hide their symptoms.

## Slices

1. Replay: metadata-only event loading; independent patch cache with a byte budget, LRU and two-reader single-flight queue; cross-session event count/byte budget; safe fixed-data-root patch IPC; demand load before diff/rollback/fork and bilingual failure/retry. Legacy inline patches remain readable. Capture deduplication remains independent from viewing.
2. Sampling/inventory: acquire a bounded sampling permit before blocking initialization/collection. Share background inventory single-flight and last-good state across consumers, retaining unknown/stale semantics on errors.
3. Daemon: fault-injection first. Preserve whole-frame/sequence boundaries and explicit truncation/replay-gap signaling. Count checkpoint bytes separately from ring bytes; use bounded cursor reads and amortized compaction. Never stop user processes to simulate pressure.
4. Residency: lazy emoji data, bounded scoped capability cache, bounded real file reads. Cold terminals, dirty editor state and history detail pagination require separate recovery/navigation acceptance before lifecycle changes.

## Discovery / impact method

GitNexus MCP is unavailable in this session (tool discovery returned no tools). CodeGraph exploration plus current domain contracts/caller searches are the approved fallback; record each changed symbol's upstream callers before edits.

- Replay store -> CLI hook ingestion, SessionReplayPanel -> TerminalSidePanel/TerminalTabsView; diff and rollback/fork consumers must load patches explicitly.
- Files commands -> lib.rs command registry, project editor/preview consumers; do not raise general preview limits.
- Resource command -> SystemResourcesPanel only; response shape/caches stay compatible.
- Daemon SessionBuffer -> session reader, attach/replay, ACK refill, checkpoint, inventory accounting; high-risk protocol lifecycle.
- Background inventory -> terminal tabs, desktop pet, exit guard; failures cannot imply zero tasks.
- Emoji panel -> sidebar/project node appearance; capability hook -> exact local/WSL/SSH scope.
- Cold terminal/editor/history pagination are tracked, not silently removed from scope.

## Scenario matrix

| Dimension | Required behavior |
| --- | --- |
| focus/minimized/hidden | No eager heavy payload reads; stale completions do not reopen panels |
| split/multiple panels | Shared single-flight reads; changing sessions cannot publish stale diff/actions |
| local/WSL/SSH/worktree | Existing snapshot eligibility and root/path validation preserved |
| hooks installed/absent | Recording and manual snapshots work independently of viewing |
| missing/oversize patch | Visible bilingual error, retry on next action, never treat failure as clean snapshot |
| disk failure / active output | Memory remains bounded; explicit loss/recovery semantics, no invisible dropping |
| dirty editor / terminal detach | No eviction of dirty/undo state or unacknowledged terminal data |

Rollback is a source-only revert of this task's isolated changes; no schema or installation mutation.

## Development startup feedback slice

The new reported stall lives at the CLI launcher/process boundary: a cold helper build runs before Vite listens but inside Tauri's finite frontend readiness wait; afterward, waiting only for the CLI child's `close` can retain the launcher forever when Vite descendants keep inherited pipes open. Move the helper preflight before Tauri launch and distinguish process `exit` from pipe `close`. The exact historical CLI exit cause remains inferred, not captured.

Discovery, hypotheses, scenario coverage and live process evidence are recorded in `research/dev-startup.md`. Only the launcher and focused script tests change; helper implementation, Tauri configuration, runtime IPC, installed application and user-owned process lifecycle stay unchanged.
