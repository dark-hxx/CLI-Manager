# Mobile directions — 1.3.10

- Scope: MobileTerminalInput, mobile CSS, bilingual labels. Existing WebTerminal active/running gate and guarded key transport reused; no backend modifications.
- Browser smoke passed: collapsed/open pad, four correct ANSI sequences, repeated clicks, pointer focus prevention, input focus retention, rightmost Enter carriage return, outside dismissal, disabled/inactive dismissal, viewport resize and English label. Existing project drawer, portrait/landscape, keyboard geometry and subagent checks also passed.
- Web TypeScript and production build passed (existing chunk-size warning). No physical phone test; browser uses production components with fixture callbacks.
- GitNexus unavailable; memory inbound lookup missed JSX and source confirmed WebTerminal caller. detect_changes reviewed with pre-existing dirty files excluded from staging.
- Packaging uses tauri bundle --bundles nsis --config src-tauri/tauri.local.conf.json, reusing existing release executables. No cargo build or desktop frontend rebuild.
