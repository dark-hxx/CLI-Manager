# Implementation Plan

1. Define shared frontend/Rust request, snapshot, MCP, Skill, health, bridge, and error contracts with boundary validation and redaction tests.
2. Add the backend capability service, environment runners, five Agent adapters, fixed native inspect/probe commands, timeouts, and in-memory request handling.
3. Add `agent-capabilities-v1` to the SSH Agent protocol and implement remote inspection/probing without changing the legacy two-Agent SSH source resolver.
4. Extend hook source validation/binding and managed hook settings for OpenCode plus remote Pi/Grok/OpenCode Session ID reporting.
5. Add the real-time summary card, modal, cache/stale-response handling, card settings migration, accessibility, and zh-CN/en-US copy.
6. Add adapter fixtures, boundary/timeout/protocol tests, frontend state/UI tests, and scenario regressions.
7. Update Trellis contracts, `[TEMP]` changelog notes, and feature inventory; run targeted TypeScript/Rust checks and GitNexus change detection.

## Impact Guardrails

- `inferHookBindingSource`: MEDIUM; direct consumer is `terminalStore.ts`, requiring session-binding regression coverage.
- `resolveSshToolSource`: CRITICAL; do not edit. Use an additive diagnostic Agent mapping.
- `normalize_source` in the hook receiver: LOW; validate all five sources and existing notification/daemon flows.
- Preserve unrelated Native Provider work already present in the working tree.
