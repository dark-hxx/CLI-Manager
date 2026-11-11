# Optional Tap Web implementation plan

Goal: deliver the approved optional client while preserving classic Web and native execution boundaries.
Spec: `prd.md`, `design.md`, backend/web-service-contracts and frontend/ai-architecture-contracts.
Execution: inline, as required by `.trellis/config.yaml`; approval is the user's message following the optional-client proposal. Changelog uses TEMP without a release version bump.

- [x] Establish baseline targeted stream/conversation/reconnect tests and isolated dependency setup.
- [x] Test and extract pure browser HTTP/socket/types/terminal stream to shared modules; preserve classic explicit exports and cache side effects.
- [x] Add standalone app entry, scoped product/interaction record and bilingual interface. Test native key encoding/composition, session identity, draft storage and operation races before implementing their behavior.
- [x] Add authenticated device/project/session model, native project start/attach and bounded terminal replay. Reuse existing query/unicode/color rules and geometry ownership.
- [x] Add host-authoritative read-only transcript operation with exact live-session binding, capability/operation validation and bounded sanitized results. Reuse native history parsing. Test invalid context and no-binding behavior.
- [x] Build Tap session sidebar, terminal/chat workspace, composer, keyboard strip and lazy file/Git read panel with error/empty/offline states.
- [x] Test and mount /tap static fallback; add new build artifact to desktop resources, portable and release packaging; add classic entry link.
- [x] Run focused tests during each unit, then new/classic typechecks/builds, server/protocol tests and strict architecture gate. Record unavailable native platform checks accurately.
- [x] Run bounded desktop/phone browser verification against a temporary protocol fixture; fix observed defects; capture artifacts. Review data/operation/input boundaries.
- [x] Update Web contract, TEMP changelog, feature inventory, task verification and PR body.
- [x] Receive upstream Trellis one-shot approval for the two commits and Draft submission, conditional on detailed pre-submit review; complete the two-axis review and reproduced-defect regressions (`review.md`).
- [x] Execute the approved two commits, push only the contribution branch and submit [Draft PR #287](https://github.com/dark-hxx/CLI-Manager/pull/287). Verified OPEN/Draft, upstream master, fork/head and feature commit SHA; no merge/deploy.

Remain in progress for upstream review and the native/mobile/clean-install acceptance listed in `verification.md`; do not archive this task as fully accepted.

Evidence and environment qualifications: `verification.md`. Proposed commits: `refactor(web): share browser transport and terminal primitives`, then `feat(web): add optional Tap workspace`. No original Tap-Code source edits or unrelated upstream work are included.
