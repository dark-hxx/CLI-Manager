# Editor extraction verification — 2026-09-07

- Actual owners: controller 258, navigation 130, view 80, component 7, model 22, theme 14 physical lines. Existing pinned-editor <=300 test now covers all actual owners and passes.
- `verify-editor.mjs`: 69 original statements in identical expanded order, complete JSX, model declarations and theme helper match checkpoint `6cf6222d`. Monaco module setup remains once.
- TypeScript passes. Production build passes (6970 modules, 55.58s).
- 43 focused Node tests pass: file/Markdown/Git pin/workspace/safety and architecture, including 5 new in-memory navigation tests. No app/browser/real filesystem navigation starts.
- GitNexus FileEditorPane reports LOW / 0 direct indexed callers; source inspection additionally covers the lazy terminal pane owner (the graph undercounts it). Theme helper LOW / 1 caller; extracted callback consts LOW / 0 indexed calls. No IPC, store or lease authority changes.
- Human-only: Monaco Ctrl-right-click, external browser, cross-file anchors, source/preview mode, multi-pane scoping, dirty-file confirmations and zh-CN/en-US. Not executed by the agent.
- Remaining complete Git/files directory relocation belongs to architecture convergence; parent goal is not yet complete.
