use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use memchr::memmem;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::file_watcher::FileWatcherBridge;
use crate::shell_resolver::silent_command;
use crate::text_encoding::{decode_text, encode_text};

const TEXT_FILE_MAX_BYTES: u64 = 1024 * 1024;
const IMAGE_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;
const IMAGE_MAX_PIXELS: u64 = 12_000_000;
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
const ATTACHMENT_RETENTION_SECS: u64 = 2 * 24 * 60 * 60;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_symlink: bool,
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
pub struct ProjectTextFilePayload {
    pub content: String,
    pub size_bytes: u64,
    pub encoding: String,
    pub has_bom: bool,
    pub guessed: bool,
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
    tokio::task::spawn_blocking(move || paths.iter().map(|p| path_exists(p)).collect())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn file_get_path_kind(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || path_kind(&path))
        .await
        .map_err(|e| e.to_string())
}

fn path_kind(path: &str) -> String {
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(path) {
        return wsl_path_kind(&distro, &linux_path);
    }
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => "directory",
        Ok(metadata) if metadata.is_file() => "file",
        _ => "missing",
    }
    .into()
}

fn path_exists(path: &str) -> bool {
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(path) {
        return wsl_path_exists(&distro, &linux_path);
    }
    Path::new(path).exists()
}

fn wsl_path_exists(distro: &str, linux_path: &str) -> bool {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let args = wsl_path_exists_args(distro, linux_path);
    silent_command(&wsl_exe.to_string_lossy())
        .args(&args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn wsl_path_exists_args(distro: &str, linux_path: &str) -> Vec<String> {
    vec![
        "-d".into(),
        distro.into(),
        "--exec".into(),
        "sh".into(),
        "-c".into(),
        "test -e \"$1\" || test -L \"$1\"".into(),
        "cli-manager-path-check".into(),
        linux_path.into(),
    ]
}

fn wsl_path_kind(distro: &str, linux_path: &str) -> String {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let output = silent_command(&wsl_exe.to_string_lossy())
        .args(wsl_path_kind_args(distro, linux_path))
        .output();
    let Ok(output) = output else {
        return "missing".into();
    };
    if !output.status.success() {
        return "missing".into();
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "directory" => "directory",
        "file" => "file",
        _ => "missing",
    }
    .into()
}

fn wsl_path_kind_args(distro: &str, linux_path: &str) -> Vec<String> {
    vec![
        "-d".into(),
        distro.into(),
        "--exec".into(),
        "sh".into(),
        "-c".into(),
        "if test -d \"$1\"; then printf directory; elif test -f \"$1\"; then printf file; else printf missing; fi".into(),
        "cli-manager-path-kind".into(),
        linux_path.into(),
    ]
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
    tokio::task::spawn_blocking(move || list_dir_entries(&root_path, &relative_path))
        .await
        .map_err(|err| err.to_string())?
}

fn list_dir_entries(root_path: &str, relative_path: &str) -> Result<Vec<FileEntry>, String> {
    if let Some((distro, linux_root)) = crate::wsl::parse_wsl_unc_path(root_path) {
        return list_wsl_dir_entries(&distro, &linux_root, relative_path);
    }

    let root = canonical_root(root_path)?;
    let dir = resolve_existing_path(&root, relative_path)?;
    if !dir.is_dir() {
        return Err("not_directory".into());
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("read_dir_entry_failed: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("file_type_failed: {err}"))?;
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
            is_symlink: file_type.is_symlink(),
            size_bytes: metadata.len(),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64),
        });
    }

    sort_file_entries(&mut entries);
    Ok(entries)
}

fn list_wsl_dir_entries(
    distro: &str,
    linux_root: &str,
    relative_path: &str,
) -> Result<Vec<FileEntry>, String> {
    validate_relative_path(relative_path).map_err(|err| err.to_string())?;
    let linux_dir = join_linux_path(linux_root, relative_path);
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let output = silent_command(&wsl_exe.to_string_lossy())
        .args(["-d", distro, "--exec"])
        .args(wsl_find_dir_args(&linux_dir))
        .output()
        .map_err(|err| format!("read_dir_failed: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("read_dir_failed: {}", stderr.trim()));
    }

    parse_wsl_find_dir_entries(&output.stdout, relative_path)
}

fn wsl_find_dir_args(linux_dir: &str) -> [&str; 9] {
    [
        "find",
        "-H",
        linux_dir,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-printf",
        "%f\\0%y\\0%Y\\0%s\\0%T@\\0",
    ]
}

fn join_linux_path(root: &str, relative_path: &str) -> String {
    let root = root.trim_end_matches('/');
    if relative_path.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{}", relative_path.trim_start_matches('/'))
    }
}

fn parse_wsl_find_dir_entries(
    stdout: &[u8],
    relative_path: &str,
) -> Result<Vec<FileEntry>, String> {
    let mut fields = stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut entries = Vec::new();

    loop {
        let Some(name_raw) = fields.next() else {
            break;
        };
        let kind_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;
        let target_kind_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;
        let size_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;
        let modified_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;

        let name = String::from_utf8_lossy(name_raw).to_string();
        let is_symlink = kind_raw == b"l";
        let kind = if kind_raw == b"d" || (kind_raw == b"l" && target_kind_raw == b"d") {
            "directory"
        } else {
            "file"
        }
        .to_string();
        let size_bytes = String::from_utf8_lossy(size_raw)
            .parse::<u64>()
            .map_err(|err| format!("read_dir_parse_failed: {err}"))?;
        let modified_ms = parse_find_modified_ms(modified_raw);
        let path = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };

        entries.push(FileEntry {
            name,
            path,
            kind,
            is_symlink,
            size_bytes,
            modified_ms,
        });
    }

    sort_file_entries(&mut entries);
    Ok(entries)
}

fn parse_find_modified_ms(raw: &[u8]) -> Option<u64> {
    let value = String::from_utf8_lossy(raw).parse::<f64>().ok()?;
    if value.is_finite() && value >= 0.0 {
        Some((value * 1000.0) as u64)
    } else {
        None
    }
}

fn sort_file_entries(entries: &mut [FileEntry]) {
    entries.sort_by_cached_key(|entry| {
        (
            if entry.kind == "directory" { 0u8 } else { 1u8 },
            entry.name.to_lowercase(),
        )
    });
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
        let (bytes, size_bytes) = read_text_file_bytes(&root_path, &relative_path)?;
        let content = String::from_utf8(bytes).map_err(|_| "not_utf8".to_string())?;
        Ok(TextFilePayload {
            content,
            size_bytes,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_read_project_text(
    root_path: String,
    relative_path: String,
) -> Result<ProjectTextFilePayload, String> {
    tokio::task::spawn_blocking(move || {
        let (bytes, size_bytes) = read_text_file_bytes(&root_path, &relative_path)?;
        let decoded = decode_text(&bytes)?;
        Ok(ProjectTextFilePayload {
            content: decoded.content,
            size_bytes,
            encoding: decoded.encoding,
            has_bom: decoded.has_bom,
            guessed: decoded.guessed,
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
            return Err("image_file_too_large".into());
        }
        let mime_type = image_mime_type(&path).ok_or_else(|| "unsupported_image".to_string())?;
        validate_image_dimensions(&path)?;
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
        write_text_file_bytes(&root_path, &relative_path, content.into_bytes())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_write_project_text(
    root_path: String,
    relative_path: String,
    content: String,
    encoding: String,
    has_bom: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let bytes = encode_text(&content, &encoding, has_bom)?;
        write_text_file_bytes(&root_path, &relative_path, bytes)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn read_text_file_bytes(root_path: &str, relative_path: &str) -> Result<(Vec<u8>, u64), String> {
    let root = canonical_root(root_path)?;
    let path = resolve_existing_path(&root, relative_path)?;
    let metadata = fs::metadata(&path).map_err(|err| format!("metadata_failed: {err}"))?;
    if !metadata.is_file() {
        return Err("not_file".into());
    }
    if is_video_path(&path) {
        return Err("video_preview_unsupported".into());
    }
    if metadata.len() > TEXT_FILE_MAX_BYTES {
        return Err("file_too_large".into());
    }
    let bytes = fs::read(&path).map_err(|err| format!("read_file_failed: {err}"))?;
    Ok((bytes, metadata.len()))
}

fn write_text_file_bytes(
    root_path: &str,
    relative_path: &str,
    bytes: impl AsRef<[u8]>,
) -> Result<(), String> {
    let root = canonical_root(root_path)?;
    let path = resolve_target_path(&root, relative_path)?;
    if let Some(parent) = path.parent() {
        ensure_existing_child_within_root(&root, parent)?;
    }
    ensure_target_safe_for_write(&root, &path)?;
    fs::write(&path, bytes).map_err(|err| format!("write_file_failed: {err}"))
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
        copy_path(&root, &source, &target)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_attach_data(
    root_path: String,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let data = general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|err| format!("decode_failed: {err}"))?;
        if data.is_empty() {
            return Err("attachment_empty".into());
        }
        if data.len() as u64 > IMAGE_FILE_MAX_BYTES {
            return Err("attachment_too_large".into());
        }

        let attachments_dir = ensure_attachment_dir(&root)?;
        let file_name = sanitize_attachment_file_name(&file_name);
        let target = unique_attachment_target(&attachments_dir, &file_name)?;
        fs::write(&target, data).map_err(|err| format!("write_file_failed: {err}"))?;
        relative_from_root(&root, &target)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn file_cleanup_expired_attachments(root_path: String) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        cleanup_expired_attachments(&root, Duration::from_secs(ATTACHMENT_RETENTION_SECS))
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
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if !overwrite {
                return Err("target_exists".into());
            }
            remove_path_with_metadata(target, metadata)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("metadata_failed: {err}")),
    }
}

fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn ensure_target_safe_for_write(root: &Path, target: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("metadata_failed: {err}")),
    };
    if is_symlink_or_reparse(&metadata) {
        return Err("path_is_symlink".into());
    }
    ensure_existing_child_within_root(root, target)
}

fn remove_path_with_metadata(path: &Path, metadata: fs::Metadata) -> Result<(), String> {
    if metadata.is_dir() && !is_symlink_or_reparse(&metadata) {
        fs::remove_dir_all(path).map_err(|err| format!("remove_dir_failed: {err}"))
    } else {
        fs::remove_file(path).map_err(|err| format!("remove_file_failed: {err}"))
    }
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|err| format!("metadata_failed: {err}"))?;
    remove_path_with_metadata(path, metadata)
}

fn ensure_plain_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_symlink_or_reparse(&metadata) {
                return Err("path_is_symlink".into());
            }
            if metadata.is_dir() {
                Ok(())
            } else {
                Err("path_not_directory".into())
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|err| format!("create_dir_failed: {err}"))
        }
        Err(err) => Err(format!("metadata_failed: {err}")),
    }
}

fn ensure_attachment_dir(root: &Path) -> Result<PathBuf, String> {
    let cli_manager_dir = root.join(".cli-manager");
    ensure_plain_dir(&cli_manager_dir)?;
    let attachments_dir = cli_manager_dir.join("attachments");
    ensure_plain_dir(&attachments_dir)?;
    ensure_existing_child_within_root(root, &attachments_dir)?;
    Ok(attachments_dir)
}

fn get_existing_attachment_dir(root: &Path) -> Result<Option<PathBuf>, String> {
    let attachments_dir = root.join(".cli-manager").join("attachments");
    match fs::symlink_metadata(&attachments_dir) {
        Ok(metadata) => {
            if is_symlink_or_reparse(&metadata) {
                return Err("path_is_symlink".into());
            }
            if !metadata.is_dir() {
                return Err("path_not_directory".into());
            }
            ensure_existing_child_within_root(root, &attachments_dir)?;
            Ok(Some(attachments_dir))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("metadata_failed: {err}")),
    }
}

fn cleanup_expired_attachments(root: &Path, max_age: Duration) -> Result<u64, String> {
    let Some(attachments_dir) = get_existing_attachment_dir(root)? else {
        return Ok(0);
    };
    let now = SystemTime::now();
    let mut deleted = 0;
    for item in fs::read_dir(&attachments_dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("dir_entry_failed: {err}"))?;
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("metadata_failed: {err}")),
        };
        if is_symlink_or_reparse(&metadata) || !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() < max_age {
            continue;
        }
        fs::remove_file(&path).map_err(|err| format!("remove_file_failed: {err}"))?;
        deleted += 1;
    }
    Ok(deleted)
}

fn sanitize_attachment_file_name(name: &str) -> String {
    let sanitized = name
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_control()
                || ch.is_whitespace()
                || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .trim_matches('_')
        .to_string();

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "attachment".into()
    } else {
        sanitized
    }
}

fn unique_attachment_target(dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("attachment");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 0..10_000 {
        let candidate_name = if index == 0 {
            file_name.to_string()
        } else if let Some(extension) = extension {
            format!("{stem}-{index}.{extension}")
        } else {
            format!("{stem}-{index}")
        };
        let candidate = dir.join(candidate_name);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(err) => return Err(format!("metadata_failed: {err}")),
        }
    }

    Err("attachment_name_exhausted".into())
}

fn ensure_copy_source_safe(root: &Path, source: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(source).map_err(|err| format!("metadata_failed: {err}"))?;
    if is_symlink_or_reparse(&metadata) {
        return Err("path_is_symlink".into());
    }
    let canonical = source
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    if !canonical.starts_with(root) {
        return Err("path_escapes_root".into());
    }
    Ok(metadata)
}

fn copy_path(root: &Path, source: &Path, target: &Path) -> Result<(), String> {
    let metadata = ensure_copy_source_safe(root, source)?;
    if metadata.is_dir() {
        copy_dir_recursive(root, source, target)
    } else {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|err| format!("copy_file_failed: {err}"))
    }
}

fn copy_dir_recursive(root: &Path, source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target).map_err(|err| format!("copy_dir_create_failed: {err}"))?;
    for item in fs::read_dir(source).map_err(|err| format!("copy_dir_read_failed: {err}"))? {
        let entry = item.map_err(|err| format!("copy_dir_entry_failed: {err}"))?;
        let child_source = entry.path();
        let child_target = target.join(entry.file_name());
        copy_path(root, &child_source, &child_target)?;
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

fn is_video_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some(
            "3g2"
                | "3gp"
                | "avi"
                | "flv"
                | "m2ts"
                | "m4v"
                | "mkv"
                | "mov"
                | "mp4"
                | "mpeg"
                | "mpg"
                | "mts"
                | "ogv"
                | "ts"
                | "webm"
                | "wmv"
        )
    )
}

fn validate_image_dimensions(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        return Ok(());
    }
    let (width, height) =
        image::image_dimensions(path).map_err(|_| "unsupported_image".to_string())?;
    validate_image_pixel_count(width, height)
}

fn validate_image_pixel_count(width: u32, height: u32) -> Result<(), String> {
    if u64::from(width) * u64::from(height) > IMAGE_MAX_PIXELS {
        return Err("image_dimensions_too_large".into());
    }
    Ok(())
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
                is_symlink: file_type.is_symlink(),
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
        let Ok(decoded) = decode_text(&bytes) else {
            continue;
        };
        collect_content_matches_in_file(root, &path, &name, &decoded.content, needle, out)?;
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
    fn preview_limits_reject_video_and_oversized_image_dimensions() {
        assert!(validate_image_pixel_count(4_000, 3_000).is_ok());
        assert_eq!(
            validate_image_pixel_count(4_000, 3_001).unwrap_err(),
            "image_dimensions_too_large"
        );

        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("clip.mp4"), b"not-a-video").unwrap();
        assert_eq!(
            read_text_file_bytes(&root.to_string_lossy(), "clip.mp4").unwrap_err(),
            "video_preview_unsupported"
        );
    }

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
    fn parse_wsl_find_dir_entries_returns_sorted_relative_entries() {
        let output = [
            b"z.txt\0".as_slice(),
            b"f\0",
            b"f\0",
            b"12\0",
            b"1720000000.125\0",
            b"linked\0",
            b"l\0",
            b"d\0",
            b"30\0",
            b"1720000002.5\0",
            b"src\0",
            b"d\0",
            b"d\0",
            b"4096\0",
            b"1720000001.5\0",
        ]
        .concat();

        let entries = parse_wsl_find_dir_entries(&output, "parent").unwrap();

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "linked");
        assert_eq!(entries[0].path, "parent/linked");
        assert_eq!(entries[0].kind, "directory");
        assert!(entries[0].is_symlink);
        assert_eq!(entries[0].size_bytes, 30);
        assert_eq!(entries[1].name, "src");
        assert_eq!(entries[1].path, "parent/src");
        assert_eq!(entries[1].kind, "directory");
        assert!(!entries[1].is_symlink);
        assert_eq!(entries[1].size_bytes, 4096);
        assert_eq!(entries[1].modified_ms, Some(1_720_000_001_500));
        assert_eq!(entries[2].name, "z.txt");
        assert_eq!(entries[2].path, "parent/z.txt");
        assert_eq!(entries[2].kind, "file");
        assert!(!entries[2].is_symlink);
    }

    #[test]
    fn join_linux_path_preserves_root_and_nested_paths() {
        assert_eq!(join_linux_path("/home/me/project", ""), "/home/me/project");
        assert_eq!(
            join_linux_path("/home/me/project/", "src/main.ts"),
            "/home/me/project/src/main.ts"
        );
    }

    #[test]
    fn wsl_find_dir_args_follows_command_line_symlink_roots() {
        let args = wsl_find_dir_args("/data/acGo");
        assert_eq!(args[0], "find");
        assert_eq!(args[1], "-H");
        assert_eq!(args[2], "/data/acGo");
    }

    #[test]
    fn path_exists_checks_native_paths() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("exists.txt");
        fs::write(&file, "ok").unwrap();

        assert!(path_exists(&file.to_string_lossy()));
        assert!(!path_exists(
            &tmp.path().join("missing.txt").to_string_lossy()
        ));
    }

    #[test]
    fn path_kind_distinguishes_native_files_and_directories() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("exists.txt");
        let directory = tmp.path().join("directory");
        fs::write(&file, "ok").unwrap();
        fs::create_dir(&directory).unwrap();

        assert_eq!(path_kind(&file.to_string_lossy()), "file");
        assert_eq!(path_kind(&directory.to_string_lossy()), "directory");
        assert_eq!(
            path_kind(&tmp.path().join("missing").to_string_lossy()),
            "missing"
        );
    }

    #[test]
    fn path_exists_rejects_invalid_wsl_unc_without_launching_wsl() {
        assert!(!path_exists(r"\\wsl.localhost\Ubuntu"));
    }

    #[test]
    fn wsl_path_exists_args_accepts_symlink_nodes() {
        let args = wsl_path_exists_args("Ubuntu-22.04", "/data/acGo");
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu-22.04",
                "--exec",
                "sh",
                "-c",
                "test -e \"$1\" || test -L \"$1\"",
                "cli-manager-path-check",
                "/data/acGo",
            ]
        );
    }

    #[test]
    fn wsl_path_kind_args_pass_path_as_positional_argument() {
        assert_eq!(
            wsl_path_kind_args("Ubuntu-22.04", "/data/project name"),
            vec![
                "-d",
                "Ubuntu-22.04",
                "--exec",
                "sh",
                "-c",
                "if test -d \"$1\"; then printf directory; elif test -f \"$1\"; then printf file; else printf missing; fi",
                "cli-manager-path-kind",
                "/data/project name",
            ]
        );
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
        copy_path(&root, &source, &target).unwrap();
        assert_eq!(fs::read_to_string(root.join("two.txt")).unwrap(), "one");

        let moved = resolve_named_target(&root, "", "three.txt").unwrap();
        move_path(&root, &target, &moved, false).unwrap();
        assert!(!root.join("two.txt").exists());
        assert_eq!(fs::read_to_string(root.join("three.txt")).unwrap(), "one");
    }

    #[test]
    fn file_write_rejects_symlink_targets() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("real.txt"), "real").unwrap();
        let root = root.canonicalize().unwrap();
        let link = root.join("link.txt");

        #[cfg(unix)]
        if std::os::unix::fs::symlink(root.join("real.txt"), &link).is_err() {
            return;
        }
        #[cfg(target_os = "windows")]
        if std::os::windows::fs::symlink_file(root.join("real.txt"), &link).is_err() {
            return;
        }

        assert_eq!(
            ensure_target_safe_for_write(&root, &link).unwrap_err(),
            "path_is_symlink"
        );
    }

    #[test]
    fn copy_rejects_nested_symlink_sources() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("real.txt"), "real").unwrap();
        let root = root.canonicalize().unwrap();
        let link = root.join("src").join("link.txt");

        #[cfg(unix)]
        if std::os::unix::fs::symlink(root.join("real.txt"), &link).is_err() {
            return;
        }
        #[cfg(target_os = "windows")]
        if std::os::windows::fs::symlink_file(root.join("real.txt"), &link).is_err() {
            return;
        }

        let err = copy_path(&root, &root.join("src"), &root.join("dst")).unwrap_err();
        assert_eq!(err, "path_is_symlink");
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

    #[test]
    fn content_search_decodes_gbk_project_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("第一行\n中文目标内容\n第三行\n");
        assert!(!had_errors);
        fs::write(root.join("legacy.cs"), bytes.as_ref()).unwrap();
        let root = root.canonicalize().unwrap();

        let mut matches = Vec::new();
        collect_content_matches(&root, &root, "目标", &mut matches).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "legacy.cs");
        assert_eq!(matches[0].line_number, 2);
        assert_eq!(matches[0].line_text, "中文目标内容");
    }

    #[tokio::test]
    async fn project_text_commands_preserve_gbk_and_reject_unmappable_content() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("legacy.cs");
        let original = "你好，世界。\n";
        let (original_bytes, _, had_errors) = encoding_rs::GBK.encode(original);
        assert!(!had_errors);
        fs::write(&file, original_bytes.as_ref()).unwrap();

        let root_path = root.to_string_lossy().to_string();
        assert_eq!(
            file_read_text(root_path.clone(), "legacy.cs".to_string())
                .await
                .unwrap_err(),
            "not_utf8"
        );
        let payload = file_read_project_text(root_path.clone(), "legacy.cs".to_string())
            .await
            .unwrap();
        assert_eq!(payload.content, original);
        assert_eq!(payload.encoding, "gbk");
        assert!(!payload.has_bom);

        let updated = "你好，新的世界。\n";
        file_write_project_text(
            root_path.clone(),
            "legacy.cs".to_string(),
            updated.to_string(),
            payload.encoding.clone(),
            payload.has_bom,
        )
        .await
        .unwrap();
        let (expected_bytes, _, expected_errors) = encoding_rs::GBK.encode(updated);
        assert!(!expected_errors);
        assert_eq!(fs::read(&file).unwrap(), expected_bytes.as_ref());

        let before_failed_save = fs::read(&file).unwrap();
        let error = file_write_project_text(
            root_path,
            "legacy.cs".to_string(),
            "你好🙂".to_string(),
            payload.encoding,
            payload.has_bom,
        )
        .await
        .unwrap_err();
        assert_eq!(error, "text_encoding_unmappable");
        assert_eq!(fs::read(&file).unwrap(), before_failed_save);
    }
}
