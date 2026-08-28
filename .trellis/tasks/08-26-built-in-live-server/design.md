# Built-in Live Server Design

## Boundaries

The feature is a new, isolated local-development service. It does not reuse PTY sessions or shell out to `npx`, Python, VS Code, or a globally installed Live Server. Existing terminal and file-browser behavior remains authoritative.

Data flow:

```text
HTML context menu
  -> liveServerStore
  -> typed Tauri client
  -> live_server_start IPC
  -> LiveServerManager
  -> loopback HTTP server + debounced project watcher
  -> system default browser
  -> injected reload client polls the server version endpoint
```

## Frontend Design

### Files

- `src/lib/liveServerClient.ts`: typed IPC/opener boundary and data contracts.
- `src/stores/liveServerStore.ts`: injected-client Zustand store keyed by project path; owns status hydration, start/open, stop, and pending state.
- `src/components/files/LiveServerMenuItems.tsx`: eligibility checks and localized menu actions.
- `src/components/files/FileExplorerSidebar.tsx`: thin insertion points only in existing tree/search/root context menus.
- `src/lib/i18n.ts`: Simplified Chinese and English labels/toasts.

The store uses immutable record replacement and narrow selectors. Backend failures remain rejected promises; the menu component renders one localized toast per user action.

Eligibility is a pure frontend precheck:

- project environment is `local`;
- entry kind is `file`;
- extension is `.html` or `.htm`, case-insensitive.

Rust repeats all validation and remains the security authority.

## IPC Contract

```text
live_server_start(projectPath, relativePath) -> LiveServerOpenResult
live_server_status(projectPath) -> LiveServerSession | null
live_server_stop(projectPath) -> boolean
```

`LiveServerSession` contains `projectPath`, `origin`, and `port`. `LiveServerOpenResult` contains the session, the selected encoded URL, and `reused`.

Stable error identifiers include:

- `root_not_absolute`, `root_canonicalize_failed`, `root_not_directory`
- `wsl_live_server_unsupported`
- `path_contains_backslash`, `path_contains_current_segment`, `path_contains_parent_segment`, `path_is_absolute`
- `path_outside_root`, `entry_not_html`, `entry_not_found`
- `listener_bind_failed`, `watcher_init_failed`, `watch_failed`, `lock_poisoned`

## Backend Design

### Files

- `src-tauri/src/live_server/mod.rs`: manager, session registry, lifecycle, and public types.
- `src-tauri/src/live_server/http.rs`: Hyper HTTP listener, Host/method routing, response headers, reload-script injection.
- `src-tauri/src/live_server/paths.rs`: pure relative-path validation, canonical containment, request resolution, and URL encoding.
- `src-tauri/src/live_server/watcher.rs`: one debounced recursive watcher per running project session.
- `src-tauri/src/commands/live_server.rs`: thin Tauri command adapters.

The manager owns a mutex-protected map keyed by a normalized absolute project path. A running entry owns its listener task, shutdown sender, watcher, and atomic reload version. Starting the same root returns the existing session and a URL for the newly selected page. Different roots receive independent OS-assigned ports.

The listener binds `127.0.0.1:0`. There is no port fallback. The actual bound port is returned to the frontend.

## HTTP Contract

- Accept `GET` and `HEAD`; return `405` for other methods.
- Require `Host: 127.0.0.1:<bound-port>`; return `403` otherwise to prevent DNS-rebinding access.
- Reserve `/__cli_manager_live_server__/version` for the reload client.
- Resolve `/` and directory requests to `index.html`; do not generate directory listings.
- Return `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Determine content type with `mime_guess`.
- Inject an ASCII reload script into HTML response bytes before `</body>` or append it when no body close tag exists.
- The injected client polls the version endpoint every 400 ms. A changed version reloads the page; polling errors are surfaced in the browser console rather than swallowed.

File reads run through `spawn_blocking`. Request URL decoding and path validation happen before filesystem access. The canonical result must remain under the canonical project root, which blocks symlink/reparse escapes.

## Watcher Contract

Use the existing `notify-debouncer-mini` dependency with a 250 ms debounce. Increment the atomic version only when at least one relevant, in-root path changes. Ignore VCS metadata and high-churn generated directories already excluded by the project file watcher. Dropping the watcher stops it.

## Lifecycle and Concurrency

- Start is serialized by the manager map lock, so simultaneous clicks cannot create duplicate servers for one root.
- Stop removes the entry, drops its watcher, and signals listener shutdown.
- Status prunes a server whose task has already finished.
- `RunEvent::Exit` calls `LiveServerManager::shutdown()` before process termination.
- A missing Worktree directory can still stop an existing session because status/stop use the normalized registry key without recanonicalizing the removed root.

## Dependencies

- Reuse existing `hyper`, `hyper-util`, `http-body-util`, `bytes`, `tokio`, `notify`, and `notify-debouncer-mini` dependencies.
- Add direct dependencies `mime_guess` and `percent-encoding`; they provide MIME classification and correct Unicode URL path handling without custom parsers.

## Compatibility and Rollback

No database migration, preference persistence, shell command, or protocol change is introduced. Rolling back consists of removing the new modules, three IPC registrations, context-menu insertions, i18n keys, and two direct Cargo dependencies.
