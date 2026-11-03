# Design gate

Discovery: PaneLeafView, useXTermController, TerminalProcessManager, sessionSnapshotPersistence, FileEditorContent, fileExplorerStore and their public state/model owners. Use current CodeGraph impact/contracts before edits.

Cold display release must be a reversible display lease, not PTY/session destruction. A replacement display must take ownership of pending uncommitted writes; only the current owner's xterm callback can ACK. Persist keyboard/mouse and complete daemon checkpoint semantics before release.

Editor reclamation must distinguish clean content cache from Monaco models with dirty/undo/diff state. Measure byte residency and protect active/dirty leased models before selecting an LRU candidate. Do not silently close tabs or reset edit history.

Scenarios: hidden/minimized, split/reparented panes, workspan switch, output in flight, local/WSL/SSH, dirty editor, pending save and conflict draft. No implementation until the ownership seam and all protections are verified.

## Implemented ownership decision

- The terminal buffer/parser is a protected live protocol owner, not a cache. Reclaim only WebGL after 30 seconds (10 in low-memory mode). No xterm unmount, protocol responder replacement, pending-ACK transfer, image eviction or buffer truncation is required. Existing output/keyboard/mouse/recovery ownership stays unchanged.
- Hidden ordinary editor renderers release after 10 seconds. Monaco `keepCurrentModel`/`saveViewState` preserve models/undo/cursor; explicit root-qualified URIs prevent cross-project/host sharing. Active Diff, pending confirmation and markdown navigation remain mounted because those views own interaction state.
- Separate caches: clean undo-less models 8 MiB/12; reloadable clean file contents 32 MiB/64. Active/dirty/undo/redo/in-flight-save contents are excluded. Dehydration keeps tabs and metadata and reads only when selected/restored. Automatic fallback hydration attempts once per marker and only when source context is ready; explicit retries remain available.
- CodeGraph/contracts/caller tracing covered FileEditorContent/PaneView/controller, file store open/project/refresh/save/close selection, git Diff ownership and terminal display/snapshot paths. High-risk lifecycle was reported before edits; no source schema/installation change.
- API confirmation via Context7: https://github.com/suren-atoyan/monaco-react/blob/master/_autodocs/api-reference/editor.md and https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/src/WebglAddon.ts .
- Budgets govern caches, not all protected user state or the entire process heap. GUI/long-run acceptance is separate from deterministic cache/ownership regressions.
