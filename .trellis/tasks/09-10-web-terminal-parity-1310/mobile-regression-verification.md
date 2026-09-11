# 1.3.10 mobile regression follow-up — 2026-09-11

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
Bundle result and exact artifact hash will be appended after generation.
Install after saving active terminal work, then refresh the Safari page to load
the new hashed assets. Existing installed bundle remains at F:/cli-manager/
CLI-Manager_1.3.10_x64-setup.exe for rollback if required.
