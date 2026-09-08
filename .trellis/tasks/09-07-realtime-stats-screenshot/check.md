# Realtime statistics screenshot verification

## Delivered
Compact Camera action beside refresh, using the existing cyan panel token, 11px icon, rounded action and focus ring. Busy state prevents duplicate clicks. Capture includes the full current enabled-card scroll area, title and source while omitting capture/refresh controls and dialogs. The same path is used for embedded/standalone panels and every Agent/environment because it captures rendered statistics, not Agent-specific logs.

A synchronous snapshot freezes inherited theme styles and canvas pixels before lazy renderer import. The inert offscreen clone is expanded and removed in finally. Output is proportionally scaled with a 16M pixel / 16384-dimension budget; extremely large captures fail explicitly instead of silently cropping. Tauri Image.new receives RGBA plus width/height; writeImage writes the native clipboard and the resource is closed in finally. No upload or image file is created by the feature.

## Checks passed
- Node: 5 tests (`statsScreenshot.test.mjs` and `terminalStatsPanel.test.mjs`), including dimensions, native payload, resource release after success/failure, permission and translation presence.
- Browser: 7 standalone renderer cases. Dark/light at top/middle/bottom each produced a complete 240x1096 image. Pixel assertions verified inherited background, Canvas chart, SVG chart and bottom card; live scroll/layout remained unchanged and post-click source changes did not contaminate the image. Oversized capture rejected and removed its temporary host.
- `npx tsc --noEmit`, `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml` passed. Rust check also validated the added clipboard permission.
- Normal and strict architecture checks: 962 source files, zero over-limit files / violations. `git diff --check` passed.
- GitNexus TerminalStatsPanel pre-edit impact LOW. Final detect_changes includes the earlier diagnostics work and reports aggregate critical risk; this feature adds only the panel action/boundary, export modules, translations and write-image permission.

## Manual desktop acceptance
The repository forbids agents from starting CLI-Manager/Tauri for UI validation; none was started. Browser tests used a static local fixture, not the application. A human must verify:
1. Click Camera in the real live statistics header, then paste into Paint or a chat input and confirm an image containing the final card.
2. Repeat after scrolling and switching the app between zh-CN/en-US and light/dark panel skins.
3. Check header spacing in narrow/embedded/fullscreen panels, and ensure background-image mode still renders as expected.
4. Confirm success/failure toast behavior with the native desktop clipboard. Native SDK operations were mocked in unit tests, so actual clipboard pasting is not claimed as tested.

## Records and scope
New task approved by user in existing worktree; TEMP entries added to CHANGELOG and docs/功能清单. Component export contract updated. html-to-image 1.11.13 added as a lazy dependency after reading upstream README documentation via Context7; installed Tauri SDK declarations/source verified. Earlier diagnostics/resume edits were retained, no Git synchronization, commit, push or task archival performed. Implementation complete, awaiting manual acceptance in review.
