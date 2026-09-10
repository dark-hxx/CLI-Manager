# Web display controls1.3.10

User approved existing Trellis task extension and Web-only rebuild/rebundle. Branch ahead26/behind56 at entry; no synchronization. Pre-existing1.3.10 backend/frontend work preserved. Memory moderate refresh succeeded; WebTerminal inbound Workbench labeled CRITICAL, reported. Source review confirms root cause: desktop mirror caps font14 and shrink-only; add explicit browser viewing preferences, not PTY reflow.

Web-owned automatic sizing uses outer workspace and base14px, independent of inner display width/height/font controls. Actual browser workspace resize remains existing behavior. Desktop-owned mode never forwards resize. Real font metrics rather than CSS transform preserve pointer mapping. Default contain retained; manual and fit-width allow scrolling to input rows.

Executable baseline (reuse; no Rust or desktop frontend rebuild):
- cli-manager.exe1.3.10 SHA256 4F3E0CC2B65D0144683E6B835C460EB392F86120417B8845A5FF0ABF469C6F46
- cli-manager-web-daemon.exe B85CFD0FA62C76AEA62A840CF05BE6B6A7B972F075D8939DCBC450D870758BA8
- cli-manager-daemon.exe 4D377D802480D094B43B0B23B4D40F4ADB3DE6D5CF5928D22BD6D15592661D15
- cli-manager-codex-proxy.exe AAB864A432F0A8F0AA47C2826EF08CD82C33248486EB9301962B880FBC7C449B

Web typecheck and production build passed (18.80s Vite; existing large chunk warning only). New normalization/storage tests2/2 passed. Real Chrome full renderer regression passed, including both desktop/Web-owned manual fonts10/24, +/- controls, Ctrl-wheel, width-fit overflow, contain, width/height60%, persistent component remount, reset, zh/en live switch; all display changes preserve PTY grid and send no resize. Original twelve geometry/pointer cases, protocol/replay/hidden-tab and eleven disposal rounds remain passing.5001 synthetic frames coalesce to one write (~40ms, not network latency). First run caught unnecessary height allowance reducing default Web takeover font; removed it and strict14px handoff passed. Expanded Chinese settings screenshot visually reviewed. Persistence tested with storage and component remount, not installed-browser F5. Physical user sessions not modified.

Precommit memory refresh/detect_changes succeeded; diff contains pre-existing1.3.10 work. Commit only current Web frontend plus its already-present required frontend helpers/manifest dependencies and documentation. No backend runtime change this follow-up; existing executable/source provenance remains from prior1.3.10 build. Rebundle and post-bundle executable hashes pending.
