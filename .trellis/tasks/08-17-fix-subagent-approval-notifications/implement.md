# Implementation Plan

## Preconditions

- [x] Classify as a root-cause behavioral/cross-boundary fix.
- [x] Confirm the current branch is synchronized with its upstream (`0/0`).
- [x] Record that the working tree contains unrelated uncommitted remote-handoff work that must be preserved.
- [x] Run GitNexus impact analysis for every symbol before editing it; the local index refresh failed because `tree-sitter-kotlin` is unavailable, so the degradation and source/contract fallback are recorded.
- [x] Warn before editing if any impact result is HIGH or CRITICAL; the shared Hook fan-out was treated as HIGH risk.

## Implementation

- [x] Add a pure, testable approval classification and provisional-state model at the Rust Hook boundary.
- [x] Capture the local rollout byte baseline in the Hook client before control returns to Codex.
- [x] Add the bounded arbiter worker with injectable timing for tests and fail-open delivery behavior.
- [x] Route both local Hook listener events and admitted SSH Hook events through the same arbiter before daemon/status/notification fan-out.
- [x] Preserve immediate delivery for main-agent and explicit child approvals.
- [x] Resolve provisional records only from positively correlated child/session progress or completion.
- [x] Escalate unresolved provisional records exactly once after the grace deadline.
- [x] Confirm frontend status/toast/taskbar/system notification consumers need no duplicate heuristic; shared arbitration occurs before all notification consumers.
- [x] Add focused diagnostics that expose classification/resolution reason without logging prompts, credentials, or full payloads.

## Tests

- [x] Rust: main-agent permission is immediate.
- [x] Rust: explicit child permission is immediate.
- [x] Rust: ambiguous child permission is provisional.
- [x] Rust: matching progress resolves a provisional event without delivery.
- [x] Rust: rollout growth beyond the Hook-time baseline resolves a provisional event without reading transcript content.
- [x] Rust: unrelated child progress does not resolve it.
- [x] Rust: child stop and session completion clear the correct scope.
- [x] Rust: unresolved provisional event escalates once.
- [x] Rust: queue/worker failure fails open rather than dropping approval.
- [x] Rust: daemon task status is not set to `attention` for an auto-resolved provisional event and is set for confirmed/escalated events.
- [x] Frontend/Node: frontend status behavior remains covered by the shared admission boundary and TypeScript validation.
- [x] Run targeted Hook/daemon Rust tests.
- [x] Run targeted Node tests; no frontend behavior change required a new Node test in this fix.
- [x] Run `npx tsc --noEmit`.
- [x] Run `cargo check` in `src-tauri`.
- [x] Run `git diff --check`.

## Documentation And Review

- [x] Update `.trellis/spec/backend/cli-hook-contracts.md` with the approval arbitration invariant and test matrix.
- [x] Update `CHANGELOG.md` under `TEMP`.
- [x] Update `docs/功能清单.md` in the Hook/desktop-pet status section.
- [x] Run GitNexus change detection before commit when available; the unavailable index refresh and degraded source/diff review are documented.
- [x] Review the final diff against all pre-existing dirty hunks and ensure no unrelated work is reverted.

## Packaging

- [x] Build NSIS only, skipping MSI and update signing while reusing npm/Cargo caches.
- [x] Verify the installer exists under `src-tauri/target/release/bundle/nsis/`.
- [x] Do not stop the installed CLI-Manager process, copy into `F:\cli-manager`, or disturb user terminals.
