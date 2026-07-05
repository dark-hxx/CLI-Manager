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
- Codex rollout token usage comes from `event_msg.payload.info.total_token_usage`, which is a **cumulative** session counter. Per-turn usage = adjacent diff; a shrinking cumulative value means session reset (take current value as the delta). Do not sum `last_token_usage` (duplicate events inflate it 2-5%).
- For `history_get_session` message details, Codex `response_item` messages must inherit an outer wrapper timestamp when the inner payload has none, and deduped Codex `token_count` deltas should backfill the latest assistant message that has no token fields. This keeps transcript bubbles able to show `MM/DD HH:mm  in N / out N / cache N` without changing aggregate totals.
- `HistorySessionUsage.token_trend` exposes per-usage **delta** points after the same dedup/diff rules used for totals. Skip zero-token points. Do not synthesize frontend trend points from final totals.
- `HistorySessionUsage.token_trend[].model` should carry the model attributed to that usage delta when known. Realtime Token Trend can use it for per-segment coloring and tooltip model names. Missing model normalizes to `null` and must fall back to the default trend color.
- Codex `input_tokens` **includes** `cached_input_tokens`. Extraction normalizes to non-cached input + `cache_read_tokens` (Claude semantics), so pricing applies uniformly with no source-specific input deduction.
- Usage lines without a model (e.g. Codex `token_count` events) attribute to the most recent model seen in the session (e.g. from `turn_context.payload.model`).
- `HistorySessionUsage.dominant_model` is an aggregate model signal and must not be reused as the realtime "current model". `HistorySessionUsage.current_model` tracks the latest non-synthetic model seen in the session; realtime model/context display should prefer it so same-session model switches update context-limit fallback and remaining-space calculation without changing historical model distribution semantics.
- The `<synthetic>` model (Claude error placeholder lines) must never enter model distribution or model attribution.
- Stats aggregates must include input, output, cache read, cache creation, estimated cost, and unpriced token counts at every exposed usage level: total, project, model, source, daily series, and hourly activity.
- History stats token/cost/model aggregates must bucket by each deduped usage event timestamp (`timestamp`, `time`, `created_at`, `createdAt`, or `message.timestamp`), not by the session file `updated_at`. If a usage event has no parseable timestamp, fall back to the session `updated_at`. Range-level `sessions` must be counted by unique session identity so multiple usage events in one session do not inflate session counts.
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
- When the CLI hook chain is known to be active (any terminal has bound a `cliSessionId` this run) but the current CLI terminal has not yet received its own id, the realtime panel shows an explicit "awaiting session identification" empty state instead of borrowing the project's latest session — so newly opened sessions never display a neighbor window's data. Only a true no-hook environment (no terminal ever bound an id) keeps the project latest-session fallback.
- Realtime model/context-limit display may use the loaded session's model or exact limit and then fall back through model metadata/local rules, but current context usage and token totals must stay gated by `tokensBound` so another terminal's token counts are never shown.
- Stats date ranges may cover up to 366 days and must reject larger ranges with `date_range_too_large`.
- History index builds scan cache-miss files in parallel (`std::thread::scope`, worker count = `available_parallelism`); fingerprint-hit entries must still be reused without rescanning.

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
| No session id, but a hook already bound a CLI session this run | Show an explicit awaiting-identification empty state for the CLI terminal; do not borrow project latest. |
| No session id and no hook ever bound (no-hook environment) | Fall back to project latest-session lookup; do not blank the realtime stats panel. |
| Model pricing not found | Add all usage tokens to `unpriced_tokens`; do not estimate cost. |
| Explicit cost is present | Ignore it for CLI-Manager billing; calculate from local model prices when possible, otherwise add tokens to `unpriced_tokens`. |
| Date range exceeds 366 days | Return `date_range_too_large`. |
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
- Good: a Codex session with multiple cumulative `token_count` events returns `token_trend` as adjacent deltas, and two Codex windows in the same project show different realtime session details after their hook `sessionId` values arrive.
- Good: a Codex `response_item` assistant message followed by a `token_count` event returns the assistant `HistoryMessage` with inherited timestamp and normalized per-turn `input_tokens` / `output_tokens` / `cache_read_tokens`.
- Good: realtime Token Trend receives per-point model attribution and renders one continuous line with segment colors by model; hover tooltip shows the hovered point model.
- Good: a history detail payload exposes `cwd` when the JSONL contains session metadata, allowing the frontend to create a resume terminal in the original project directory.
- Good: a history detail payload includes `tool_events` for Claude `tool_use` and Codex `function_call` rows; missing per-call duration remains `null` and the frontend says no duration data is available.
- Good: a Codex rollout file with `session_meta.payload.id` returns that UUID as `session_id`, allowing realtime stats strict binding to match the hook session id; a Claude file with a similar metadata id still keeps its original file-stem identity.
- Good: realtime stats requests `history_get_session(..., aggregate_subtasks = Some(true))` for a parent session with `subagents/agent-*.jsonl`, and the returned token totals / trend / tool counts equal parent + child aggregate while `session_id` still matches the parent hook session id.
- Good: a Claude assistant usage row with `max_context_tokens` returns `usage.context_window`, while the same row without explicit context metadata leaves it `null`.
- Good: a session where `claude-old` appears in more usage rows but the last assistant row uses `claude-new` returns `dominant_model = "claude-old"` and `current_model = "claude-new"`.
- Base: a Codex session without model pricing still appears in stats with token totals and `unpriced_tokens`; a single-day stats view can map `hourly_activity` into 24 hourly trend and heatmap buckets.
- Bad: frontend assumes a newly added numeric field is always present and renders `NaN` when older cached payloads omit it; realtime stats uses only project latest-session lookup and shows another window's current context.
- Bad: realtime stats concatenates parent and child `token_trend` arrays directly or derives tool totals from merged `tool_events`, causing out-of-order trend points or inflated tool-call counts.

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
  - Codex cumulative `token_count` events produce delta totals and matching `token_trend` points.
  - Codex detail messages inherit outer `response_item` timestamps and receive the matching `token_count` delta on the latest assistant message for transcript metadata display.
  - Token trend points preserve model attribution for same-session model switches and aggregate-subtask merged trends.
  - History stats bucket cross-day session usage by usage event timestamp while counting the session once for range totals.
  - Tool event extraction returns bounded diagnostic rows for Claude `tool_use`, Codex `function_call`, `function_call_output`, and MCP end/error events without changing aggregate tool counts.
  - Claude explicit context-window fields populate `SessionStatsScan.context_window`; Claude usage without those fields keeps it `None`.
  - Same-session model switching keeps `dominant_model` unchanged for aggregate stats while exposing the latest model as `current_model`.
- Frontend checks:
  - `npm run build` must pass after payload/type changes.
  - Stats UI must render missing token/cost fields as zero, not `NaN`.
  - Realtime terminal stats passes `cliSessionId` into history lookup when present and keeps project fallback when absent.
  - Realtime model/context cards can show model and context limit from loaded session/metadata while current context usage stays blank until tokens are bound.
  - Token trend UI renders explicit empty/single-point states when there are fewer than two trend points.
  - Tool diagnostics renders `tool_events` when present and renders a missing-duration state when `duration_ms` is absent.
  - History resume creates a new internal terminal with `claude --resume <id>` or `codex resume <id>` only after resolving a `cwd` from detail payload or configured project match.
  - Single-day stats must use `hourly_activity` for Token/cost trend and session heatmap; multi-day ranges must keep using `daily_series` and `heatmap`.
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
