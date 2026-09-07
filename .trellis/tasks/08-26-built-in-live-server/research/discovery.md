# Discovery List

GitNexus MCP is not exposed in the current environment and the repository has no `.gitnexus/run.cjs`. A global CLI install was attempted successfully, but `gitnexus analyze .` failed before indexing because `tree-sitter-dart` has no Windows x64 native build for Node 24.11.0 / ABI 137. Per `fix-triage-guide.md`, discovery therefore uses repository contracts plus targeted `rg` searches.

## Confirmed Touchpoints

- [x] `src/components/files/FileExplorerSidebar.tsx`: owns ordinary file, filename-search, content-search, and root Radix context menus.
- [x] `src/components/ui/context-menu.tsx`: reusable primitive; no change required.
- [x] `src/stores/fileExplorerStore.ts`: authoritative active project; read-only inspection only, no mutation contract change.
- [x] `src/lib/types.ts`: existing `Project`/environment and file-entry contracts; no existing type needs mutation.
- [x] `src/lib/i18n.ts`: user-visible Simplified Chinese and English dictionaries.
- [x] `src/components/settings/AboutSection.tsx` and other opener callers: establish `openUrl` error-handling precedent; no change required.
- [x] `src-tauri/src/commands/mod.rs`: command module registration.
- [x] `src-tauri/src/lib.rs`: managed states, generated IPC handler list, opener plugin, and `RunEvent::Exit` cleanup.
- [x] `src-tauri/src/file_watcher.rs`: existing debounce/filter conventions; behavior must remain unchanged.
- [x] `src-tauri/src/commands/fs.rs`: project-root validation/error conventions; existing commands remain unchanged.
- [x] `src-tauri/src/daemon/route_http.rs`: Hyper/Tokio listener precedent; no daemon routing change required.
- [x] `src-tauri/Cargo.toml` and root `Cargo.lock`: dependency declarations/lockfile.
- [x] `src-tauri/capabilities/default.json`: `opener:default` already present; no capability broadening required.
- [x] `CHANGELOG.md` and `docs/功能清单.md`: mandatory product records.
- [x] `.trellis/spec/backend/project-file-command-contracts.md`: owning path-boundary contract to extend.

## Existing-Symbol Callers

- `FileExplorerSidebar` is mounted by `src/components/sidebar/index.tsx` and twice by `src/components/TerminalTabs.tsx`; both sidebar and panel presentation modes therefore receive the additive menu entry.
- `FileNode` is called only by recursive `FileTreeRows`; inserting a reusable item in `FileNode` covers every ordinary tree depth without changing recursion state.
- `FileTreeRows` is called by `FileNode` and the root renderer in `FileExplorerSidebar`; no signature change is required for a store-backed menu component.
- The Tauri composition root in `src-tauri/src/lib.rs` owns all `.manage(...)`, `generate_handler![...]`, and `RunEvent::Exit` registrations; the Live Server additions are parallel registrations with no existing command signature changes.
- Existing opener calls are UI-boundary calls in `XTermTerminal`, `MarkdownContent`, `AboutSection`, and `CcConnectSettingsPage`; the new client follows the same explicit rejected-promise behavior.
- `FileWatcherBridge` is called only by `commands/fs.rs` and `ProjectFileRefreshController`; it is reference-only and will not be modified or reused because it intentionally owns only one current file-browser project.

## Confirmed Unrelated

- [x] PTY/daemon terminal session creation and background task recovery.
- [x] SQLite schemas and migrations.
- [x] SSH Agent/remote file APIs.
- [x] Project file editor encoding/save behavior.
- [x] Git watcher/store and Worktree lifecycle records.
- [x] WebDAV sync and settings persistence.
- [x] Claude/Codex hooks, history, analytics, and provider routing.

## Impact Assessment

- Backend blast radius: medium. New state and commands are registered in the Tauri composition root; existing command behavior is not modified.
- Frontend blast radius: medium. Existing menu rendering receives thin reusable items, while file-tree selection/edit/drag logic remains untouched.
- Security risk: high if path containment or Host validation is wrong. The design therefore requires both lexical and canonical path checks plus focused tests before UI integration.
- Lifecycle risk: medium. Explicit stop and `RunEvent::Exit` cleanup prevent orphan listener/watcher ownership.
