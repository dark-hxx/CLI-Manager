# Web terminal inventory — 1.3.9 (2026-09-10)

The desktop publishes project-bound local/WSL PTY tabs in the workspace snapshot. Missing `terminals` means an older client; an empty array authoritatively removes all Web tabs. Project/terminal store changes trigger a debounced publication. Existing history invalidation and reconnect paths fetch the inventory. Browser removal sends detach, never close; explicit close remains a desktop close request. Pending closes are retained until inventory confirms removal.

Validation: desktop TypeScript and Web build passed; server 46 tests passed; protocol 7 tests passed; reconnect/stream 8 tests passed. Extended the storage test to assert terminal inventory survives storage then clears on the next snapshot. Real Chrome renderer smoke passed: 11 recovery rounds, 1 MB replay, 5001 live chunks coalesced into one write, no browser errors.

The renderer harness disables file watching: restart it after edits. Initial manual reloads served cached code; final automated run started a fresh server and browser.

GitNexus tools and local skill/runner unavailable; impact review used source, service contracts and Git diff. Codebase-memory detect_changes listed changed files but supplied no impacted symbols, so it is not evidence of complete coverage.

Not yet verified in an installed dual-client session: tray/minimized, deep split trees, WSL, multi-browser close races, and manual light/dark/language UI checks. Existing non-PTY/transcript/editor/SSH and remote-handoff tabs are excluded. Zoom is bounded 0.7–1.4 to retain readability; extremely narrow viewports may still scroll horizontally.
