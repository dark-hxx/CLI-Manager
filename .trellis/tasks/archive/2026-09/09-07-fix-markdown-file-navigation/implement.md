# Implementation and verification plan

## Entry gate

- [x] Git checks completed: master vs recorded origin/master is 0 ahead / 0 behind; no fetch performed. Existing AGENTS.md and CLAUDE.md changes belong to the user.
- [x] Task creation approved; trellis-start and trellis-brainstorm loaded.
- [x] Root-cause classification and scenario/discovery lists written.
- [x] PRD convergence: requirements and acceptance are mapped by R1-R9; temporary brainstorm placeholders removed.
- [x] User reviews final prd.md, design.md and implement.md before task.py start.
- [x] Load trellis-before-dev, relevant frontend/shared-boundary conventions and phase 2.1 instructions.
- [x] Run symbol impact checks before code edits; GitNexus returned UNKNOWN for the unindexed target symbols, so source/import inspection supplied the discovery list. Final detect_changes reported low risk and no affected execution process.

## Ordered work

1. Confirm installed Markdown/Monaco APIs and native link reproduction. Finalize parser reuse and project-bound absolute-path handling without new dependencies unless reviewed.
2. Implement/test pure destination parsing, source link extraction and deterministic heading IDs/source mapping (R2-R4, R6).
3. Implement scoped renderer anchors and optional document callbacks, preserving other consumers' link policies (R1-R3, R9).
4. Integrate file-editor source gestures, project-bound file opening and pending fragment application. Resolve preview-mode reset and stale request ownership explicitly (R1, R4-R7).
5. Localize visible errors, accessibility labels and gesture help; record V1.3.9 changelog and file-browser feature changes (R8).
6. Run focused behavioral tests and TypeScript checks, then desktop interaction checks and quality gate. Fix issues directly in the main session.

## Validation

- Add behavioral tests using the repository's node:test/TypeScript loading pattern: encoded Chinese/Emoji/duplicate headings; overlapping generated IDs; inline/reference/autolinks and code exclusions; `../` normalization and root escape rejection; encoded `#`, `%`, spaces and malformed sequences; protocol classification; latest navigation wins and stale project/file rejection.
- Run `node --test scripts/markdownRendering.test.mjs scripts/historyMarkdownRendering.test.mjs scripts/terminalMarkdownPreview.test.mjs scripts/fileExplorerProjectState.test.mjs` plus newly added navigation tests and any directly affected existing tests.
- Run `npx tsc --noEmit`.
- Desktop matrix: source Ctrl + right-click; preview left-click/Ctrl + right-click/Enter; ordinary right-click menus; same-document and cross-file fragments; external browser exactly once; directory/image/code targets; unsaved target reuse; missing targets; two panes with duplicate headings; switch files/projects while loading.
- Verify local Windows and available WSL/SSH contexts; mark unavailable runtime cases unverified rather than claiming success.
- Manually switch zh-CN/en-US in Settings and verify visible messages/labels; keep 24-hour time formatting. Check zh-TW resource compatibility if touched.
- Run trellis-check after implementation. No Rust checks required unless Rust scope changes. Any backend/permission change requires revisiting design.
- Before any eventual commit, run GitNexus detect_changes and inspect the diff; no commit/push is authorized by planning consent alone.

## Scope and rollback

One task is sufficient: source and preview are two entry points to the same navigation behavior, with shared acceptance and parser contracts. No independently deployable child task is necessary. Roll back only this task's code changes if required; do not reset the working tree or alter existing AGENTS.md/CLAUDE.md edits.

## Validation result

- `npx tsc --noEmit`: passed.
- Focused Node regression suite: 26 passed, 0 failed.
- `npm run build`: passed; Vite transformed 6880 modules.
- `git diff --check`: passed (repository line-ending notices only).
- GitNexus `detect_changes`: low risk, no affected execution process; index recognition remains partial for new symbols.
- Human desktop verification remains required by `.trellis/spec/frontend/quality-guidelines.md` for Monaco gestures, system application launch, multi-pane scrolling, WSL/SSH runtime contexts and language switching.
- User-reported `README.zh-CN.md:18` → `#-界面预览` case is covered directly: the real heading at line 453 resolves through the shared Emoji-aware slug logic.
