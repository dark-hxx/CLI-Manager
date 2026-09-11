# 1.3.10 mobile regression follow-up — 2026-09-11

## Second regression follow-up

- Root cause (geometry): hidden tabs skip reportSize, so desktop/Web ownership
  changes can retain the old Web workspace key after the incoming grid changed.
  The next activation consequently skips grid restoration. Temporary 14px
  measurement must also invalidate the display cache before its early return.
  Invalidate both caches on visibility/control transitions; output-only updates
  and display preferences still do not repeatedly resize the PTY.
- Root cause (images): desktop typed the saved path via socket.write, bypassing
  xterm paste framing; Web considered HTTP acceptance successful preparation.
  Desktop now returns an explicit browser_paste result without input side effects.
  Web polls the existing authenticated operation endpoint (30s deadline), validates
  the original device/session and result marker, then invokes that xterm's paste.
  No Enter, no automatic retry of input, no silent legacy-result double injection.
  Hidden/disposed or disconnected destinations fail instead of targeting another tab.
  Submission feedback is NOT proof that the CLI recognized an image attachment.
- Discovery: WebTerminal (visibility/metrics/paste), useAppModel (operation completion),
  views (return type), webClient (existing GET endpoint), useWebDeviceBridge (prepare
  only) changed. Server get_operation ownership/device-scope authorization verified
  unchanged; file_attach_data and shell quoting reused; desktop input serves as
  reference; mobile native chooser, PTY protocol, output scheduler, hooks and
  installer cleanup logic unchanged by this fix.
- Scenarios: visible/hidden ownership roundtrip, split/unsplit, narrow/wide/short,
  manual/width/contain, keyboard viewport, image preparation running/success/failure,
  missing session, ordinary/bracketed paste tested. WSL path conversion and actual
  iPhone Safari/CLI attachment badge remain unverified; no universal support claim.
- GitNexus unavailable; memory traces flag reportSize/WebTerminal as critical
  callers. Source/contracts and focused browser tests establish the actual scope.
  Branch remains ahead 36 / behind 56 before this fix; no remote synchronization.
- npm run build and npm run web:build passed. Browser renderer and subagent suites
  passed with zero browser errors. Added --geometry-baseline removes only cache
  invalidation in the test server and FAILS at hidden ownership stale-grid assertion;
  fixed code passes the same assertion. No checkout/source mutation for baseline.
- webTerminalImageBridge.test.mjs passes preparation-only/no-write, save error and
  missing-target assertions. Renderer checks submitted -> running -> succeeded,
  failed operation, actual xterm input and bracketed-paste bytes. Native file chooser
  is driven by a trusted Chrome click, not an assertion on click handler presence.
- An initial test failure was test-state contamination: new paste assertions left
  input history and bracketed mode enabled before the existing IME test. Reset both
  between scenarios; complete rerun passed. Physical iPhone testing not performed.
- Packaging requires a newly built desktop executable, because the desktop bridge
  is embedded frontend code. Reusing the installed main executable is not valid.

## Safari live verification follow-up

- Root cause: Safari may discard or retain a blank xterm canvas bitmap while a
  terminal frame is hidden with visibility:hidden. The terminal buffer and session
  remain valid, so grid-cache invalidation alone cannot restore pixels. On activation,
  redraw rows 0..rows-1 after the visible layout frame. No replay or PTY resize is sent.
- The authenticated production backend stayed on 100.95.251.17:9090. A separate
  Vite frontend on 100.95.251.17:5173 proxied API/WebSocket traffic while rewriting
  only the development request Origin to the configured production Origin. The user
  verified repeated switching between two real terminal tabs on iPhone Safari.
- Mobile ProjectTree now initializes all groups and projects containing Worktrees as
  collapsed when mounted in the drawer. Desktop Web retains expanded defaults; users
  can still expand, select, and launch project/Worktree entries.
- User confirmed both real-device behaviors. Automated checks: Web typecheck;
  renderer full-canvas refresh assertion; phone drawer default-collapse plus manual
  expansion/selection/launch; existing phone/subagent geometry regression suite.
- The temporary Node/Vite listener was identified by port, executable path, and PID,
  stopped after acceptance, and port 5173 was verified released before packaging.

User authorized implementation and rebundling under the existing Web task.
Branch feat/web-management-capabilities-v2 is ahead 35 / behind 56 relative to
the locally recorded origin/master. No synchronization or remote push.

## Root causes and discovery

- WebTerminal/styles: the xterm element retains full grid height for manual
  display, but the outer viewport hid vertical overflow. Restore outer scrolling,
  arbitrate touch and wheel input, maintain bottom position during font changes,
  and make the bottom control reach both xterm history and the outer viewport.
- MobileTerminalInput: a display:none file input was activated by script. Replace
  this compatibility-sensitive entry with a full-size transparent native file
  input directly hit by the user. Safari-specific causality is not proven locally.
- WebTerminal/views/App/useAppModel: image decoding/compression could reject
  without user feedback. Preserve the async result across the real call chain,
  display localized status, decode via Image/object URL, bound JPEG compression
  attempts to five and payload to the existing 180000-byte limit. Reject stale
  uploads if the target session/device has changed. Unsupported phone codecs
  remain an explicit error rather than a claim of universal HEIC support.
- App back navigation called closeTerminal; selectDevice detached all tabs even
  for the same device. Back now only changes page; selecting the same device
  preserves tabs and active selection. Cross-device navigation retains existing
  detach semantics. Tab X still uses the existing close protocol.
- Confirmed unchanged: backend API/PTY protocol, desktop rendering and Hook
  behavior, server authorization, database, installer cleanup hooks.
- GitNexus is unavailable. Memory fast index refreshed; inbound traces returned
  no useful frontend callers, so source cross-references, contract reads and
  real-component browser tests are the evidence for scope.

## Verification

- Web typecheck and production build passed (existing chunk-size warning only).
- Expanded scripts/webTerminalRenderer.smoke.mjs passed in isolated Chrome:
  real App back arrow -> hosts -> same device retains two tabs and active tab,
  zero close commands on back, tab X emits exactly one close.
- Real useAppModel image operation tested: small PNG; large/empty-MIME phone
  image with createImageBitmap unavailable; bounded conversion; unsupported
  image rejects before operation submission.
- 390px browser with touch emulation: real native file input hit area and
  trusted browser click produce Page.fileChooserOpened; repeated selection,
  success/failure messages, both touch axes, 250px keyboard-height viewport,
  bottom anchoring and bottom-button reachability pass.
- Existing renderer checks pass: 12 grid geometries, ownership handoff without
  display-triggered PTY resize, history scrolling, replay/reconnect, query and
  cursor policies, Chinese/English display switch, 11 replay/disposal rounds,
  5001 coalesced frames, IME, directions and disabled-draft preservation.
- scripts/webSubagentPanel.smoke.mjs passes wide/phone/landscape/keyboard
  geometry, project drawer, split collapse and toolbar controls. Narrow screenshot
  visually inspected; last input row and native image icon are visible.
- Earlier harness failures were corrected: missing Markdown prebundling after
  importing App, selection of project icon instead of back arrow, and incomplete
  synthetic touch events. Final run has zero browser errors.
- Physical iPhone Safari album selection and real host image attachment are not
  claimed as tested. Browser tests use actual components with isolated transport.

## Packaging baseline

The accidentally deleted release directory was repopulated from the user's
existing F:/cli-manager installation (file/product version 1.3.10). No running
process was stopped. Only Web assets are rebuilt; installed executable behavior
is preserved. SHA256 before bundling:

- cli-manager.exe: CA7FD013D127452AC41B152967121BE2E4BC8F652C647AEA1FDE750235CBC016
- cli-manager-daemon.exe: 2734E75C8ED433CC38BB68E54A7B7B461A42FEE97B5AF2558D35CDABABD6FA57
- cli-manager-web-daemon.exe: BC8A1284C1094802472F46E76F0A4D97F12F5BAD88AE4F9EB2260D59D6711BBA
- cli-manager-codex-proxy.exe: 02207E56FAE6DC6BFC322D936A42BFA76EF22A71048A2AEA2872D94471C4CFA4

Rebundle command: npm run tauri -- bundle --config src-tauri/tauri.local.conf.json --bundles nsis.
Code committed before bundling: e0ba07fc. NSIS bundle exited 0.
Delivered at repository root: CLI-Manager_1.3.10_mobile-fix_e0ba07fc_x64-setup.exe
(26011781 bytes), SHA256 EF19144174EBF03A466075AE3A9F4B2C56A0BC9052B9BFB20CDD760D73830A99.
Generated installer.nsi includes index-BwSTMLzf.js, index-C7YtLU9w.css, all four
executables, cleanup hooks and architecture-specific ConPTY resources.
The bundler warned that the unpatched bundle marker was absent; byte inspection
confirmed the reused installed executable already contains exactly one NSIS NSS
marker, zero UNK/MSI markers. Its hash remains identical to the installed baseline.
Install after saving active terminal work, then refresh the Safari page to load
the new hashed assets. Existing installed bundle remains at F:/cli-manager/
CLI-Manager_1.3.10_x64-setup.exe for rollback if required.
