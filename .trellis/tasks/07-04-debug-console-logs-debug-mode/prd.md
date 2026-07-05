# debug console logs follow debug mode

## Goal

Make WebView console diagnostic logs follow the existing Debug Mode setting. Console diagnostics such as `oom-diagnostics:webview` should only print when Debug Mode is enabled.

## Changelog Target

[TEMP]

## Requirements

* Gate `oom-diagnostics:webview` console output behind `settingsStore.debugMode`.
* Gate other ordinary debug console logs found in the same pass, such as the Git changes fetch start log.
* Do not silence real error reporting paths such as `console.error` failure logs.
* Avoid changing the shared logger behavior because it has broad impact.

## Acceptance Criteria

* [ ] With Debug Mode disabled, WebView `oom-diagnostics:webview` console logs do not print.
* [ ] With Debug Mode enabled, the same diagnostics can still print.
* [ ] Existing Tauri/plugin log calls remain unchanged.
* [ ] TypeScript type check passes.

## Definition of Done

* Code updated with minimal scoped changes.
* `CHANGELOG.md` updated under `[TEMP]`.
* `npx tsc --noEmit` run.

## Technical Approach

Add a narrow frontend helper for console logging that reads `useSettingsStore.getState().debugMode`, then replace diagnostic `console.log/info/warn` call sites with that helper. Keep `console.error` unchanged.

## Decision

Use a narrow helper instead of changing `src/lib/logger.ts`, because GitNexus impact analysis reported HIGH risk for the shared logger module.

## Out of Scope

* Backend Rust log filtering.
* Error reporting behavior changes.
* Runtime UI redesign.

## Technical Notes

* Relevant files: `src/components/XTermTerminal.tsx`, `src/stores/terminalStore.ts`, `src/components/terminal/SubagentTranscriptView.tsx`, `src/components/terminal/SessionReplayPanel.tsx`, `src/stores/replayStore.ts`, `src/stores/gitStore.ts`.
* GitNexus impact analysis: target symbols LOW risk except `src/lib/logger.ts`, which is HIGH and intentionally avoided.
