# Web display controls1.3.10

## Mobile/split follow-up (2026-09-10)

User added this scope to the existing task and explicitly clarified that keyboard means the phone OS keyboard, not a custom keyboard. The button focuses xterm synchronously within the user click; fallback is a normal textarea using the same OS IME. Enter/Tab/Esc/Ctrl+C are auxiliary terminal keys. No automatic mobile focus on mount/tab activation. Draft send is explicit, converts CR/LF/Tab to spaces and removes control bytes; execution requires explicit Enter. Inactive/disconnected/exited terminals cannot forward input, and mounted fallback drafts survive disabled state.

Discovery: Workbench owns parent/child association and active/status gates; WebTerminal owns real input and font metrics; SubagentPanel content pipeline unchanged, its flex layout becomes 50/50; App now owns visible viewport tracking previously isolated in unused Composer. Backend/desktop output/PTY protocol unchanged. GitNexus unavailable; memory trace (WebTerminal->Workbench CRITICAL, reported) and source/contract review used. Existing dirty backend work is excluded from this follow-up.

Root causes found during validation: contain corrected width rounding but not rounded row height, clipping short viewports; fix checks both screen dimensions. Keyboard layout used a narrower breakpoint than viewport detection, leaving desktop header visible in phone landscape; keyboard-state CSS now compacts the header/banner across the full detected scope. A harness-only takeover failure was caused by its default narrow browser viewport while sizing root to1200px; fixed actual CDP viewport, retained strict14px takeover assertion.

Verification: Web production build passed; viewport/display unit tests8/8; full renderer regression passed including Chinese IME, explicit Enter, safe paste, disabled draft preservation, no auto-focus, original11 recovery rounds,5001frame batch and strict14px ownership handoff. Subagent smoke passed wide572/572px, phone244/244px, keyboard440px170/170px, landscape keyboard240px92/92px (bottom236px), collapse/restore, lifecycle and Markdown tests. Phone screenshot visually reviewed. Hook follows visualViewport/innerHeight and optional VirtualKeyboard geometry; physical Android/iOS keyboards and floating keyboards without geometry are not verified and cannot be guaranteed detectable.

Per latest user request, no new installer is bundled or delivered for this follow-up. The earlier partial bundle is not a final deliverable. Only Web assets built; executable rebuild not performed.

User approved existing Trellis task extension and Web-only rebuild/rebundle. Branch ahead26/behind56 at entry; no synchronization. Pre-existing1.3.10 backend/frontend work preserved. Memory moderate refresh succeeded; WebTerminal inbound Workbench labeled CRITICAL, reported. Source review confirms root cause: desktop mirror caps font14 and shrink-only; add explicit browser viewing preferences, not PTY reflow.

Web-owned automatic sizing uses outer workspace and base14px, independent of inner display width/height/font controls. Actual browser workspace resize remains existing behavior. Desktop-owned mode never forwards resize. Real font metrics rather than CSS transform preserve pointer mapping. Default contain retained; manual and fit-width allow scrolling to input rows.

Executable baseline (reuse; no Rust or desktop frontend rebuild):
- cli-manager.exe1.3.10 SHA256 4F3E0CC2B65D0144683E6B835C460EB392F86120417B8845A5FF0ABF469C6F46
- cli-manager-web-daemon.exe B85CFD0FA62C76AEA62A840CF05BE6B6A7B972F075D8939DCBC450D870758BA8
- cli-manager-daemon.exe 4D377D802480D094B43B0B23B4D40F4ADB3DE6D5CF5928D22BD6D15592661D15
- cli-manager-codex-proxy.exe AAB864A432F0A8F0AA47C2826EF08CD82C33248486EB9301962B880FBC7C449B

Web typecheck and production build passed (18.80s Vite; existing large chunk warning only). New normalization/storage tests2/2 passed. Real Chrome full renderer regression passed, including both desktop/Web-owned manual fonts10/24, +/- controls, Ctrl-wheel, width-fit overflow, contain, width/height60%, persistent component remount, reset, zh/en live switch; all display changes preserve PTY grid and send no resize. Original twelve geometry/pointer cases, protocol/replay/hidden-tab and eleven disposal rounds remain passing.5001 synthetic frames coalesce to one write (~40ms, not network latency). First run caught unnecessary height allowance reducing default Web takeover font; removed it and strict14px handoff passed. Expanded Chinese settings screenshot visually reviewed. Persistence tested with storage and component remount, not installed-browser F5. Physical user sessions not modified.

Precommit memory refresh/detect_changes succeeded; diff contains pre-existing1.3.10 work. Commit only current Web frontend plus its already-present required frontend helpers/manifest dependencies and documentation. No backend runtime change this follow-up; existing executable/source provenance remains from prior1.3.10 build. Rebundle and post-bundle executable hashes pending.
