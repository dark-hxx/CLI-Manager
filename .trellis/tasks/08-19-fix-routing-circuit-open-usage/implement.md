# Implementation Plan

1. Read the route, circuit, usage, history, request-log type/UI, and i18n
   contracts; confirm current symbol impact and existing test conventions.
2. Refactor key selection to return an explicit cooldown/unavailable result and
   update `forward_request` so candidate skips do not count as provider
   attempts or circuit failures while healthy later candidates remain eligible.
3. Preserve the existing all-candidates-unavailable fail-fast 503 and existing
   circuit accounting for requests that actually reach an upstream provider.
4. Add an explicit failed/skipped outcome to route usage recording and classify
   empty failed captures as `not_applicable`; keep successful missing usage as
   `missing` and keep data-quality aggregates from counting the new status.
5. Update `RequestLogItem`, request-log rendering, and `zh-CN`/`en-US` strings for
   the additive status.
6. Add focused Rust regression tests and frontend/type checks for the changed
   contracts.
7. Update `CHANGELOG.md` under `TEMP` and the routing/history section of
   `docs/功能清单.md`; run GitNexus change detection and the full required
   validation commands.

## Review gates

- No circuit failure is recorded for circuit-open, cooldown, or snapshot skips.
- Attempt budget counts only requests sent upstream.
- All candidates unavailable still returns `routing_provider_circuit_open`.
- A successful response without usage remains `missing`.
- A failed/skipped attempt without usage is `not_applicable`.
- Existing non-routing behavior and real upstream failure behavior are intact.
