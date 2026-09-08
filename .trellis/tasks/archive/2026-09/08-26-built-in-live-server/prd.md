# Add built-in Live Server

## Goal

Allow users who edit static web pages in CLI-Manager to right-click an HTML file, open it in the system browser, and see project file changes without manually refreshing the page.

## Requirements

- Add an `Open with Live Server` action to HTML/HTM file context menus in the local project file browser, including normal tree rows and file/content search results.
- Open the selected page in the operating system's default browser.
- Serve files relative to the active project or Worktree root so nested pages and relative assets resolve consistently.
- Reuse one running server for repeated opens within the same project root, while allowing different local project roots to run independently.
- Reload served pages after relevant project files change, with changes visible within one second under normal local filesystem conditions.
- Expose an explicit `Stop Live Server` action while the current project server is running.
- Stop all managed Live Server instances when CLI-Manager exits.
- Bind only to the loopback interface and reject requests with an unexpected Host header.
- Treat the project path and selected relative path as untrusted IPC input. Reject absolute relative paths, backslashes, current/parent segments, non-HTML entry files, missing targets, canonicalization escapes, and symlink/reparse escapes outside the project root.
- Preserve all existing terminal, project, file-editor, Git, Worktree, and file-watcher behavior.
- Provide Simplified Chinese and English UI text through the existing i18n system.
- Keep frontend and backend failures explicit through stable backend error codes and localized error toasts; do not silently switch to an external server or another runtime.

## Scope

- Supported: local filesystem projects on Windows/macOS/Linux and existing local Worktree-derived project paths.
- Unsupported in this delivery: SSH projects and WSL project paths. Their menus must not expose a working action that later falls back to local filesystem access.
- Static files only. The feature does not install dependencies, run framework build commands, replace Vite/Webpack development servers, provide directory listings, or proxy application backends.

## Acceptance Criteria

- [ ] Right-clicking an existing `.html` or `.htm` file in a supported project shows `Open with Live Server`; non-HTML files and unsupported project environments do not expose the action.
- [ ] Selecting the action opens a `http://127.0.0.1:<dynamic-port>/<encoded-relative-path>` URL whose response renders the selected file and its project-relative assets.
- [ ] Editing HTML, CSS, JavaScript, JSON, image, font, or other served assets causes an already-open page to reload within one second.
- [ ] Reopening another HTML file from the same root preserves the port; starting a second project uses an independently managed server.
- [ ] `Stop Live Server` removes the project session and releases its listener; application exit shuts down every remaining session.
- [ ] Paths containing spaces and Chinese characters work, and nested `index.html` paths resolve correctly.
- [ ] Traversal, encoded traversal, backslash, symlink escape, invalid Host, unsupported method, missing file, and non-HTML entry-file cases return explicit failures without reading outside the project root.
- [ ] Existing file tree operations, editor state, Workspan state, terminal sessions, Git watcher, and project file watcher remain unchanged.
- [ ] Rust unit/integration tests, TypeScript type checking, frontend production build, Rust check, and Tauri packaging complete successfully.
- [ ] `CHANGELOG.md`, `docs/功能清单.md`, and the owning backend contract document describe the delivered behavior and limitations.

## Notes

- The contribution contains source, tests, and project documentation only; local deployment artifacts are outside its scope.
