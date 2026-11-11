# Detailed pre-submit review

2026-10-16 · `feat/optional-tap-web` · base `2991fd4b8623c1185dd4c93f0d3ba227af76066e`.

Requested by the user's “確認，提交之前再詳細複審一遍”, after approving the two-commit plan and Draft submission. Inline author review per upstream `.trellis/config.yaml`; no independent reviewer/sub-agent audit is claimed. Review includes tracked working changes and every new task/source file, not the empty pre-commit `base...HEAD` diff.

Standards sources: `AGENTS.md`, frontend architecture/comment/hook/quality contracts, backend Web-service/output-scheduling contracts and the fix-triage guide. Spec source: this task's `prd.md` R1–R7 and `design.md`. GitNexus is unavailable; owning contracts plus symbol references supply the impact/discovery map.

## Standards

Three reproduced findings, all fixed; zero known blocking findings remain in the checked scope.

| Finding / owner | Root cause and change | Regression evidence |
|---|---|---|
| S1 · Transcript wire safety · `webTerminalTranscript.ts` | A UTF-16 slice could split an emoji into a lone high surrogate rejected by Rust JSON. Omit that incomplete surrogate at the text-export boundary, retaining the truncation flag. | `3999 × a + 🚀 + remainder` failed before the fix; the four transcript unit cases pass afterward. Canonical text filtering and byte bounds remain unchanged. |
| S2 · Output batching · `Terminal.tsx` | Awaiting one xterm write for every tiny frame multiplied callback cost. Coalesce adjacent same-grid frames within 256 KiB encoded data, preserving reset/grid boundaries and callback-based cursor advancement. | Actual 5001-frame burst failed the 5-second drain assertion before; production browser passes with 4 writes afterward. |
| S3 · Document-wide write ownership · `terminalWrites.ts`, `Terminal.tsx` | Per-renderer starts violated the one-start-per-frame contract. Add a Tap-private document scheduler with three-batch visible priority, hidden/stalled-rAF timers, wake and disposal cancellation. | Two real xterms previously started in one frame; now start on separate frames. Three direct scheduler tests pass, including fairness/timer/cancel. Native and Classic schedulers were not refactored. |

Other checks: explicit Classic compatibility exports preserve cache invalidation/file-operation events; neither client imports the other's views/model. No unbounded render assembly, browser-owned host root, native confirmation bypass, debug logging, generated-code exemption or unrelated formatting was added. Reviewed naming/reuse/state ownership against the code-review smell baseline; no additional actionable smell is recorded. Strict architecture and all affected typechecks pass; exact environmental qualifications are below.

## Spec

Eight reproduced findings, all fixed; zero known blocking findings remain in the checked scope.

| Requirement / finding | Root cause and fix at owner | Failed-before / passing-after evidence |
|---|---|---|
| R2 · Frozen close target · `App.tsx` | Confirmation used current selection, which a delayed launch could replace. Snapshot scope/session/title on open; clear on device/account change. | Expected `pty-a` but sent close to `pty-created-2`; now closes only the displayed original. |
| R4 · Authorization cancellation replay · `useWorkspace.ts` | Auth screen unmounted xterm but retained its consumed cursor. Cancellation resets the socket scope for full replay; draft remains; disable cancel during redemption. | Terminal was blank on cancel; fixture now sees restored screen and draft. |
| R4 · Stale callbacks · `useWorkspace.ts` | Delayed handlers read the newly selected mutable device. Require captured account/device/auth generation and active/mounted input/resize ownership. | Old model input returned true across colliding device PTY IDs; now input/resize/close are rejected. |
| R3 · Escape ownership · `Sheet.tsx` | Capture listener dismissed before IME/child controls could consume Escape. Use bubble phase and ignore composing/repeat/defaultPrevented/keyCode229. | IME Escape dismissed the sheet; all ownership cases now retain it. |
| R4 · Isolated renderer retry · `useWorkspace.ts` | Clearing activeId switched App's whole workspace branch, disposing healthy cached siblings. Remove only the failed mount while retaining the branch. | Real retry button after injected xterm write failure disconnected the sibling; now its DOM identity stays connected. |
| R3 · Phone direct-input exit · `Terminal.tsx` | Toggle-off blurred xterm without restoring its readonly/inputMode policy. Restore coarse-pointer policy; reflect pressed/disabled state. | Phone textarea remained writable after off; now readonly. |
| R3 · Optional font failure · `Terminal.tsx` | FontFaceSet promise lacked rejection handling. Retain resident font and schedule layout on optional-font failure. | Aborted WOFF2 caused an unhandled NetworkError; now no page error and terminal stays usable. |
| R4 · Late unauthorized flight · `useWorkspace.ts` | Disposed workspace refresh could invoke global expire after 401 headers arrived and its body was aborted. Ignore errors from the disposed owner, as already done for successful refresh results. | Old device 401 removed the new `.tap-app`; same delayed-header/body fixture now retains the new scope. |

No out-of-scope Tap-only queue/Push/SSH/automatic approval or alternate conversation sender was introduced. R1 routing/build compatibility, R5 exact transcript authority and R6 read-only detail boundaries remain intact. Lack of real platform acceptance is disclosed, not counted as a passing requirement.

## Discovery / touchpoint checklist

- [x] Scope lifecycle: `useWorkspace` refresh/cleanup, operation runner cancel, shared HTTP body failure, socket close listeners, `App` scope/confirmation. Shared HTTP remains unchanged; Classic's independent auth/cache behavior is confirmed unrelated to the late-401 owner fix.
- [x] Terminal lifecycle: renderer batching/reset/grid/cursor, scheduler token, stream assembly limits, session mount/retry, direct input and optional font. Native `useTerminalDisplay` scheduler is private and is confirmed unrelated to the Tap implementation; no desktop-store import introduced.
- [x] Input: Composer/Terminal delayed paste-Enter, KeyBar repeat cleanup, image scope checks. Controlled disconnect preserves the draft and sends no delayed Enter or reconnect retry.
- [x] Read boundary: host context/PTY/source/CLI/root revalidation after I/O; transcript text export; server allowlist/cursor/capability and both native capability publishers. Existing parsers and structured-conversation sender are confirmed unchanged.
- [x] Distribution/compatibility: shared DTO/HTTP/socket/stream/image extraction, Classic cache/event wrappers and loaders, `/tap/` SPA/assets isolation, root build order, Tauri resources, portable preflight. No auth DB/migration/credential change.

## Scenario coverage and evidence

Final production browser result: `pass`, 10 input frames, 6 operations; 5001 frames coalesced to 4 writes. Includes desktop/360–430px, light/dark, both languages, IME/native keys, mobile reading/direct modes, drawers/focus, logout/4401, reconnect, explicit ticket redeem/cancel and the adversarial races above. Classic's separate production-component smoke passed 11 replay rounds, real image chooser/conversion and 5001-to-one batching.

Final affected checks: Classic/Tap/root TypeScript; Tap's four test files plus nine targeted Classic/shared/host test files; Rust server 56 unit + 5 reconnect + 1 static, protocol 7; strict architecture 1378 sources, zero >2000 lines/violations; `git diff --check`. The architecture check initially hit sandbox Node child-process EPERM, then passed unchanged outside it. Full commands and build/detector/screenshot evidence are in `verification.md`.

Not verified: native Tauri (missing GTK/WebKitGTK), real Windows/WSL CLI/permissions, actual iOS/Android IME/soft keyboard/touch/PWA, screen reader, installers/portable runtime, long-chat storage/mobile memory and a clean locked-install build. Existing upstream rustfmt drift and locally supplemented/different dependency versions are explicitly recorded in `verification.md`; no clean-CI claim is made. SSH/handoff and unsupported/unbound chat remain intentionally unavailable, not guessed or silently replaced.

## Submission decision

Standards: 3 fixed, 0 known blockers. Spec: 8 fixed, 0 known blockers. Proceed only with the user-approved two commits and **Draft** PR; keep real-platform and clean-install acceptance open. No merge, deployment, native installation or task archival as fully accepted.
