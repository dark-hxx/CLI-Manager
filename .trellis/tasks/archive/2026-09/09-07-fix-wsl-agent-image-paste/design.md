# Technical Design

## Data flow

`Alt+V` -> `useTerminalInput` -> Tauri `clipboard_attach_image_files` (for CF_HDROP) or existing `readImage` (for bitmap) -> PNG attachment under `.cli-manager/attachments` -> tool capability formatter -> terminal `paste`.

The file-list command reads the current clipboard itself instead of accepting arbitrary frontend paths. It returns `{ paths, hadFiles, rejectedCount }`; the frontend falls back to bitmap only when `hadFiles` is false.

## Backend

- Extend the `image` crate feature set with ICO/TIFF decoders that have no new runtime service dependency.
- Add a clipboard-image attachment command in `commands/fs.rs`. It validates regular non-symlink files, extension/magic, size, dimensions and decode success, converts to PNG, applies orientation when supported by the decoder, and enforces the existing 5 MiB attachment limit (resizing when necessary).
- Keep source paths out of IPC results and use generated attachment names. Return stable error/status fields rather than leaking host paths.
- Register the command in `lib.rs` and add focused unit tests for format allowlisting, conversion and rejection.

## Frontend

- Add `Alt+V` handling in `XTermTerminal` with the existing clipboard hook; keep Ctrl+V text/image behavior unchanged.
- Add a capability registry in `cliTools.ts` and a formatter used by `useTerminalInput`: native path, `@path`, `/add path`, or unsupported. Escape/quote paths for the target command.
- Include `sessionTool` in Claude/OpenCode capability context checks and preserve the current project-tool fallback.
- Add localized status/error messages only through `i18n.ts`.

## Security and compatibility

Rust remains the authority for clipboard file reads and limits. WSL paths are never passed directly to a CLI; generated attachment paths are Windows paths already supported by the PTY bridge. Unsupported formats fail closed.
