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
    project_key: Option<String>,
    range: Option<String>,
    start_at: Option<i64>,
    end_at: Option<i64>,
    config_dir: Option<String>,
) -> Result<HistoryStatsResponse, String>

pub async fn history_get_session(
    source: String,
    project_key: String,
    session_id: String,
    config_dir: Option<String>,
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
}

interface HistorySessionUsage {
  token_trend: HistoryTokenTrendPoint[];
}

interface TerminalSession {
  cliSessionId?: string;
}
```

### 3. Contracts

- Token fields are non-negative counts. Missing usage data must normalize to `0`.
- Claude Code JSONL streams one assistant message as multiple lines sharing the same `message.id` + `requestId`, each carrying identical usage. Usage must be counted **once** per `(message.id, requestId)` — both in aggregate stats (`scan_session_combined`) and per-message detail (`iter_session_messages` blanks token fields on duplicate lines). Without dedup, totals inflate ~3x on real data.
- Codex rollout token usage comes from `event_msg.payload.info.total_token_usage`, which is a **cumulative** session counter. Per-turn usage = adjacent diff; a shrinking cumulative value means session reset (take current value as the delta). Do not sum `last_token_usage` (duplicate events inflate it 2-5%).
- `HistorySessionUsage.token_trend` exposes per-usage **delta** points after the same dedup/diff rules used for totals. Skip zero-token points. Do not synthesize frontend trend points from final totals.
- Codex `input_tokens` **includes** `cached_input_tokens`. Extraction normalizes to non-cached input + `cache_read_tokens` (Claude semantics), so pricing applies uniformly with no source-specific input deduction.
- Usage lines without a model (e.g. Codex `token_count` events) attribute to the most recent model seen in the session (e.g. from `turn_context.payload.model`).
- The `<synthetic>` model (Claude error placeholder lines) must never enter model distribution or model attribution.
- Stats aggregates must include input, output, cache read, cache creation, estimated cost, and unpriced token counts at every exposed usage level: total, project, model, source, daily series, and hourly activity.
- Heatmap-compatible buckets must include `sessions`, `messages`, `level`, and `session_refs`. Daily heatmap buckets use `day_start_utc`; hourly activity buckets use `hour_start_utc` plus `hour` so the frontend can render 24-hour drilldowns without guessing local bucket anchors.
- `historyStore` must accept snake_case payload fields and legacy camelCase fallbacks when normalizing stats data. `normalizeDetail` must pass message token fields through (it previously dropped them, making per-session token panels read 0).
- Unknown or unsupported models must not fake a price. They contribute to `unpriced_tokens` and `total_cost_usd` remains unaffected unless an explicit cost exists in the source payload.
- Explicit cost fields from the source payload take priority over local model-price estimation. Explicit cost and token counts may live on different JSON levels (e.g. top-level `costUSD` + `message.usage`); extraction must merge them instead of returning the first matching candidate.
- Codex session project keys should prefer session metadata `cwd`; path-derived keys are only a fallback.
- Terminal realtime stats bind strictly to the current terminal's `TerminalSession.cliSessionId` (from CLI hook payload). When a session id is present, look up **only** that session; if it is not yet found in history (e.g. JSONL not flushed), keep that terminal's own empty/loading state and **never** fall back to a different session. Project-level "latest session" lookup is used only when the terminal has no session id at all.
- When the CLI hook chain is known to be active (any terminal has bound a `cliSessionId` this run) but the current CLI terminal has not yet received its own id, the realtime panel shows an explicit "awaiting session identification" empty state instead of borrowing the project's latest session — so newly opened sessions never display a neighbor window's data. Only a true no-hook environment (no terminal ever bound an id) keeps the project latest-session fallback.
- Stats date ranges may cover up to 366 days and must reject larger ranges with `date_range_too_large`.
- History index builds scan cache-miss files in parallel (`std::thread::scope`, worker count = `available_parallelism`); fingerprint-hit entries must still be reused without rescanning.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Missing usage field | Count tokens and cost as zero. |
| Older cached/frontend payload lacks hourly token/cost/session fields | Normalize missing hourly fields to zero counts and an empty `session_refs` array. |
| Usage field has unknown shape | Ignore unknown fields; keep the message/session readable. |
| Session has no token trend points | Return an empty `token_trend`; UI renders an explicit empty state. |
| Session has exactly one token trend point | Keep the single point; UI renders a single-point state instead of a misleading line chart. |
| CLI hook session id present but not yet in history | Keep the terminal's own loading/empty state; never show another session. |
| No session id, but a hook already bound a CLI session this run | Show an explicit awaiting-identification empty state for the CLI terminal; do not borrow project latest. |
| No session id and no hook ever bound (no-hook environment) | Fall back to project latest-session lookup; do not blank the realtime stats panel. |
| Model pricing not found | Add all usage tokens to `unpriced_tokens`; do not estimate cost. |
| Explicit cost is present | Use explicit cost and do not add those tokens to `unpriced_tokens`. |
| Date range exceeds 366 days | Return `date_range_too_large`. |
| Codex session lacks metadata cwd | Fall back to the path-derived project key. |
| History cache invalidation runs | Clear file, stats, project, and aggregate caches together. |

### 5. Good/Base/Bad Cases

- Good: a Claude session with input/output/cache usage and known model produces complete totals, cost, model distribution, daily trend, and per-session message token fields.
- Good: a Codex session with multiple cumulative `token_count` events returns `token_trend` as adjacent deltas, and two Codex windows in the same project show different realtime session details after their hook `sessionId` values arrive.
- Base: a Codex session without model pricing still appears in stats with token totals and `unpriced_tokens`; a single-day stats view can map `hourly_activity` into 24 hourly trend and heatmap buckets.
- Bad: frontend assumes a newly added numeric field is always present and renders `NaN` when older cached payloads omit it; realtime stats uses only project latest-session lookup and shows another window's current context.

### 6. Tests Required

- Rust tests:
  - Date bounds accept a full 366-day range and reject larger ranges.
  - Codex session collection uses metadata `cwd` as project key when present.
  - Session project cache reuses matching fingerprints.
  - Case-insensitive ASCII search avoids per-message lowercasing regressions.
  - Claude streamed duplicate usage lines produce one total and one matching `token_trend` point.
  - Codex cumulative `token_count` events produce delta totals and matching `token_trend` points.
- Frontend checks:
  - `npm run build` must pass after payload/type changes.
  - Stats UI must render missing token/cost fields as zero, not `NaN`.
  - Realtime terminal stats passes `cliSessionId` into history lookup when present and keeps project fallback when absent.
  - Token trend UI renders explicit empty/single-point states when there are fewer than two trend points.
  - Single-day stats must use `hourly_activity` for Token/cost trend and session heatmap; multi-day ranges must keep using `daily_series` and `heatmap`.
- Release checks:
  - `cargo test` must pass before tagging a release that changes history stats contracts.

### 7. Wrong vs Correct

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
