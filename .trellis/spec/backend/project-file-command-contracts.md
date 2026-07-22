# Project File Command Contracts

> Concrete Tauri command contracts for browsing and editing files inside a configured project root.

---

## Scenario: Project-Scoped File Browser

### 1. Scope / Trigger

- Trigger: any Tauri command that reads, writes, creates, deletes, copies, moves, or searches files under a user-selected project path.
- Boundary: the frontend passes `rootPath` plus relative paths; Rust is the authority for path validation and filesystem effects.
- Non-goal: do not broaden `assetProtocol.scope` or use frontend-side fs access for project files.

### 2. Signatures

Backend commands in `src-tauri/src/commands/fs.rs`:

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
- `file_read_project_text` is the user-project editor command. It detects UTF-8/BOM, UTF-16 BOM, and common legacy encodings, rejects binary/undecodable content, and returns canonical encoding plus BOM metadata.
- `file_write_text` keeps its existing UTF-8 signature and behavior for internal data.
- `file_write_project_text` strictly encodes with the metadata returned by `file_read_project_text`; it must preserve BOM policy and reject unmappable characters instead of replacing them or silently converting to UTF-8.
- `file_read_image` returns base64 plus MIME type, but must reject images larger than 5 MiB before reading bytes. JPEG/PNG/GIF/WebP/BMP dimensions are read before Base64 conversion and raster images above 12,000,000 pixels are rejected. SVG remains size-bounded without a raster pixel check.
- `file_search` and `file_search_content` must be bounded: skip known heavy/generated directories, cap returned results, and never broaden WebView file access.
- `file_search_content` scans supported user-project text encodings within the project root, skips large/binary/undecodable files and common binary extensions, and returns at most one representative match per file with 1-based line numbers and bounded context snippets.
- `overwrite=false` must return `target_exists` when the destination exists.
- `overwrite=true` may replace the target after Rust revalidates the destination stays inside root.

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
| Destination exists without overwrite | `target_exists` |
| Text file is too large | `file_too_large` |
| Text path has a known video extension | `video_preview_unsupported` |
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
- Base: `file_write_text(rootPath, "src/App.tsx", content)` writes only if `src` remains inside `rootPath`.
- Good: `file_read_project_text` opens GBK or UTF-16 BOM source files and `file_write_project_text` writes them back with the same encoding/BOM.
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
