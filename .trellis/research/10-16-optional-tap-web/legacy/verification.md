# Optional Tap Web verification

Date: 2026-10-16. Base: `2991fd4b8623c1185dd4c93f0d3ba227af76066e` (upstream V1.4.4). Branch: `feat/optional-tap-web`. Execution/review is inline per upstream `.trellis/config.yaml`; no independent sub-agent audit is claimed.

## Delivered scope

Independent `apps/web-tap` app at `/tap/`, Classic Web retained at `/`. Both reuse upstream Cookie/device authorization, operations and native PTY. New host capability is read-only `terminal.transcript`, not another conversation runtime. TEMP changelog, feature inventory, Web service contract and scoped design/README are updated. Submission is a Draft PR pending real-platform acceptance, not a claim of complete Tap-Code feature parity.

## Evidence

| Check | Result / assertion points |
|---|---|
| `npm run web:typecheck`, `npm run tap:typecheck`, `npx tsc --noEmit` | Passed; Classic, Tap and desktop bridge typechecked |
| `npm run web:build` | Passed; Classic root plus independent nested Tap index/assets produced |
| `npm run build` | Passed; desktop frontend Vite bundle produced. Existing large-chunk and mixed static/dynamic import warnings remain |
| `npm run tap:test` | Passed; four test files cover key/IME/paste rules, operation race/scope cancellation, viewport geometry and document-wide terminal-write scheduling |
| Targeted Classic/shared/host tests below | Passed; extraction compatibility, canonical transcript export and asynchronous context checks |
| Server `cargo test` | Passed: 56 unit + 5 reconnect + 1 optional static route tests |
| Protocol `cargo test` | Passed: 7 tests; existing wire serialization retained |
| `npm run check:architecture -- --strict` | Passed; 1378 source files, zero above 2000 lines, zero new violations. Final sandbox attempt hit Node child-process `EPERM`; the identical check passed outside the sandbox |
| `git diff --check` | Passed |
| Impeccable source detector | `[]` (no detector findings); desktop/phone screenshots inspected inline, not an independent audit |

Rust commands use the installed stable toolchain `/root/.cargo/bin/cargo` (1.99); the shell's `/usr/bin/cargo` is 1.75 and cannot compile current upstream dependencies. Server WebSocket/network and browser tests ran outside the network sandbox because loopback listeners are blocked inside it.

Targeted suite:

```bash
node --test \
  apps/web/src/reconnect.test.mjs \
  apps/web/src/requestId.test.mjs \
  apps/web/src/terminalStream.test.mjs \
  scripts/webProjectFiles.test.mjs \
  scripts/webTerminalImageBridge.test.mjs \
  src/shared/lib/webTerminalRenderQueue.test.mjs \
  src/features/terminal/lib/webTerminalTranscript.test.mjs \
  src/features/terminal/lib/webTerminalTranscript.integration.test.mjs \
  src/features/terminal/lib/webManagement.menu.test.mjs
cargo test --manifest-path apps/server/Cargo.toml
cargo test --manifest-path crates/web-protocol/Cargo.toml
```

## Browser acceptance

`browser-check.mjs` starts an ephemeral loopback HTTP/WebSocket fixture and serves the actual built apps. It does not start Tauri, invoke an installed CLI/model, use real credentials or modify any user project. Playwright/`ws` are test-harness dependencies supplied externally, not new runtime dependencies in the PR.

```bash
TAP_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
TAP_WS_MODULE=/path/to/ws/wrapper.mjs \
TAP_CHROMIUM=/path/to/chromium \
node .trellis/tasks/10-16-optional-tap-web/browser-check.mjs
```

Latest result after detailed review: `pass`, 10 input frames, 6 operations, 5001 burst frames in 4 xterm writes. This is a controlled batching assertion, not a real-CLI throughput benchmark. Coverage:

- Cookie login, session switch, scoped draft retention, reload/selected-session restore, manual reconnect preserving the active draft without re-sending input.
- IME Enter does not send; multiline becomes one bracketed paste followed by Enter; Shift+Tab and Ctrl+arrow encode native bytes. Chat uses that same PTY, never `conversation.*`.
- 360/390/430px widths have no page overflow. Desktop grid remains 80×24 with no browser resize; phone reading view and locally bundled narrow font load.
- Phone Enter inserts newline; arrow repeat stops on pointer cancellation. Ending canceled by the user, logout and authorization expiry never send close.
- New native session uses `project.start` with registered target ID and internal launch mode; no browser cwd/root/command fields are emitted.
- Device switch does not expose the previous device draft. Opening a mobile ticket does not redeem it; explicit confirmation scrubs URL and restricts the device inventory. Same-document hash navigation is covered.
- File text preview, lazy chat, light/dark, zh-CN/en-US, drawer focus/Escape, logout and WS 4401 cleanup.
- Synthetic visual-viewport contraction moves the app root by 280px without changing chat/terminal container height; blur restores the root. This is geometry simulation, not a real soft-keyboard test.
- Detailed review regressions: close target frozen across a delayed project start; mobile-authorization cancellation restores draft and full terminal replay; captured old input/resize/close callbacks cannot target a new device with colliding PTY IDs; old 401 headers/body cannot expire the new scope.
- Two real mounted xterms start batches on separate document frames. A controlled write failure followed by the actual retry button retains sibling renderer identity. Disconnect between paste and delayed Enter retains the draft and never resubmits it after reconnect.
- Composing/repeated/default-prevented Escape retains its sheet. A coarse-pointer phone restores readOnly on leaving direct input; deliberately rejected WOFF2 loading produces no unhandled error.

The existing Classic terminal smoke host was run through `classic-browser-check.mjs`, retaining its production assertions and real file-chooser interaction. Result: `passed`, 11 replay rounds; image preparation/conversion bounds, workspace push ordering, hidden/reconnect/geometry/query policy and 5001 output chunks merged to one xterm write. Temporary hosts were stopped afterward.

To reproduce Classic separately: start `node scripts/webTerminalRenderer.smoke.mjs`, then set `TAP_CLASSIC_SMOKE_URL` to its printed URL and run `classic-browser-check.mjs` with the same Playwright/Chromium env paths.

## Defects caught before submission

- Classic dynamic-source test loaders still pointed to the pre-extraction modules. Updated loaders to the shared HTTP/socket/request ID owners; behavior assertions remain intact.
- Manual reconnect cleared mounted content without resetting the selection restoration guard. Browser regression failed with no selected session, then passed after restoring the current authenticated selection.
- A mobile ticket navigated to in the already-open document was not handled by mount-only authentication. Added explicit hash handling and confirmed no automatic redemption.
- Project path or CLI source could change during transcript I/O. Regression checks now withhold old content after root, CLI ID or source changes; the source-change case failed before the fix.
- Incomplete terminal fragments could accumulate before the render queue's byte check. A failing test now locks the pre-assembly budget as well; overflow is an explicit terminal failure/replay action, never silent dropping.

## Environmental qualifications / not passed

- Full native Tauri `cargo check/test`, Windows/WSL live PTY/CLI binding and installer/portable execution are **not verified** here. `pkg-config` confirms missing `gtk+-3.0` and `webkit2gtk-4.1`. Rust server/protocol and desktop frontend builds do not substitute for these.
- Full server `cargo fmt --check` finds pre-existing upstream format drift in API/storage/reconnect sources. New static test is rustfmt-clean; new API hunks were formatted without rewriting unrelated code. Baseline/current API rustfmt output each has 87 lines / five existing format diffs (two image validators and old Git tests); hunk context and locations shift after the added branch.
- Local dependencies were installed with `--legacy-peer-deps`; temporary no-save `diff`/types supplementation was needed for the existing desktop type imports. Installed Node is v24.19.0; local Vite 7.3.7 and React 19.3.1 differ from the retained upstream lock resolutions (Vite 7.3.1 / React 19.2.4). Therefore the successful builds are not claimed as a clean locked-install build. Lock diff adds only workspace/link metadata and does not upgrade dependency resolutions. Both normal `npm ci --dry-run` and `--legacy-peer-deps` dry-run succeed; an actual clean locked-install build remains a separate gate.
- No real iOS/Android soft-keyboard, touch-scroll TUI, IME candidate panel, Home Screen launch, screen-reader or native CLI permission acceptance is claimed. Phone reading view is plain text, not a full ANSI-preserving emulator.
- Chat is available only if the existing native host has an exact Claude/Codex binding. No binding is guessed, no new hooks installed; full tool traces, queue, Push, usage and historical resume are outside this PR.
- Transcript reads use the existing persisted operation results. Sustained real CLI streaming / long-active-chat storage growth and mobile memory have not been benchmarked; fixture success is not a load-test result.

## Impact / review

The user's requested detailed pre-submit review is recorded in [review.md](review.md), separately along Standards and Spec axes. Eleven additional reproduced defects were fixed (3 Standards, 8 Spec); no known blocking finding remains within the validated Draft scope. This is inline author review, not an independent audit. The native/manual/clean-install gates above remain open.

GitNexus tools are not exposed in this environment. Per repository fallback, reviewed owning Web contracts and symbol references instead: Classic extraction/cache effects; optional app imports; server enabled kinds/static route isolation; native management validation/capability symmetry; build order/resources/portable copy. No auth schema, migration, device token exposure, structured conversation submission or native confirmation bypass was added.

Tap-Code's interaction experience is the reference, not a license grant. This patch includes no copied Tap-Code source/icon files; viewport code and icon PNGs are implemented/generated here. The only vendored font retains its OFL text. No commercial relicensing authority is asserted.

## Captures (controlled fixture, not a live CLI)

[Desktop conversation](screenshots/desktop-chat.png) · [Phone terminal](screenshots/mobile.png) · [Phone conversation](screenshots/mobile-chat.png) · [Phone navigation](screenshots/mobile-drawer.png)

## Authorized delivery / remaining acceptance

The user explicitly approved the two-commit plan, branch push and Draft PR, conditional on detailed pre-submit review. Review and regression gates are now satisfied for Draft submission: commit shared extraction, then optional client/host/docs, push only `feat/optional-tap-web` to the verified `nnnmdzz/CLI-Manager` fork and create the Draft against `dark-hxx/CLI-Manager:master`. Keep this task/worktree available for the unverified platform/clean-install acceptance and upstream review; do not archive it as fully accepted, merge or deploy automatically.

Submitted [Draft PR #287](https://github.com/dark-hxx/CLI-Manager/pull/287). Approved code commits: `579a17d` (shared extraction), `0c954db` (optional client). GitHub reports OPEN, `isDraft=true`, base `master`, head `nnnmdzz:feat/optional-tap-web`; remote SHA matches the feature commit. No checks were reported in `statusCheckRollup` at submission, so the passing checks above are local evidence, not a GitHub CI result. Session/task bookkeeping follows separately without changing implementation. Original Tap-Code remains at `1a3d946`, with only the three earlier untracked analysis documents; none was included in this PR.

## UI and interaction alignment round (2026-10-16)

The user asked to review the Tap Web UI/interaction against the current Tap-Code (`1a3d946`) and improve the experience. Tap-Code's phone and desktop screens were captured from its private preview with fake CLIs and compared side by side with this client against a deterministic protocol fixture; behavior was re-implemented here, no Tap-Code source files or icons were copied.

| Area | Change |
|---|---|
| Topbar | Per-session header: status glyph, title, connection dot, `project · cli · cols×rows` on phones; segmented chat/terminal toggle remembered per device (touch → chat, desktop → terminal); desktop crumb and +N −M side-panel chip; ⋯ menu with terminal font stepper, settings and an inline, session-bound end confirmation. Stop/settings no longer sit as one-tap topbar icons. |
| Dock | Key strip moved above the composer, terminal view only (touch default, settings switch) and hidden while writing; composer "+" menu (image, type directly), labelled interrupt (Esc for Claude Code/Codex), round send; status row with size, project, branch, +N −M only. |
| Navigation | Sidebar with search, CLI brand icons from the shared `CliToolIcon`, running counts, mounted-session marks, worktree badges, device menu instead of a native select. Phone drawers open from the screen edges and close by dragging. |
| Panels | Side panel (Details / Changes / Files) docks at ≥1152px, floats otherwise, slides from the right on phones; Git letters, read-only diff and file preview with a back header. Git status is shared per project context, read on activation/visibility/after sending, never polled. |
| Conversation | Turns group interim replies into one fold row, footer with copy and 24-hour time, clamped long prompts, jump-to-latest with unread dot, notices with an "open terminal" action. |
| Overlays | No `inert`/`showModal()`; overlay stack handles Escape/Tab/focus restore; menus and sheets animate in and out; settings use theme tiles, segmented control, steppers and a switch. |

| Check | Result |
|---|---|
| `npm run web:typecheck`, `npm run tap:typecheck`, `npm run web:build` | Passed |
| `npm run tap:test` | Passed, 14 tests (new `format.test.mjs`: model names, 24-hour footers, reading-view rules, turn grouping) |
| `browser-check.mjs` (selectors updated for the new UI; key strip asserted in terminal view; end confirmation is now dismissed instead of retargeted when another session takes focus) | `pass`, 5001 frames batched into 3 writes |
| Phone gestures (CDP touch): left/right edge swipe opens, drag closes | Passed |
| `npm run check:architecture -- --strict`, `git diff --check` | Passed (1391 files, none above 2000 lines) |

Still pending as before: Windows/WSL real CLI binding, real iOS/Android keyboards and touch, installer/portable launch.

## Ready for review (2026-10-16)

The user approved moving PR #287 out of Draft. GitHub reported `MERGEABLE` / `CLEAN` with no status checks (upstream has release workflows only) and no reviews yet. The three platform items that cannot be run on this Linux host (Windows/WSL real CLI binding and permissions, installer/portable launch with the new `apps/web/dist/tap` resources, real iOS/Android keyboards/touch/PWA through that desktop host) remain unchecked and are handed to the maintainer in the PR body; they are not claimed as verified.
