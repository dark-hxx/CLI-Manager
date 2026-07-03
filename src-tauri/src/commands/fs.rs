use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use base64::{engine::general_purpose, Engine as _};
use memchr::memmem;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::file_watcher::FileWatcherBridge;

const TEXT_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const IMAGE_FILE_MAX_BYTES: u64 = 10 * 1024 * 1024;
const FILE_SEARCH_MAX_RESULTS: usize = 1000;
const CONTENT_SEARCH_MAX_RESULTS: usize = 200;
const CONTENT_SEARCH_MAX_FILE_BYTES: u64 = 1024 * 1024;
const CONTENT_SEARCH_CONTEXT_LINES: usize = 1;
const CONTENT_SEARCH_MAX_LINE_CHARS: usize = 300;
const SEARCH_SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".trellis",
    ".idea",
    ".vscode",
    ".cache",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
];
const CONTENT_SEARCH_SKIPPED_EXTENSIONS: &[&str] = &[
    "7z", "bmp", "class", "dll", "dmg", "exe", "gif", "gz", "ico", "jar", "jpeg", "jpg", "lockb",
    "mov", "mp3", "mp4", "pdf", "png", "pyc", "rar", "so", "tar", "wasm", "webp", "zip",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFilePayload {
    pub content: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFilePayload {
    pub data_base64: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatch {
    pub path: String,
    pub name: String,
    pub line_number: usize,
    pub line_text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

#[tauri::command]
pub async fn check_paths_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    tokio::task::spawn_blocking(move || paths.iter().map(|p| Path::new(p).exists()).collect())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn file_watch_start(
    app_handle: AppHandle,
    bridge: State<'_, FileWatcherBridge>,
    project_path: String,
) -> Result<(), String> {
    bridge.start(app_handle, project_path)
}

#[tauri::command]
pub async fn file_watch_stop(
    bridge: State<'_, FileWatcherBridge>,
    project_path: String,
) -> Result<(), String> {
    bridge.stop(project_path)
}

#[tauri::command]
pub async fn file_list_dir(
    root_path: String,
    relative_path: String,
) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let dir = resolve_existing_path(&root, &relative_path)?;
        if !dir.is_dir() {
            return Err("not_directory".into());
        }

        let mut entries = Vec::new();
        for item in fs::read_dir(&dir).map_err(|err| format!("read_dir_failed: {err}"))? {
            let entry = item.map_err(|err| format!("read_dir_entry_failed: {err}"))?;
            let path = entry.path();
            let metadata = entry
                .metadata()
                .map_err(|err| format!("metadata_failed: {err}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = relative_from_root(&root, &path)?;
            entries.push(FileEntry {
                name,
                path: rel,
                kind: if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                }
                .into(),
                size_bytes: metadata.len(),
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64),
            });
        }

        entries.sort_by_cached_key(|entry| {
            (
                if entry.kind == "directory" { 0u8 } else { 1u8 },
                entry.name.to_lowercase(),
            )
        });
        Ok(entries)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_search(root_path: String, query: String) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        collect_search_matches(&root, &root, &needle, &mut entries)?;
        entries.sort_by_cached_key(|entry| entry.path.to_lowercase());
        Ok(entries)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_search_content(
    root_path: String,
    query: String,
) -> Result<Vec<ContentSearchMatch>, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut matches = Vec::new();
        collect_content_matches(&root, &root, &needle, &mut matches)?;
        matches.sort_by_cached_key(|item| (item.path.to_lowercase(), item.line_number));
        Ok(matches)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_read_text(
    root_path: String,
    relative_path: String,
) -> Result<TextFilePayload, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let path = resolve_existing_path(&root, &relative_path)?;
        let metadata = fs::metadata(&path).map_err(|err| format!("metadata_failed: {err}"))?;
        if !metadata.is_file() {
            return Err("not_file".into());
        }
        if metadata.len() > TEXT_FILE_MAX_BYTES {
            return Err("file_too_large".into());
        }
        let bytes = fs::read(&path).map_err(|err| format!("read_file_failed: {err}"))?;
        let content = String::from_utf8(bytes).map_err(|_| "not_utf8".to_string())?;
        Ok(TextFilePayload {
            content,
            size_bytes: metadata.len(),
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_read_image(
    root_path: String,
    relative_path: String,
) -> Result<ImageFilePayload, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let path = resolve_existing_path(&root, &relative_path)?;
        let metadata = fs::metadata(&path).map_err(|err| format!("metadata_failed: {err}"))?;
        if !metadata.is_file() {
            return Err("not_file".into());
        }
        if metadata.len() > IMAGE_FILE_MAX_BYTES {
            return Err("file_too_large".into());
        }
        let mime_type = image_mime_type(&path).ok_or_else(|| "unsupported_image".to_string())?;
        let bytes = fs::read(&path).map_err(|err| format!("read_file_failed: {err}"))?;
        Ok(ImageFilePayload {
            data_base64: general_purpose::STANDARD.encode(bytes),
            mime_type: mime_type.into(),
            size_bytes: metadata.len(),
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_write_text(
    root_path: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let path = resolve_target_path(&root, &relative_path)?;
        if let Some(parent) = path.parent() {
            ensure_existing_child_within_root(&root, parent)?;
        }
        fs::write(&path, content).map_err(|err| format!("write_file_failed: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_create_file(
    root_path: String,
    parent_path: String,
    name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_named_target(&root, &parent_path, &name)?;
        prepare_target(&target, overwrite)?;
        fs::write(&target, "").map_err(|err| format!("create_file_failed: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_create_dir(
    root_path: String,
    parent_path: String,
    name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_named_target(&root, &parent_path, &name)?;
        prepare_target(&target, overwrite)?;
        fs::create_dir(&target).map_err(|err| format!("create_dir_failed: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_rename(
    root_path: String,
    relative_path: String,
    new_name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let source = resolve_existing_path(&root, &relative_path)?;
        let parent = source
            .parent()
            .ok_or_else(|| "missing_parent".to_string())?;
        let target = resolve_child_target(&root, parent, &new_name)?;
        move_path(&root, &source, &target, overwrite)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_delete(root_path: String, relative_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_existing_path(&root, &relative_path)?;
        if target == root {
            return Err("cannot_delete_root".into());
        }
        remove_path(&target)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_copy(
    root_path: String,
    source_path: String,
    target_parent_path: String,
    name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let source = resolve_existing_path(&root, &source_path)?;
        let target = resolve_named_target(&root, &target_parent_path, &name)?;
        if source.is_dir() && target.starts_with(&source) {
            return Err("target_inside_source".into());
        }
        prepare_target(&target, overwrite)?;
        copy_path(&source, &target)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_move(
    root_path: String,
    source_path: String,
    target_parent_path: String,
    name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let source = resolve_existing_path(&root, &source_path)?;
        let target = resolve_named_target(&root, &target_parent_path, &name)?;
        move_path(&root, &source, &target, overwrite)
    })
    .await
    .map_err(|err| err.to_string())?
}

pub(crate) fn validate_relative_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() {
        return Ok(());
    }
    if path.contains('\\') {
        return Err("path_contains_backslash");
    }
    let rel = Path::new(path);
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => return Err("path_contains_current_segment"),
            Component::ParentDir => return Err("path_contains_parent_segment"),
            Component::RootDir | Component::Prefix(_) => return Err("path_is_absolute"),
        }
    }
    Ok(())
}

pub(crate) fn validate_child_name(name: &str) -> Result<(), &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("empty_name");
    }
    if trimmed == "." || trimmed == ".." {
        return Err("invalid_name");
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("name_contains_separator");
    }
    Ok(())
}

fn canonical_root(root_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root_path);
    if !root.is_absolute() {
        return Err("root_not_absolute".into());
    }
    let canonical = root
        .canonicalize()
        .map_err(|err| format!("root_canonicalize_failed: {err}"))?;
    if !canonical.is_dir() {
        return Err("root_not_directory".into());
    }
    Ok(canonical)
}

fn resolve_existing_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative_path).map_err(|err| err.to_string())?;
    let joined = root.join(relative_path);
    let canonical = joined
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    ensure_existing_child_within_root(root, &canonical)?;
    Ok(canonical)
}

fn resolve_target_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative_path).map_err(|err| err.to_string())?;
    if relative_path.is_empty() {
        return Err("empty_target_path".into());
    }
    let target = root.join(relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| "missing_parent".to_string())?;
    ensure_existing_child_within_root(root, parent)?;
    Ok(target)
}

fn resolve_named_target(root: &Path, parent_path: &str, name: &str) -> Result<PathBuf, String> {
    let parent = resolve_existing_path(root, parent_path)?;
    if !parent.is_dir() {
        return Err("target_parent_not_directory".into());
    }
    resolve_child_target(root, &parent, name)
}

fn resolve_child_target(root: &Path, parent: &Path, name: &str) -> Result<PathBuf, String> {
    validate_child_name(name).map_err(|err| err.to_string())?;
    ensure_existing_child_within_root(root, parent)?;
    Ok(parent.join(name.trim()))
}

fn ensure_existing_child_within_root(root: &Path, path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    if canonical.starts_with(root) {
        Ok(())
    } else {
        Err("path_escapes_root".into())
    }
}

fn relative_from_root(root: &Path, path: &Path) -> Result<String, String> {
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    if !canonical.starts_with(root) {
        return Err("path_escapes_root".into());
    }
    canonical
        .strip_prefix(root)
        .map_err(|err| format!("strip_prefix_failed: {err}"))
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

fn prepare_target(target: &Path, overwrite: bool) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    if !overwrite {
        return Err("target_exists".into());
    }
    remove_path(target)
}

fn remove_path(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|err| format!("remove_dir_failed: {err}"))
    } else {
        fs::remove_file(path).map_err(|err| format!("remove_file_failed: {err}"))
    }
}

fn copy_path(source: &Path, target: &Path) -> Result<(), String> {
    if source.is_dir() {
        copy_dir_recursive(source, target)
    } else {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|err| format!("copy_file_failed: {err}"))
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target).map_err(|err| format!("copy_dir_create_failed: {err}"))?;
    for item in fs::read_dir(source).map_err(|err| format!("copy_dir_read_failed: {err}"))? {
        let entry = item.map_err(|err| format!("copy_dir_entry_failed: {err}"))?;
        let child_source = entry.path();
        let child_target = target.join(entry.file_name());
        copy_path(&child_source, &child_target)?;
    }
    Ok(())
}

fn move_path(root: &Path, source: &Path, target: &Path, overwrite: bool) -> Result<(), String> {
    if source == root {
        return Err("cannot_move_root".into());
    }
    if source.is_dir() && target.starts_with(source) {
        return Err("target_inside_source".into());
    }
    prepare_target(target, overwrite)?;
    fs::rename(source, target).map_err(|err| format!("move_failed: {err}"))
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())?
        .as_str()
    {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn search_relative_from_root(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|err| format!("strip_prefix_failed: {err}"))
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

fn should_skip_search_dir(name: &str) -> bool {
    SEARCH_SKIPPED_DIRECTORY_NAMES
        .iter()
        .any(|skipped| skipped.eq_ignore_ascii_case(name))
}

fn should_skip_content_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    CONTENT_SEARCH_SKIPPED_EXTENSIONS
        .iter()
        .any(|skipped| skipped.eq_ignore_ascii_case(ext))
}

fn text_matches(value: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.is_ascii() {
        return memmem::find(value.as_bytes(), needle.as_bytes()).is_some()
            || contains_ascii_case_insensitive(value.as_bytes(), needle.as_bytes());
    }
    value.to_lowercase().contains(needle)
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle_lowercase: &[u8]) -> bool {
    if needle_lowercase.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle_lowercase.len())
        .any(|window| window.eq_ignore_ascii_case(needle_lowercase))
}

fn truncate_search_line(line: &str) -> String {
    let mut chars = line.chars();
    let truncated: String = chars.by_ref().take(CONTENT_SEARCH_MAX_LINE_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn collect_search_matches(
    root: &Path,
    dir: &Path,
    needle: &str,
    out: &mut Vec<FileEntry>,
) -> Result<(), String> {
    if out.len() >= FILE_SEARCH_MAX_RESULTS {
        return Ok(());
    }
    for item in fs::read_dir(dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("read_dir_entry_failed: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("file_type_failed: {err}"))?;
        let metadata = entry
            .metadata()
            .map_err(|err| format!("metadata_failed: {err}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() && should_skip_search_dir(&name) {
            continue;
        }
        let rel = search_relative_from_root(root, &path)?;
        if text_matches(&name, needle) || text_matches(&rel, needle) {
            out.push(FileEntry {
                name: name.clone(),
                path: rel,
                kind: if file_type.is_dir() {
                    "directory"
                } else {
                    "file"
                }
                .into(),
                size_bytes: metadata.len(),
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64),
            });
            if out.len() >= FILE_SEARCH_MAX_RESULTS {
                return Ok(());
            }
        }
        if file_type.is_dir() {
            collect_search_matches(root, &path, needle, out)?;
        }
    }
    Ok(())
}

fn collect_content_matches(
    root: &Path,
    dir: &Path,
    needle: &str,
    out: &mut Vec<ContentSearchMatch>,
) -> Result<(), String> {
    if out.len() >= CONTENT_SEARCH_MAX_RESULTS {
        return Ok(());
    }
    for item in fs::read_dir(dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("read_dir_entry_failed: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("file_type_failed: {err}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if !should_skip_search_dir(&name) {
                collect_content_matches(root, &path, needle, out)?;
            }
            if out.len() >= CONTENT_SEARCH_MAX_RESULTS {
                return Ok(());
            }
            continue;
        }
        if !file_type.is_file() || should_skip_content_file(&path) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|err| format!("metadata_failed: {err}"))?;
        if metadata.len() > CONTENT_SEARCH_MAX_FILE_BYTES {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        collect_content_matches_in_file(root, &path, &name, &content, needle, out)?;
        if out.len() >= CONTENT_SEARCH_MAX_RESULTS {
            return Ok(());
        }
    }
    Ok(())
}

fn collect_content_matches_in_file(
    root: &Path,
    path: &Path,
    name: &str,
    content: &str,
    needle: &str,
    out: &mut Vec<ContentSearchMatch>,
) -> Result<(), String> {
    let lines: Vec<&str> = content.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if out.len() >= CONTENT_SEARCH_MAX_RESULTS {
            return Ok(());
        }
        if !text_matches(line, needle) {
            continue;
        }
        let before_start = index.saturating_sub(CONTENT_SEARCH_CONTEXT_LINES);
        let after_end = usize::min(lines.len(), index + CONTENT_SEARCH_CONTEXT_LINES + 1);
        out.push(ContentSearchMatch {
            path: search_relative_from_root(root, path)?,
            name: name.to_string(),
            line_number: index + 1,
            line_text: truncate_search_line(line),
            before: lines[before_start..index]
                .iter()
                .map(|line| truncate_search_line(line))
                .collect(),
            after: lines[index + 1..after_end]
                .iter()
                .map(|line| truncate_search_line(line))
                .collect(),
        });
        return Ok(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn validate_relative_path_accepts_root_and_nested_paths() {
        assert!(validate_relative_path("").is_ok());
        assert!(validate_relative_path("src/main.ts").is_ok());
        assert!(validate_relative_path("src/components/App.tsx").is_ok());
    }

    #[test]
    fn validate_relative_path_rejects_escape_and_absolute_paths() {
        assert_eq!(
            validate_relative_path("../secret").unwrap_err(),
            "path_contains_parent_segment"
        );
        assert_eq!(
            validate_relative_path("src\\main.ts").unwrap_err(),
            "path_contains_backslash"
        );
        assert_eq!(
            validate_relative_path("/etc/passwd").unwrap_err(),
            "path_is_absolute"
        );
    }

    #[test]
    fn validate_child_name_rejects_separators_and_empty_names() {
        assert!(validate_child_name("main.ts").is_ok());
        assert_eq!(validate_child_name("").unwrap_err(), "empty_name");
        assert_eq!(
            validate_child_name("a/b").unwrap_err(),
            "name_contains_separator"
        );
        assert_eq!(
            validate_child_name("a\\b").unwrap_err(),
            "name_contains_separator"
        );
        assert_eq!(validate_child_name("..").unwrap_err(), "invalid_name");
    }

    #[test]
    fn resolve_existing_path_rejects_paths_outside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "secret").unwrap();
        let root = root.canonicalize().unwrap();

        assert_eq!(
            resolve_existing_path(&root, "../outside").unwrap_err(),
            "path_contains_parent_segment"
        );
    }

    #[test]
    fn copy_and_move_stay_inside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a").join("one.txt"), "one").unwrap();
        let root = root.canonicalize().unwrap();

        let source = resolve_existing_path(&root, "a/one.txt").unwrap();
        let target = resolve_named_target(&root, "", "two.txt").unwrap();
        copy_path(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(root.join("two.txt")).unwrap(), "one");

        let moved = resolve_named_target(&root, "", "three.txt").unwrap();
        move_path(&root, &target, &moved, false).unwrap();
        assert!(!root.join("two.txt").exists());
        assert_eq!(fs::read_to_string(root.join("three.txt")).unwrap(), "one");
    }

    #[test]
    fn file_search_skips_heavy_directories() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src").join("needle.ts"), "ok").unwrap();
        fs::write(root.join(".git").join("needle.txt"), "skip").unwrap();
        let root = root.canonicalize().unwrap();

        let mut entries = Vec::new();
        collect_search_matches(&root, &root, "needle", &mut entries).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src/needle.ts");
    }

    #[test]
    fn content_search_returns_context_and_skips_heavy_directories() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(
            root.join("src").join("main.ts"),
            "first line\nconst target = true;\nthird line\nsecond target\n",
        )
        .unwrap();
        fs::write(root.join("node_modules").join("ignored.ts"), "target").unwrap();
        let root = root.canonicalize().unwrap();

        let mut matches = Vec::new();
        collect_content_matches(&root, &root, "target", &mut matches).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/main.ts");
        assert_eq!(matches[0].line_number, 2);
        assert_eq!(matches[0].line_text, "const target = true;");
        assert_eq!(matches[0].before, vec!["first line"]);
        assert_eq!(matches[0].after, vec!["third line"]);
    }

    #[test]
    fn content_search_returns_one_match_per_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("main.ts"), "target one\ntarget two\n").unwrap();
        fs::write(root.join("src").join("other.ts"), "target three\n").unwrap();
        let root = root.canonicalize().unwrap();

        let mut matches = Vec::new();
        collect_content_matches(&root, &root, "target", &mut matches).unwrap();

        assert_eq!(matches.len(), 2);
        assert!(matches
            .iter()
            .any(|item| item.path == "src/main.ts" && item.line_number == 1));
        assert!(matches
            .iter()
            .any(|item| item.path == "src/other.ts" && item.line_number == 1));
    }
}
