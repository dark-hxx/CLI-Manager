# Implementation Steps

1. Add main DB migration and shared `usage` module types, connection/write helpers, current-price query helper, and idempotent legacy backfill.
2. Add route request context, session extraction, protocol usage parsers and non-streaming record writes.
3. Add streaming collector while preserving response bytes and circuit/hot-switch behavior; record attempt/error status.
4. Import local `request_logs` into unified records; implement dedupe and session/project attribution reconciliation.
5. Route `history_get_request_log_stats`, `history_list_request_logs`, `history_get_stats` and today-project aggregation through unified query functions while preserving IPC compatibility.
6. Extend frontend types/store/components and add zh-CN/en-US strings for source/provider/model/quality states.
7. Add migrations/backfill/rollup and route logging diagnostics; update `CHANGELOG.md` `[TEMP]` and `docs/功能清单.md`.
8. Run `gitnexus_detect_changes`, Rust tests/check, TypeScript check and Trellis quality verification; do not commit.
