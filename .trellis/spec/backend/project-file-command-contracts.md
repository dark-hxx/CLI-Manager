# Project File Command Contracts

## File tree first paint (TEMP, 2026-11-13)

- `fileExplorerStore.openProject` completes after the root directory is published,
  not after Git decorations. Start optional local/WSL Git collection only after
  successful listing; its completion or failure must not own the directory's
  loading flag, clear the tree, or delay clean restored-file hydration.
- Late initial Git results must match the open generation, project file context
  and remote context. Switching away/back, Worktrees, case-distinct WSL paths and
  closing the panel invalidate the previous publication even for a shared pending
  Git request. Existing Git single-flight and non-repository caching remain intact.
- SSH listing retains its remote context/release boundary and must not issue local
  directory or Git calls. IPC signatures, filesystem guards and Git scan behavior
  are unchanged. `scripts/fileExplorerInitialLoad.test.mjs` exercises the real store
  against deferred IPC promises for these boundaries.

## Reloadable frontend file residency (TEMP, 2026-11-01)

- File tabs can carry `dehydrated: true`: metadata/tab identity remain, but reloadable clean text/base64 payload is absent. The cache budget is 32 MiB/64 nonempty files across retained workspaces, excluding active, dirty, undo/redo-model and in-flight-save contents.
- Activating a dehydrated tab or restoring its project reads through the existing `loadProjectFile` source/encoding adapter. A failed reload retains the marker and can retry; a closed tab cannot be resurrected, and a late result cannot steal newer selection. Mutation refresh does not eagerly refill dehydrated payloads.
- Monaco model identity includes normalized local/WSL root or SSH host/remote root plus file path. Visible split panes are not treated as hidden just because another pane owns global focus. Hidden renderers release after 10 seconds; keepCurrentModel/saveViewState protect the model and cursor/undo state.
- Idle clean models with no undo/redo use a separate 8 MiB/12-model LRU. Protected models can exceed this cache budget. Explicit closed-tab models release after the last view lease; file-content pruning never disposes dirty/undo data to satisfy a cache cap.
- Active Diff, pending confirmation and markdown-navigation views remain mounted. Current-project workspace mirrors share authoritative file arrays and selection, so closed/pre-edit bodies cannot hide outside the cache accounting.
- Save protection is reference-counted for overlapping saves. No source file deletion, schema change or automatic dirty-buffer eviction.
- File-location comparisons use the narrow `files/api/fileLocation` entry and the same root key as the cache: Windows drive roots/ordinary UNC ignore case, POSIX/WSL UNC retain case. SSH host/remote-root semantics are unchanged. Model URI root identities are double-encoded because Monaco decodes a single layer before path normalization; distinct root/file splits must not collide.
- Regressions: `editorModelResidency.test.mjs`, `fileContentResidency.test.mjs`, `fileContentDemandStore.test.mjs`.

> Concrete Tauri command contracts for browsing and editing files inside a configured project root.

---

## Scenario: Project-Scoped File Browser

### 1. Scope / Trigger

- Trigger: any Tauri command that reads, writes, creates, deletes, copies, moves, or searches files under a user-selected project path.
- Boundary: the frontend passes `rootPath` plus relative paths; Rust is the authority for path validation and filesystem effects.
- Non-goal: do not broaden `assetProtocol.scope` or use frontend-side fs access for project files.

### 2. Signatures

Backend commands in `src-tauri/src/features/files/commands.rs`:

```rust
file_watch_start(project_path: String) -> Result<(), String>
file_watch_stop(project_path: String) -> Result<(), String>
file_list_dir(root_path: String, relative_path: String) -> Result<Vec<FileEntry>, String>
file_search(root_path: String, query: String) -> Result<Vec<FileEntry>, String>
file_search_content(root_path: String, query: String) -> Result<Vec<ContentSearchMatch>, String>
file_read_text(root_path: String, relative_path: String) -> Result<TextFilePayload, String>
file_read_project_text(root_path: String, relative_path: String) -> Result<ProjectTextFilePayload, String>
file_read_image(root_path: String, relative_path: String) -> Result<ImageFilePayload, String>
file_write_text(root_path: String, relative_path: String, content: String) -> Result<(), String>
file_write_project_text(root_path: String, relative_path: String, content: String, encoding: String, has_bom: bool) -> Result<(), String>
file_create_file(root_path: String, parent_path: String, name: String, overwrite: bool) -> Result<(), String>
file_create_dir(root_path: String, parent_path: String, name: String, overwrite: bool) -> Result<(), String>
file_rename(root_path: String, relative_path: String, new_name: String, overwrite: bool) -> Result<(), String>
file_delete(root_path: String, relative_path: String) -> Result<(), String>
file_copy(root_path: String, source_path: String, target_parent_path: String, name: String, overwrite: bool) -> Result<(), String>
file_move(root_path: String, source_path: String, target_parent_path: String, name: String, overwrite: bool) -> Result<(), String>
```

Payloads:

```rust
FileEntry { name: String, path: String, kind: String, is_symlink: bool, size_bytes: u64, modified_ms: Option<u64> }
ContentSearchMatch { path: String, name: String, line_number: usize, line_text: String, before: Vec<String>, after: Vec<String> }
TextFilePayload { content: String, size_bytes: u64 }
ProjectTextFilePayload { content: String, size_bytes: u64, encoding: String, has_bom: bool, guessed: bool }
ImageFilePayload { data_base64: String, mime_type: String, size_bytes: u64 }
ProjectFilesChangedPayload { project_path: String, changed_paths: Vec<String> }
```

### 3. Contracts

- `rootPath` must be absolute, canonicalizable, and a directory.
- `file_watch_start` / `file_watch_stop` only accept a project root path; Rust owns watcher lifecycle and WSL/network-path fallback signaling.
- `project-files-changed` emits `projectPath` plus project-relative `changedPaths` using forward slashes; frontend refresh logic must treat an omitted/empty `changedPaths` as a full visible refresh fallback.
- The frontend file tree reads only the project-root `.gitignore` and applies standard Gitignore matching semantics, including root anchors, nested bare-directory rules, wildcards, negation, and directory-only patterns. A present but empty file is authoritative; missing or unreadable files use the built-in fallback matcher.
- Gitignore case matching follows the project path environment: local Windows drive paths and regular Windows UNC paths are case-insensitive, while WSL UNC and POSIX paths are case-sensitive. Do not rely on the `ignore` package default because it is unconditionally case-insensitive.
- When `project-files-changed.changedPaths` includes `.gitignore`, the frontend must reload the active matcher without requiring a project switch. Matcher-hit directories stay accessible through the collapsed group, while matcher-hit files are omitted from the normal tree; user-managed ignored paths and default collapsed directory names remain additive.
- Relative path fields use forward slashes only; empty string means project root where accepted.
- `name` / `newName` are single child names only; they must not contain `/` or `\`.
- `FileEntry.is_symlink` serializes to frontend `isSymlink`; it marks the entry itself as a symlink/reparse-style link, not whether the resolved target is a directory.
- For WSL UNC roots, `file_list_dir` must avoid Windows Plan 9 directory enumeration and use `wsl.exe -d <distro> --exec find -H <path> -mindepth 1 -maxdepth 1 -printf "%f\0%y\0%Y\0%s\0%T@\0"` so command-line symlink roots are traversable and child directory symlinks can be reported as `kind="directory", is_symlink=true`.
- The project-creation WSL symlink picker must filter entries to `kind === "directory" && isSymlink === true`; ordinary directories remain visible in the normal project file browser but are not shown in the symlink picker.
- `file_read_text` only returns UTF-8 text and rejects files larger than 1 MiB; known video extensions are rejected before reading bytes. This stable command remains the internal Replay/sync file contract.
- Actual reads use a limit-plus-one sentinel and report the actual byte count, not stale metadata. Internal sync/preview still uses the 1 MiB contract; Replay patch loading uses `file_read_replay_patch(relative_path)` from the explicit `commands::fs::replay_patch` registry path, restricted to managed `replay-snapshots/*.patch` paths and 4 MiB. Both validate canonical root containment and UTF-8; never accept a frontend-supplied root for the larger allowance.
- `file_read_project_text` is the user-project editor command. It detects UTF-8/BOM, UTF-16 BOM, and common legacy encodings, rejects binary/undecodable content, and returns canonical encoding plus BOM metadata.
- Video-extension eligibility is mirrored by the frontend precheck, local file command, and SSH Agent. The three lists must stay semantically aligned: TypeScript `.ts` is source text for project preview and must reach normal decoding rather than return `video_preview_unsupported`; a genuinely binary `.ts` payload is still handled by the existing binary/decode guard.
- `file_write_text` keeps its existing UTF-8 signature and behavior for internal data.
- `file_write_project_text` strictly encodes with the metadata returned by `file_read_project_text`; it must preserve BOM policy and reject unmappable characters instead of replacing them or silently converting to UTF-8.
- `file_read_image` returns base64 plus MIME type, but must reject images larger than 5 MiB before reading bytes. JPEG/PNG/GIF/WebP/BMP dimensions are read before Base64 conversion and raster images above 12,000,000 pixels are rejected. SVG remains size-bounded without a raster pixel check.
- `file_search` and `file_search_content` must be bounded: skip known heavy/generated directories, cap returned results, and never broaden WebView file access.
- `file_search_content` scans supported user-project text encodings within the project root, skips large/binary/undecodable files and common binary extensions, and returns at most one representative match per file with 1-based line numbers and bounded context snippets.
- `overwrite=false` must return `target_exists` when the destination exists.
- `overwrite=true` may replace the target after Rust revalidates the destination stays inside root.
- `file_delete` and `file_move` reject symlink/reparse components in the source relative path before canonicalizing it; otherwise a source link could be dereferenced and its target destructively operated on. The selected project root itself remains canonicalized normally.
- The frontend skips same-parent moves. Direct same-source commands retain the existing `source_equals_target` rejection. Moving over an ancestor containing the source is rejected before any destination removal.

### 4. Validation & Error Matrix

| Condition | Error |
|---|---|
| `rootPath` is relative | `root_not_absolute` |
| `rootPath` does not exist or cannot canonicalize | `root_canonicalize_failed: ...` |
| `rootPath` is not a directory | `root_not_directory` |
| Relative path contains `\` | `path_contains_backslash` |
| Relative path contains `.` segment | `path_contains_current_segment` |
| Relative path contains `..` segment | `path_contains_parent_segment` |
| Relative path is absolute | `path_is_absolute` |
| Canonicalized path escapes root | `path_outside_root` |
| Child name is empty, `.` or `..` | `empty_name` / `invalid_name` |
| Child name contains path separator | `name_contains_separator` |
| Delete target is root | `cannot_delete_root` |
| Copy/move directory into itself | `target_inside_source` |
| Delete/move source has a symlink/reparse component | `path_is_symlink` |
| Move destination is an ancestor of the source | `target_contains_source` |
| Destination exists without overwrite | `target_exists` |
| Text file is too large | `file_too_large` |
| Text path has a known video extension | `video_preview_unsupported` |
| TypeScript `.ts` source path | normal text decode; never `video_preview_unsupported` solely because of the extension |
| Text file is not UTF-8 | `not_utf8` |
| Project text file is binary | `binary_file` |
| Project text encoding cannot be decoded | `text_decode_failed` |
| Project text encoding label is unsupported on save | `unsupported_text_encoding` |
| Edited text contains characters unavailable in the original encoding | `text_encoding_unmappable` |
| Image extension unsupported | `unsupported_image` |
| Image exceeds 5 MiB | `image_file_too_large` |
| Raster image exceeds 12,000,000 pixels | `image_dimensions_too_large` |
| Search query is empty or whitespace | returns empty list |
| Content search file is too large, binary, or undecodable | skip file |
| Search hits exceed backend cap | return capped list |

### 5. Good/Base/Bad Cases

- Good: `file_list_dir(rootPath, "")` returns sorted directories before files, with project-relative `path`.
- Good: WSL `file_list_dir("\\wsl.localhost\\Ubuntu\\data", "")` returns a Linux symlink-to-directory as `kind="directory", isSymlink=true`, allowing the symlink picker to show it.
- Good: `file_search_content(rootPath, "invoke")` returns bounded `{ path, line_number, line_text, before, after }` snippets for UTF-8 project files, with duplicate hits in the same file collapsed to the first match.
- Good: `file_watch_start(projectPath)` uses a debounced recursive watcher for local Windows paths and returns a stable error such as `wsl_watch_unsupported` when notify cannot be used.
- Good: watcher events for `src/main.ts` emit `changedPaths: ["src/main.ts"]`, allowing the frontend to refresh `src` instead of every expanded directory.
- Base: `file_write_text(rootPath, "src/app/App.tsx", content)` writes only if `src` remains inside `rootPath`.
- Good: `file_read_project_text` opens GBK or UTF-16 BOM source files and `file_write_project_text` writes them back with the same encoding/BOM.
- Good: local and SSH `src/main.ts` source files bypass video classification and return text; `clip.mp4` remains rejected before content reading on both paths.
- Good: the frontend rejects a known oversized entry before invoking Rust; Rust repeats size and pixel checks for search results with unknown size and direct IPC calls.
- Bad: reading or Base64-encoding a video, oversized file, or oversized raster image before enforcing its preview limit.
- Bad: an unmappable character in a legacy-encoded file is replaced with `?` or triggers an implicit UTF-8 conversion.
- Base: `file_search(rootPath, "app")` can match file names or project-relative paths, but skips generated directories such as `node_modules`.
- Bad: the WSL symlink picker must not show ordinary directories with `isSymlink=false`.
- Bad: `file_delete(rootPath, "")` must fail with `cannot_delete_root`.
- Bad: `file_copy(rootPath, "src", "src/nested", "src", true)` must fail with `target_inside_source`.
- Bad: content search must not recurse into `.git`, `.trellis`, `node_modules`, `dist`, `build`, or `target`.

### 6. Tests Required

- Unit-test `validate_relative_path` accepts root and nested paths.
- Unit-test `validate_relative_path` rejects absolute, parent, current, and backslash paths.
- Unit-test `validate_child_name` rejects empty names, `.` / `..`, and separators.
- Unit-test canonicalization rejects paths outside root.
- Unit-test copy and move stay inside root and enforce `target_exists` / `target_inside_source`.
- Unit-test file search skips heavy/generated directories.
- Unit-test WSL `find` output parsing marks directory symlinks as `kind="directory", is_symlink=true` and ordinary directories/files as `is_symlink=false`.
- Unit-test content search returns line/context data and skips heavy/generated directories.
- Unit-test content search returns only one match per file even when a file contains multiple matching lines.
- Unit-test project text read/write preserves GBK bytes and leaves the file unchanged when saving unmappable content.
- Unit-test shared encoding logic covers UTF-8 BOM, UTF-16 LE/BE BOM, legacy encoding detection, binary rejection, and strict encoding failure.
- Unit-test the exact 12,000,000-pixel boundary and rejection above it; assert known video extensions are rejected before content decoding.
- Regression-test the extension collision across both readers: local and SSH `.ts` source must decode as text while `.mp4` still returns `video_preview_unsupported`.
- Unit-test watcher path filtering keeps project-relative paths stable and ignores generated/noisy directories.
- Focused frontend tests cover nested bare-directory rules, root-anchored rules, wildcards, negation, directory-only matching, fallback defaults, and `.gitignore` watcher-path detection.
- Focused frontend tests cover case-distinct directory names for Windows, regular UNC, WSL UNC, and POSIX project paths.

### 7. Wrong vs Correct

#### Wrong

```typescript
// Do not expose arbitrary project files through WebView asset scope.
const imageUrl = convertFileSrc(`${project.path}/${relativePath}`);
```

#### Correct

```typescript
const image = await invoke<ProjectImageFilePayload>("file_read_image", {
  rootPath: project.path,
  relativePath,
});
```

Rust validates `rootPath` and `relativePath`, reads the file, and returns bounded data without expanding global file access.

#### Wrong

```typescript
listen("project-files-changed", () => refreshVisibleState());
```

This discards watcher path information and refreshes every expanded directory for a one-file save.

#### Correct

```typescript
listen<{ projectPath: string; changedPaths?: string[] }>("project-files-changed", (event) => {
  if (event.payload.projectPath === project.path) {
    void refreshVisibleState(event.payload.changedPaths);
  }
});
```

The frontend can still fall back to a full visible refresh when `changedPaths` is missing, but same-version watcher events should pass the affected relative paths through.

#### Wrong

```typescript
// Do not perform project-wide code search in the WebView by reading files directly.
const content = await readTextFile(`${project.path}/${relativePath}`);
```

#### Correct

```typescript
const matches = await invoke<ProjectFileContentMatch[]>("file_search_content", {
  rootPath: project.path,
  query,
});
```

Rust owns traversal, root validation, skipped directories, file-size limits, UTF-8 checks, and result caps.

#### Wrong

```text
Frontend allows .ts → local or SSH reader still rejects .ts as video
```

#### Correct

```text
Frontend precheck, local is_video_path, and SSH is_video all treat .ts as text;
binary or undecodable content is rejected by the existing decode guard.
```

---

## Scenario: Built-in Live Server

### 1. Scope / Trigger

- Trigger: a local project or Worktree `.html` / `.htm` context-menu action.
- Boundary: Rust serves only canonical files below the selected project root; the frontend eligibility check is not a security boundary.
- Non-goal: no framework command, dependency install, directory listing, backend proxy, SSH/WSL access, or external Live Server fallback.

### 2. Signatures

```rust
live_server_start(project_path: String, relative_path: String) -> Result<LiveServerOpenResult, String>
live_server_status(project_path: String) -> Result<Option<LiveServerSession>, String>
live_server_stop(project_path: String) -> Result<bool, String>

LiveServerSession { project_path: String, origin: String, port: u16 }
LiveServerOpenResult { session: LiveServerSession, url: String, reused: bool }
```

### 3. Contracts

- Bind exactly `127.0.0.1:0`; return the OS-assigned port and reuse one session per normalized project path.
- Accept only `GET` and `HEAD`, require `Host: 127.0.0.1:<bound-port>`, and return `Cache-Control: no-store` plus `X-Content-Type-Options: nosniff`.
- Reserve `/__cli_manager_live_server__/version`; injected HTML polls it every 400 ms and reloads after the debounced watcher advances the version.
- Relative entry/request paths use forward slashes, reject absolute/current/parent/backslash segments, percent-decode before validation, and must canonicalize below the canonical root.
- Start requires an existing `.html` / `.htm` file. Request `/` and in-root directories resolve to `index.html`; there is no directory listing.
- MIME types come from `mime_guess`. HTML receives the reload client before a case-insensitive `</body>`, or appended when no close tag exists.
- A 250 ms recursive watcher ignores VCS/generated high-churn directories. Stop drops the watcher and listener owner; `RunEvent::Exit` clears all sessions.
- Browser-opener failure is returned to the UI as `browser_open_failed` after the backend session is recorded; no alternate browser/runtime is attempted.

### 4. Validation & Error Matrix

| Condition | Error / response |
|---|---|
| Invalid root | `root_not_absolute` / `root_canonicalize_failed` / `root_not_directory` |
| Invalid relative entry | `path_contains_*` / `path_is_absolute` |
| Missing or non-HTML entry | `entry_not_found` / `entry_not_html` |
| Canonical escape | `path_outside_root` |
| Listener or watcher setup failure | `listener_*` / `watcher_init_failed` / `watch_failed` |
| Unexpected Host / method | HTTP `403` / `405` |
| Missing served file | HTTP `404` |

### 5. Required Tests

- Validate Unicode/space URL encoding, nested index resolution, traversal/backslash rejection, and canonical containment.
- Validate case-insensitive HTML injection with and without `</body>`.
- Validate generated-directory watcher filtering and relevant in-root changes.
- Start a real loopback listener; assert static response, exact Host behavior, same-root reuse, stop, and listener shutdown.

## Explicit external clipboard imports (TEMP, 2026-09-14)
New commands live in `src-tauri/src/features/files/commands/clipboard_import.rs`; existing filesystem and terminal attachment signatures stay stable.

```rust
clipboard_get_revision() -> Option<u32>
file_clipboard_read(app: AppHandle, known_revision: Option<u32>) -> Result<ClipboardSnapshot, String>
file_import_external(root_path: String, source_path: String, target_parent_path: String, name: String, overwrite: bool, protected_source_paths: Vec<String>) -> Result<(), String>
file_import_image(root_path: String, target_parent_path: String, name: String, data_base64: String, overwrite: bool) -> Result<(), String>
```
- Snapshot serializes `{ unchanged, entries: [{ path, name, kind, isSymlink, dataBase64 }] }`; `dataBase64=null` means absolute native source path. Screenshot identities are `clipboard-image:<uuid>` and names are unique timestamped PNGs.
- Windows uses native sequence numbers and CF_HDROP handles; `DragQueryFileW` receives the handle, never the GlobalLock pointer. Clipboard acquisition is bounded to 5 attempts / 20 ms intervals; file lists cap at 4096. A changed revision during snapshot reads fails explicitly. Clipboard is never written/cleared.
- Images are obtained from the existing clipboard plugin on a blocking worker, encoded as PNG, limited to 12M pixels / 64 MiB encoded bytes, and validated on import. No temporary-attachment retention applies to project imports.
- External files are COPY-only, including Explorer Cut. Absolute sources and canonical project-relative destinations are validated independently; reject unsafe child names, device/ADS aliases, links/reparse points, non-regular files, excessive nesting, self/ancestor/descendant imports and overlap with any protected batch source. Windows existing target aliases are canonicalized for overlap checks.
- Stage complete source data beside target before modifying old destination. No-overwrite is default; directory overwrite replaces, not merges. Confirmed overwrite backs up the old item and rolls it back on publication failure. Failed rollback preserves `.cli-manager-import-<uuid>/previous` and returns its path. Windows publication uses MoveFileExW with flags=0 to refuse replacing a concurrently created target. Windows local/WSL/UNC filesystem availability and permissions remain authoritative.
- No app-data/config/asset protocol scope changes. SSH remains UI/store read-only; no remote upload is implied.
- Required tests: copied bytes/empty files/Unicode/nested directories, conflict retry, dirty and stale-context guards, screenshot PNG validity, invalid source/target/image, self/ancestor/descendant/batch overlap, case aliases, actual links, staging failure and publication rollback. Desktop clipboard/menu/focus/language checks require a human per frontend quality rules.
