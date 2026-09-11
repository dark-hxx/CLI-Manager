# Design and impact analysis

## Root cause
Selection, clipboard, confirmation and pointer-drag state each carry only one file. Fix the entire producer-to-operation path, rather than just painting multiple highlighted rows.

## Approach
- Add small pure selection/batch helpers and ephemeral selection/operation state to the existing Zustand store. Keep `selectedTreePath` as the existing reveal/scroll marker, separate from selection and the editor's active file.
- Clipboard and pending operations snapshot project, entries and mode. Run existing project-scoped IPC operations sequentially under a mutation lock, then refresh affected parents/Git/search once. Return successful, failed, conflicting and skipped entries independently.
- Preflight dirty source/destination editor buffers; recheck before each mutation. Do not discard dirty buffers. Apply successful changes only to the originating workspace; preserve buffers edited during an awaited operation.
- Default destination policy is no overwrite. Confirm only conflicting entries, using the captured snapshot, not a possibly replaced global clipboard. Duplicate destination names within one batch cannot overwrite one another.
- Retain native and custom pointer-drag routes. Pointer-down on a selected row must not collapse the selection; collapse on the subsequent non-drag click. Reuse terminal path formatting for multi-entry text without changing terminal shortcuts.
- All UI strings go through the existing zh-CN/en-US dictionaries.
- Backend safety finding: delete/move currently canonicalize the source before mutation, which can dereference a link. Add a narrow source-path guard for delete/move rejecting symlink/reparse components before invoking those existing commands. No new IPC contract or dependency.

## Discovery list / upstream impact (GitNexus unavailable)
- [x] `FileExplorerSidebar`, `FileNode`, `FileTreeRows`: tree + two search renderers, focus, contextual menus, dialogs, pointer/native drag. Direct hosts: Sidebar and TerminalTabs. Medium interaction risk.
- [x] `useFileExplorerStore`: selection/project lifecycle, clipboard, delete/paste, refresh and editor workspace helpers. Direct mutation callers are the file sidebar. Other consumers: FileEditorPane, FileEditorTabs, terminal project syncing, Git diff navigation. High data-loss risk; dirty/scope safeguards and regression tests required.
- [x] `terminalFileDrag` and `useTerminalInput`: inspect contract; reuse existing payload formatter, no terminal-input change planned. Preserve source panel context.
- [x] `fs::file_delete`, `fs::file_move`, new mutation-source helper: frontend store -> registered Tauri commands -> filesystem. High data-loss risk. Retain root containment/no-overwrite behavior and reject link dereference.
- [x] `file_rename` / create APIs: existing single-entry behavior retained; batch rename is out of scope.
- [x] `ProjectFileRefreshController`/file watcher: coordinate in-flight refresh with mutation state; no extra watcher or backend event needed.
- [x] `LiveServerMenuItems`, live-server store/backend: confirmed unrelated to implementation; regression checks only.
- [x] SSH commands, PTY/daemon/proxy, database migrations/settings persistence: confirmed unrelated; SSH write gate remains enforced in UI and store.
- [x] i18n, CHANGELOG, feature list, project-file contract, task artifacts and tests: update with implementation.

## Scenario matrix
| Dimension | Required behavior |
|---|---|
| Focus in file row / input / editor / terminal / other window | Only file rows own selection shortcuts; inputs and terminals untouched |
| Sidebar / embedded panel / compact directory chain | Same actions, chain leaf retains current semantics |
| Tree / filename search / content search | Consistent selection and batch menus; view changes clear selection |
| Single / split / deep split / Workspan / project switch | Immutable operation scope; no late state writes into another project |
| Normal / hidden / minimized / tray | No global file shortcuts; async effects stay scoped |
| Local / Worktree / WSL / SSH | Existing local root commands; WSL path case preserved; SSH read-only |
| Main repo / linked worktree / missing directory | Preserve hidden `.git` file behavior; report vanished entries |
| Focus mode / hooks present or absent | No dependency on CLI hooks or terminal runtime |
| Parent+child / same destination / conflicts / links / failures | Dedup, no-op same parent, explicit conflict retry, reject unsafe links, per-item summary |
| Dirty files / dirty target / edits during operation | Refuse affected dirty mutations; retain any subsequently dirtied buffer |

## Review
Reviewed inline against the approved scope and project file command contracts before task activation. No sub-agents (repository `codex.dispatch_mode: inline`).

## Upstream PR adaptation
- Contribution base: `bcc7604a9bd8e8b0c10e219c1e04a96e238a83f8`. Only the feature delta is ported; earlier Live Server work is already merged in PR #232.
- Respect the upstream `features`/`shared` layout, split locale catalogs, strict 2000-line limit and existing SSH SFTP entry. Keep the upstream version and dependency locks unchanged.
- `useTerminalFilePointerDrag` is shared by the file explorer and Git changes panel. Extend it with optional snapshot-payload, scope-reset and preview-label callbacks instead of duplicating pointer handlers. Default single-item Git drag behavior remains unchanged. This is medium-risk cross-feature interaction and has executable hook regression tests.
- Put the three new Rust mutation tests in the existing `commands/security_tests.rs` so `commands.rs` stays below 2000 lines. Preserve upstream's `source_equals_target` rejection and existing security regressions; only the frontend's same-parent batch move is a no-op. No production implementation is duplicated.
- GitNexus CLI impact/detect-changes were attempted but reported no indexed repositories; MCP tools and local skill files are unavailable. The fallback is contract/reference analysis, explicit file/diff review and focused cross-boundary tests. No service or UI is launched for validation.
