# Technical Design

## Data flow

`route_http` → request context / response usage parser → main DB `usage_records` → dedup + session attribution → unified history query → Tauri IPC → history store → StatsPanel/RequestLogsView/TerminalStatsPanel.

Local history remains `history_sync_request_logs` → `request_logs` → import into `usage_records(data_source=session_log)` during unified query/sync.

## Schema

`usage_records` uses a deterministic `record_id` primary key and nullable route/session fields:

- identity: `record_id`, `logical_request_id`, `data_source`, `source`, `event_key`
- attribution: `project_key`, `project_path`, `session_id`, `attribution_status`
- provider/model: `provider_id`, `provider_name`, `provider_type`, `requested_model`, `outbound_model`, `response_model`, `pricing_model`
- usage: four token counters, `token_semantics`, `usage_status`
- request: `status_code`, `outcome`, `error_code`, `is_streaming`, `started_at_ms`, `first_token_at_ms`, `completed_at_ms`, `duration_ms`, `attempt_index`, `attempt_count`, `degraded`
- timestamps: `created_at_ms`, `updated_at_ms`

Add indexes for timestamp, project, session, provider, source and logical request. Add `usage_daily_rollups` only for data older than the existing route detail retention window; retain dimensions needed by history charts. Costs are calculated at read time, never persisted as billing authority.

## Route capture

Capture requested model, session id and streaming before provider selection. Keep `effective_model_for_request` as outbound-model truth. For non-streaming, parse the buffered body before returning. For streaming, wrap the byte stream with a collector that forwards bytes unchanged and parses Claude/Codex/Grok SSE usage until EOF. Record every attempt that returns valid usage; record status-only rows for failures/missing usage.

Use a background/independent SQLite write with busy timeout. No database error may change the client response.

## Dedupe and attribution

Route valid usage wins over session-log usage. Dedup exact identity first, then session id + model + token tuple + bounded timestamp window. A route row with `usage_status=missing` does not suppress a later valid session row. Resolve route project fields after history sync by session id and normalized Windows/WSL/Worktree paths; unresolved rows remain `unattributed`.

## Compatibility

Keep existing IPC command names and payload fields. Extend request-log payloads with optional route/provider/attribution fields. Route provider DB logs remain readable during migration, and a one-time idempotent import seeds `usage_records`.

## Testing strategy

Add parser fixtures for non-stream and SSE variants, failover/attempt tests, dedupe tests, attribution/path tests, migration/backfill tests and unified aggregation tests. Run Rust checks/tests and TypeScript type checking; manual desktop language/time verification remains human-owned.
