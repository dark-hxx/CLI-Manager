# Technical Design

## Scope and invariants

This is a root-cause fix across the daemon routing boundary and the route usage
recording boundary. Existing provider order, circuit thresholds, cooldown
timers, half-open recovery, and the local `/v1/responses` error contract remain
unchanged. When every candidate is unavailable, the daemon still returns the
existing fail-fast `503 {"error":"routing_provider_circuit_open"}` response.

## Routing candidate state

`RouteState::select_key` will expose why a provider cannot be attempted instead
of collapsing every empty-key result into `KeyExhausted`:

- `Ready(key)`: a request can be sent.
- `Cooldown`: keys exist but all are temporarily cooling down.
- `Unavailable`: no valid/enabled key exists.

`forward_request` will maintain a queue cursor separately from the actual
provider-attempt counter. `Cooldown` and circuit-open candidates advance only
the cursor and emit a status-only skip record. They do not call
`record_circuit_failure` and do not consume the retry/attempt budget. Only a
request that was sent upstream may increment circuit failure or the actual
attempt counter. Existing upstream transport/status/stream failures keep their
current circuit behavior and failover ordering.

The final error path records the logical request outcome without pretending that
the router made another upstream attempt. The all-unavailable path remains
fail-fast and does not probe a cooling/open provider.

## Usage status contract

`record_route_usage` will distinguish request outcomes from response-data
quality:

- successful response with no usage: `missing` (existing meaning);
- failed or skipped route attempt with no usage: `not_applicable`;
- failed attempt with a captured partial usage: existing `partial`/`invalid`
  rules continue to apply.

`not_applicable` is persisted as a new `usage_status` value and excluded from
missing-usage quality counts. No schema migration is needed because the status
is stored as text. The route usage payload gains an explicit outcome/failure
classification at the Rust boundary so callers do not infer it from an empty
capture.

## Frontend compatibility

`RequestLogItem.usage_status` gains `not_applicable`. The request log UI maps it
to localized `Usage not applicable` / `Usage 不适用`; existing `missing`,
`partial`, `invalid`, and `complete` labels remain unchanged. The type change
is additive and all existing payloads remain valid.

## Verification and rollback

Add focused Rust tests for candidate skipping, attempt accounting, fail-fast
when all candidates are unavailable, real upstream failure circuit accounting,
and usage status classification. Add/adjust frontend type/UI tests where the
repository test harness supports them. Run `cargo fmt --check`, targeted Rust
tests, `cargo check`, and `npx tsc --noEmit`.

Rollback is a source revert: no database migration, persistent protocol, or
provider configuration change is introduced.
