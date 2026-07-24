# History Stats Contracts

> Executable contracts for history session stats and detail payloads across Rust commands, TypeScript store normalization, and React history/statistics UI.

---

## Scenario: History usage stats payload

### 1. Scope / Trigger

- Trigger: changes touching `history_get_stats`, `history_get_session`, history message parsing, stats aggregation, or frontend consumers of history usage fields.
- This is a cross-layer contract because Rust parses JSONL history files, serializes command responses, `historyStore` normalizes payloads, and UI components render totals, charts, and per-session panels.

### 2. Signatures

Rust command payloads:

```rust
pub async fn history_get_stats(
    source: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    project_key: Option<String>,
    project_path: Option<String>,
    project_paths: Option<Vec<String>>,
    range_days: Option<usize>,
    start_at: Option<i64>,
    end_at: Option<i64>,
    force: Option<bool>,
) -> Result<HistoryStatsResponse, String>

pub async fn history_get_session(
    file_path: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    source: String,
    project_key: String,
    aggregate_subtasks: Option<bool>,
) -> Result<HistorySessionDetail, String>
```

Frontend payload surfaces:

```ts
interface HistoryMessage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
}

interface HistoryStatsPayload {
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_unpriced_tokens: number;
  hourly_activity: Array<{
    hour: number;
    hour_start_utc: number;
    sessions: number;
    messages: number;
    level: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_cost_usd: number;
    unpriced_tokens: number;
    session_refs: HistorySessionSummary[];
  }>;
}

interface HistoryTokenTrendPoint {
  timestamp: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  model?: string | null;
}

interface HistorySessionUsage {
  dominant_model?: string | null;
  current_model?: string | null;
  context_window?: number | null;
  last_context_tokens?: number | null;
  reasoning_effort?: string | null;
  token_trend: HistoryTokenTrendPoint[];
}

interface HistoryToolEvent {
  call_id?: string | null;
  name: string;
  category: string;
  message_index?: number | null;
  timestamp?: string | null;
  status?: string | null;
  duration_ms?: number | null;
  input_summary?: string | null;
  output_summary?: string | null;
}

interface HistorySessionDetail {
  cwd?: string | null;
  tool_events?: HistoryToolEvent[];
}

interface TerminalSession {
  cliSessionId?: string;
}
```

### 3. Contracts

- Token fields are non-negative counts. Missing usage data must normalize to `0`.
- Claude Code JSONL streams one assistant message as multiple lines sharing the same `message.id` + `requestId`, each carrying identical usage. Usage must be counted **once** per `(message.id, requestId)` — both in aggregate stats (`scan_session_combined`) and per-message detail (`iter_session_messages` blanks token fields on duplicate lines). Without dedup, totals inflate ~3x on real data.
- Codex rollout token usage comes from `event_msg.payload.info.total_token_usage`, which is a cumulative session counter. Per-turn usage uses high-water adjacent diffs: a smaller cumulative snapshot is stale/interleaved data, contributes zero, and must not lower the previous high-water mark. This makes the session sum converge to ccusage's final cumulative total without multiplying temporary rollbacks.
- For `history_get_session` message details, Codex `response_item` messages must inherit an outer wrapper timestamp when the inner payload has none, and normalized Codex `token_count` deltas should backfill the latest assistant message that has no token fields. This keeps transcript bubbles able to show `MM/DD HH:mm  in N / out N / cache N` without changing aggregate totals.
- `HistorySessionUsage.token_trend` exposes normalized per-usage points after the same cumulative high-water rules used for totals. Skip zero-token points. Do not synthesize frontend trend points from final totals.
- `HistorySessionUsage.token_trend[].model` should carry the model attributed to that usage delta when known. Realtime Token Trend can use it for per-segment coloring and tooltip model names. Missing model normalizes to `null` and must fall back to the default trend color.
- Codex `input_tokens` **includes** `cached_input_tokens`. Extraction normalizes to non-cached input + `cache_read_tokens` (Claude semantics), so pricing applies uniformly with no source-specific input deduction.
- Usage lines without a model (e.g. Codex `token_count` events) attribute to the most recent model seen in the session (e.g. from `turn_context.payload.model`).
- Codex reasoning effort only becomes part of the model key for plain GPT version IDs such as `gpt-5.4` or `gpt-5.6`. Models with purpose suffixes such as `gpt-5.3-codex-spark` keep their base model key even if the log also exposes `effort: "high"`.
- `HistorySessionUsage.dominant_model` is an aggregate model signal and must not be reused as the realtime "current model". `HistorySessionUsage.current_model` tracks the latest non-synthetic model seen in the session; realtime model/context display should prefer it so same-session model switches update context-limit fallback and remaining-space calculation without changing historical model distribution semantics.
- The `<synthetic>` model (Claude error placeholder lines) must never enter model distribution or model attribution.
- Stats aggregates must include input, output, cache read, cache creation, estimated cost, and unpriced token counts at every exposed usage level: total, project, model, source, daily series, and hourly activity.
- History stats bucket token/cost/model aggregates by each deduped usage event timestamp (`timestamp`, `time`, `created_at`, `createdAt`, or `message.timestamp`), falling back to the session `updated_at` when missing. A session continued on a later day contributes its later usage and one session to that day even when it was created earlier. Range-level `sessions` must be counted by unique session identity so multiple usage events in one session do not inflate session counts.
- `history_get_stats.project_path` and `project_paths` filter by configured project paths and must use the same `session_matches_project_path` rules as `history_list_sessions`: Claude project-key normalization, WSL/UNC path variants, and metadata `cwd` matching for Codex. Multiple paths use OR semantics, while `project_key` remains conjunctive when also present.
- Project selectors keep the configured `Project.id` as their UI identity. They resolve the query path from `Project.path` for local/WSL projects and `Project.remote_path` for SSH projects; an SSH project's empty local `path` must never mean "all projects" or select sibling SSH projects.
- Selecting an SSH project in historical usage first synchronizes that project's remote catalog scope, then calls `history_get_stats` with both `remote_path` and the validated remote `source_instance_id`. Remote instance filtering excludes local facts and other hosts/config roots even when they expose the same path.
- Opening SSH historical usage must not be a forced index rebuild. The frontend sends `force=false` by default; only explicit manual refresh may force remote sync. When `history_get_stats.source_instance_id` is present, the backend reads v2 catalog facts directly, skips `refresh_history_index_snapshot`, and filters by `history_sessions.source_instance_id` in SQL before Rust-side project-path matching.
- Stats aggregation cache keys include `source_instance_id`; remote catalog stats may use aggregation cache when `force=false`. A successful `history_remote_sync` apply must invalidate stats caches so a newly applied remote generation is visible on the next stats read.
- Realtime “today project usage” sends the parent project path plus all active Worktree paths in one `project_paths` request. Backend aggregation iterates each indexed session once, so overlapping parent/child paths cannot double count usage.
- Stats aggregation and daily-index cache keys must include the canonical sorted/deduplicated project-path set, so ordering and duplicates reuse the same cache while different path sets remain isolated.
- Heatmap-compatible buckets must include `sessions`, `messages`, `level`, and `session_refs`. Daily heatmap buckets use `day_start_utc`; hourly activity buckets use `hour_start_utc` plus `hour` so the frontend can render 24-hour drilldowns without guessing local bucket anchors.
- `historyStore` must accept snake_case payload fields and legacy camelCase fallbacks when normalizing stats data. `normalizeDetail` must pass message token fields through (it previously dropped them, making per-session token panels read 0).
- Unknown or unsupported models must not fake a price. They contribute to `unpriced_tokens` and `total_cost_usd` remains unaffected.
- Explicit cost fields from the source payload are not billing authority for CLI-Manager history stats. Local `model_prices` decides cost when model pricing is available; otherwise usage is counted as unpriced.
- Codex session project keys should prefer session metadata `cwd`; path-derived keys are only a fallback.
- Codex session identity should prefer `session_meta.payload.id` for rollout JSONL files (`rollout-*.jsonl`) so `HistorySessionSummary.session_id` / `HistorySessionDetail.session_id` match the hook-reported `TerminalSession.cliSessionId`. If the metadata id is missing, fall back to the file stem. This Codex-only normalization must not change Claude Code session identity, which continues to use the existing file-stem id.
- `HistorySessionDetail.cwd` is a detail-only resume/location field derived from the same `SessionProjectScan` metadata used for project matching. Do not add `cwd` scanning to `history_list_sessions`; the list path must stay cheap. Missing `cwd` normalizes to `null` on the frontend.
- `HistorySessionDetail.tool_events` is detail-only diagnostic data, not part of list/stats aggregation. It may require an additional detail-path scan and must not pollute `SessionStatsScan` caches used by list/stats hot paths.
- Tool event extraction must preserve source truth: return `duration_ms`, `status`, input/output summaries only when the raw JSONL exposes them. Do not synthesize durations or success states from tool names or message text. Missing fields normalize to `null` or an empty list on the frontend.
- Tool event categories use stable strings: `builtin`, `skill`, or `mcp:<server>`. Claude `tool_use` names like `mcp__exa__web_search_exa` and Codex namespaces like `mcp__gitnexus` must map to the same MCP category shape.
- `history_get_session(aggregate_subtasks = Some(true))` is a realtime-only aggregation mode for terminal stats. It keeps the parent session identity (`session_id`, `title`, `file_path`, `source`, `project_key`) but merges sibling `subagents/agent-*.jsonl` transcripts into the returned `usage`, `messages`, `tool_events`, `created_at`, and `updated_at`.
- The default detail path (`aggregate_subtasks` omitted / false) must stay single-file so history detail/replay views do not silently change scope.
- Aggregated token trend must be rebuilt from merged usage events ordered by event timestamp (fallback to each transcript file `updated_at`), not by concatenating per-file `token_trend` arrays.
- Aggregated tool counts must sum the per-transcript usage counters; do not recompute them from merged `tool_events`, because diagnostic end/error rows are not equivalent to tool-call count events.
- Aggregated context window / last context tokens should follow the most recently updated transcript that exposed those values, while aggregated `cwd` continues to prefer the parent session metadata.
- `HistorySessionUsage.context_window` is an exact log-derived limit only. Codex reads explicit `payload.info.model_context_window`; Claude may read explicit fields such as `context_window`, `max_input_tokens`, `max_context_tokens`, or `model_context_window` from known log/usage locations. When the log does not expose an explicit limit, backend history parsing must leave `context_window` as `null`; frontend model metadata/local rules own display fallback.
- Terminal realtime stats bind strictly to the current terminal's `TerminalSession.cliSessionId` (from CLI hook payload). When a session id is present, look up **only** that session; if it is not yet found in history (e.g. JSONL not flushed), keep that terminal's own empty/loading state and **never** fall back to a different session. Project-level "latest session" lookup is used only when the terminal has no session id at all.
- For SSH terminals, persist the Hook `remoteTranscriptRef` with that terminal session. Before `cliSessionId` arrives, realtime stats stay empty and do not poll or run remote history synchronization. Once the id is present, realtime stats invoke remote detail directly with the session id and optional transcript ref; they must not run remote `historySync` or cached-session listing first. Polls for the same terminal/session/transcript scope are single-flight, and results from an older scope must not clear or replace the current panel.
- Realtime "today project usage" aggregation remains automatic for local/WSL projects. The SSH realtime panel does not trigger project-wide remote history synchronization or aggregation; project-wide remote analytics belong to an explicit history/statistics workflow.
- When the CLI hook chain is known to be active (any terminal has bound a `cliSessionId` this run) but the current CLI terminal has not yet received its own id, the realtime panel shows an explicit "awaiting session identification" empty state instead of borrowing the project's latest session — so newly opened sessions never display a neighbor window's data. Only a true no-hook environment (no terminal ever bound an id) keeps the project latest-session fallback.
- Realtime model/context-limit display may use the loaded session's model or exact limit and then fall back through model metadata/local rules, but current context usage and token totals must stay gated by `tokensBound` so another terminal's token counts are never shown.
- Stats date ranges may cover up to 366 days and must reject larger ranges with `date_range_too_large`.
- History index builds scan cache-miss files in parallel (`std::thread::scope`, worker count = `available_parallelism`); fingerprint-hit entries must still be reused without rescanning.
- Any change to history parsing semantics that affects persisted `HistoryIndexEntry.computed` output, including model attribution, token extraction, timestamp bucketing, or project identity, must bump `HISTORY_INDEX_CACHE_VERSION` so old on-disk scans cannot hide the new behavior.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Missing usage field | Count tokens and cost as zero. |
| Older cached/frontend payload lacks hourly token/cost/session fields | Normalize missing hourly fields to zero counts and an empty `session_refs` array. |
| Usage field has unknown shape | Ignore unknown fields; keep the message/session readable. |
| Tool event has no call id | Keep the event if it has a tool name; do not deduplicate by name only. |
| Tool event has no duration/status | Return `null`; UI must render an explicit missing-data state rather than guessing. |
| Tool output is very large | Return a bounded summary, not the full unbounded output. |
| Session has no token trend points | Return an empty `token_trend`; UI renders an explicit empty state. |
| Session has exactly one token trend point | Keep the single point; UI renders a single-point state instead of a misleading line chart. |
| Token trend point has no model attribution | Return/normalize `model: null`; UI keeps the default trend color and omits or blanks the model-specific hint. |
| CLI hook session id present but not yet in history | Keep the terminal's own loading/empty state; never show another session. |
| SSH realtime request already runs for the same session/transcript | Reuse the in-flight request; do not start overlapping full-history synchronization or clear the last valid detail. |
| No session id, but a hook already bound a CLI session this run | Show an explicit awaiting-identification empty state for the CLI terminal; do not borrow project latest. |
| No session id and no hook ever bound (no-hook environment) | Fall back to project latest-session lookup; do not blank the realtime stats panel. |
| Model pricing not found | Add all usage tokens to `unpriced_tokens`; do not estimate cost. |
| Explicit cost is present | Ignore it for CLI-Manager billing; calculate from local model prices when possible, otherwise add tokens to `unpriced_tokens`. |
| Date range exceeds 366 days | Return `date_range_too_large`. |
| `project_path` is empty or whitespace | Treat it as absent; do not filter by path. |
| `project_path` points to a configured project with Claude/Codex history | Return only sessions matching that project path using `session_matches_project_path`. |
| Two SSH projects have empty local paths or the same remote path on different source instances | Select exactly one by project ID and aggregate only its `source_instance_id + remote_path`. |
| Opening SSH project historical usage without manual refresh | Uses cached/fast remote sync and catalog aggregation; must not force a remote index rebuild or refresh the local history index. |
| Successful SSH remote history sync applies new catalog rows | Invalidates stats aggregation/daily caches before returning so the next stats read sees the new remote generation. |
| `project_path` and `project_key` are both present | Apply both filters; do not OR them together. |
| `project_paths` contains duplicates or differently ordered paths | Normalize, sort, and deduplicate before filtering and cache-key generation. |
| Parent path contains a configured Worktree path | A session matching both paths contributes once. |
| Active checkout has no latest history session but the project has configured paths | Load project-wide today usage from `project_paths`; do not gate it on `latestSession`. |
| Codex session lacks metadata cwd | Fall back to the path-derived project key. |
| History detail has no discoverable cwd | Return `cwd: null`; resume UI may fall back to a configured project match, otherwise show an error instead of opening a terminal in the wrong directory. |
| Codex rollout session lacks `session_meta.payload.id` | Fall back to the file-stem `session_id`. |
| Claude file contains a `session_meta.payload.id`-shaped field | Keep Claude's file-stem `session_id`; do not apply Codex identity normalization. |
| `aggregate_subtasks=true` but no sibling `subagents/agent-*.jsonl` exists | Return the parent single-file detail unchanged. |
| `aggregate_subtasks=true` and a child transcript has no timestamps | Order its usage/message/tool rows by that child file `updated_at` fallback. |
| Aggregated `tool_events` includes MCP end/error diagnostics | Keep them in diagnostics, but do not let them inflate `tool_call_count` / tool buckets. |
| Claude log has usage tokens but no explicit context limit field | Return `context_window: null`; frontend resolver may display a metadata/local limit separately. |
| Claude/Codex log exposes an explicit positive context limit field | Return that value as `context_window`; most recent exposed value wins during a scan. |
| Same session switches model after earlier usage dominates totals | Keep `dominant_model` as the aggregate/dominant model, but return the latest model as `current_model` for realtime display. |
| History cache invalidation runs | Clear file, stats, project, and aggregate caches together. |

### 5. Good/Base/Bad Cases

- Good: a Claude session with input/output/cache usage and known model produces complete totals, cost, model distribution, daily trend, and per-session message token fields.
- Good: a Codex session with multiple `token_count` events returns `token_trend` from cumulative high-water deltas, ignores temporary cumulative rollbacks, and two Codex windows in the same project show different realtime session details after their hook `sessionId` values arrive.
- Good: an SSH Claude/Codex Hook binds `sessionId` plus `remoteTranscriptRef`; the realtime panel polls only that JSONL and stays mounted while slower prior requests finish.
- Good: opening SSH historical usage for an already indexed project returns from `history-catalog.db` using `source_instance_id + remote_path`, reuses the aggregation cache on repeated opens, and does not scan local JSONL or force the remote Agent writer lock.
- Good: a Codex `response_item` assistant message followed by a `token_count` event returns the assistant `HistoryMessage` with inherited timestamp and normalized per-turn `input_tokens` / `output_tokens` / `cache_read_tokens`.
- Good: realtime Token Trend receives per-point model attribution and renders one continuous line with segment colors by model; hover tooltip shows the hovered point model.
- Good: a history detail payload exposes `cwd` when the JSONL contains session metadata, allowing the frontend to create a resume terminal in the original project directory.
- Good: a history detail payload includes `tool_events` for Claude `tool_use` and Codex `function_call` rows; missing per-call duration remains `null` and the frontend says no duration data is available.
- Good: a Codex rollout file with `session_meta.payload.id` returns that UUID as `session_id`, allowing realtime stats strict binding to match the hook session id; a Claude file with a similar metadata id still keeps its original file-stem identity.
- Good: realtime stats requests `history_get_session(..., aggregate_subtasks = Some(true))` for a parent session with `subagents/agent-*.jsonl`, and the returned token totals / trend / tool counts equal parent + child aggregate while `session_id` still matches the parent hook session id.
- Good: a Claude assistant usage row with `max_context_tokens` returns `usage.context_window`, while the same row without explicit context metadata leaves it `null`.
- Good: a session where `claude-old` appears in more usage rows but the last assistant row uses `claude-new` returns `dominant_model = "claude-old"` and `current_model = "claude-new"`.
- Good: StatsPanel selects a configured project path such as `D:\work\pythonProject\CLI-Manager`; frontend sends `projectPath`, backend matches Claude/Codex sessions through `session_matches_project_path`, and cache keys stay distinct from raw `projectKey` queries.
- Good: TerminalStatsPanel on the main or Worktree tab sends the same parent + active Worktree path set and displays one deduplicated project total.
- Base: a Codex session without model pricing still appears in stats with token totals and `unpriced_tokens`; a single-day stats view can map `hourly_activity` into 24 hourly trend and heatmap buckets.
- Bad: frontend assumes a newly added numeric field is always present and renders `NaN` when older cached payloads omit it; realtime stats uses only project latest-session lookup and shows another window's current context.
- Bad: a stats panel open passes `force=true` unconditionally, causing `history_get_stats` to rebuild indexes and repeatedly recompute fixed historical data.
- Bad: realtime stats concatenates parent and child `token_trend` arrays directly or derives tool totals from merged `tool_events`, causing out-of-order trend points or inflated tool-call counts.
- Bad: StatsPanel populates its dropdown from raw `history_list_stats_projects` values and sends those opaque keys for user-created project selection; this diverges from the left project tree and fails for path-normalized Claude/WSL/Codex sessions.
- Bad: realtime today-usage reuses `latestSession.project_key` as the only filter after the session was found by Worktree path; the path context is lost and usage may be omitted.

### 6. Tests Required

- Rust tests:
  - Date bounds accept a full 366-day range and reject larger ranges.
  - Codex session collection uses metadata `cwd` as project key when present.
  - `build_session_detail` exposes metadata `cwd` on `HistorySessionDetail`.
  - `build_session_detail(..., true)` keeps the parent session id/cwd but aggregates sibling subagent usage, trend, messages, and tool counts.
  - Session project cache reuses matching fingerprints.
  - Codex rollout files expose `session_meta.payload.id` as `session_id`, fall back to file stem when absent, and Claude files keep file-stem identity.
  - Case-insensitive ASCII search avoids per-message lowercasing regressions.
  - Claude streamed duplicate usage lines produce one total and one matching `token_trend` point.
  - Codex cumulative `token_count` events ignore smaller stale snapshots, retain the previous high-water mark, and produce delta totals matching the final cumulative usage.
  - Codex detail messages inherit outer `response_item` timestamps and receive the matching normalized `token_count` delta on the latest assistant message for transcript metadata display.
  - Token trend points preserve model attribution for same-session model switches and aggregate-subtask merged trends.
  - History stats bucket cross-day usage by event timestamp, so a continued Codex session remains visible and contributes tokens on every day where usage occurs, while counting the session once per queried range.
  - Parser semantic changes that affect persisted scan output bump `HISTORY_INDEX_CACHE_VERSION`.
  - History stats single/multi-path filtering reuses `session_matches_project_path`, canonicalizes cache keys, and counts overlapping matches once.
  - V2 stats facts accept an optional source-instance filter and exclude all sibling local/remote instances when it is present.
  - Remote source-instance stats do not refresh the local history index, can hit the aggregation cache, and cache invalidation happens after a successful `history_remote_sync` apply.
  - Tool event extraction returns bounded diagnostic rows for Claude `tool_use`, Codex `function_call`, `function_call_output`, and MCP end/error events without changing aggregate tool counts.
  - Claude explicit context-window fields populate `SessionStatsScan.context_window`; Claude usage without those fields keeps it `None`.
  - Same-session model switching keeps `dominant_model` unchanged for aggregate stats while exposing the latest model as `current_model`.
- Frontend checks:
  - `npm run build` must pass after payload/type changes.
  - Stats UI must render missing token/cost fields as zero, not `NaN`.
  - Realtime terminal stats passes `cliSessionId` into history lookup when present and keeps project fallback when absent; SSH also passes `remoteTranscriptRef`, skips sync/list discovery, and ignores stale scope results.
  - Realtime model/context cards can show model and context limit from loaded session/metadata while current context usage stays blank until tokens are bound.
  - Token trend UI renders explicit empty/single-point states when there are fewer than two trend points.
  - Tool diagnostics renders `tool_events` when present and renders a missing-duration state when `duration_ms` is absent.
  - History resume creates a new internal terminal with `claude --resume <id>` or `codex resume <id>` only after resolving a `cwd` from detail payload or configured project match.
  - Single-day stats must use `hourly_activity` for Token/cost trend and session heatmap; multi-day ranges must keep using `daily_series` and `heatmap`.
  - Historical usage project filter must render configured `Project`/`Group` data from `projectStore`; selecting a project sends `projectPath`, while project-ranking chart clicks may still send raw `projectKey`.
  - Historical usage selects configured projects by ID; SSH selection sends `remotePath`, synchronizes that remote project, and passes its returned source-instance ID into aggregation.
  - Local/WSL realtime today-usage must issue one request with the parent project path plus active Worktree paths and must not depend on `latestSession` when paths are available; SSH realtime must not issue that project-wide request automatically.
- Release checks:
  - `cargo test` must pass before tagging a release that changes history stats contracts.

### 7. Wrong vs Correct

#### Wrong

```rust
let day_start = stats_day_start_with_offset(summary.updated_at, day_offset);
```

This buckets every token in a long-running or cross-day session into the session file's final modified day.

#### Correct

```rust
let occurred_at = usage_event.timestamp_ms.unwrap_or(summary.updated_at);
let day_start = stats_day_start_with_offset(occurred_at, day_offset);
```

Use each deduped usage event timestamp for token/cost/model buckets, with `updated_at` only as a missing-timestamp fallback.

#### Wrong

```ts
const cost = raw.total_cost_usd.toFixed(2);
```

This crashes or renders `NaN` when older payloads omit `total_cost_usd`.

#### Correct

```ts
const cost = asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD);
```

Normalize at the store boundary so UI components only consume stable numeric fields.

#### Wrong

```ts
await fetchLatestProjectSessionDetail(projectPath, previous, "codex");
```

Project latest-session lookup can return another Codex window from the same project.

#### Correct

```ts
await fetchLatestProjectSessionDetail(projectPath, previous, "codex", terminalSession.cliSessionId);
```

Use the hook-provided CLI session id first. Project latest-session lookup is only a fallback when no session id exists at all; with an id present, a lookup miss keeps the terminal's own empty state rather than borrowing another session.

#### Wrong

```ts
await fetchHistoryStatsPayload({ sourceFilter, projectKey: selectedProject.name });
```

Configured project names are display labels and do not reliably equal Claude/Codex history keys.

#### Correct

```ts
await fetchHistoryStatsPayload({ sourceFilter, projectPath: selectedProject.path });
```

Use the configured project path for user project-list filtering; keep raw `projectKey` only for history-derived ranking interactions.

#### Wrong

```ts
await fetchTodayProjectStats(latestSession.project_key, sourceFilter);
```

This drops the Worktree path that was used to locate the active session.

#### Correct

```ts
await fetchTodayProjectStatsMerged(
  latestSession?.project_key ?? "",
  sourceFilter,
  [project.path, ...activeWorktreePaths],
);
```

The store sends one canonical `projectPaths` request. Backend path matching owns WSL/UNC normalization and ensures a session matching multiple paths is aggregated once.
