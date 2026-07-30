use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::layout::resolve_layout;

const MAX_ENTRIES: usize = 500;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_TEXT_READ_BYTES: u64 = 1024 * 1024;
const MAX_IMAGE_READ_BYTES: u64 = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 12_000_000;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
const MAX_WALK_FILES: usize = 20_000;
const MAX_ATTACHMENT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ATTACHMENT_CHUNK_BYTES: usize = 512 * 1024;
const MAX_ATTACHMENT_CHUNK_BASE64_BYTES: usize = MAX_ATTACHMENT_CHUNK_BYTES.div_ceil(3) * 4;
const MAX_ACTIVE_ATTACHMENT_UPLOADS: usize = 16;
const ATTACHMENT_RETENTION: Duration = Duration::from_secs(48 * 60 * 60);
const ATTACHMENT_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListRequest {
    pub root_path: String,
    #[serde(default)]
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadRequest {
    pub root_path: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchRequest {
    pub root_path: String,
    pub query: String,
    #[serde(default)]
    pub content: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachBeginRequest {
    pub session_id: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachChunkRequest {
    pub upload_id: String,
    pub offset: u64,
    pub data_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachFinishRequest {
    pub upload_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachAbortRequest {
    pub upload_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachBeginResult {
    pub upload_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachResult {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub modified_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileRead {
    pub relative_path: String,
    pub kind: String,
    pub content: String,
    pub size_bytes: u64,
    pub modified_ms: Option<i64>,
    pub truncated: bool,
}

struct PendingFileAttachment {
    cache_root: PathBuf,
    parent_dir: PathBuf,
    temporary_path: PathBuf,
    target_path: PathBuf,
    file: File,
    expected_size: u64,
    written: u64,
    expected_sha256: String,
    hasher: Sha256,
}

#[derive(Default)]
pub struct FileAttachmentUploads {
    active: HashMap<String, PendingFileAttachment>,
}

impl FileAttachmentUploads {
    pub fn begin(
        &mut self,
        request: FileAttachBeginRequest,
    ) -> Result<FileAttachBeginResult, String> {
        let root = attachment_cache_root()?;
        self.begin_in_root(request, root)
    }

    fn begin_in_root(
        &mut self,
        request: FileAttachBeginRequest,
        root: PathBuf,
    ) -> Result<FileAttachBeginResult, String> {
        if self.active.len() >= MAX_ACTIVE_ATTACHMENT_UPLOADS {
            return Err("attachment_upload_limit_reached".to_string());
        }
        validate_attachment_session_id(&request.session_id)?;
        if request.size_bytes == 0 {
            return Err("attachment_empty".to_string());
        }
        if request.size_bytes > MAX_ATTACHMENT_BYTES {
            return Err("attachment_too_large".to_string());
        }
        let extension = attachment_extension(&request.file_name)?;
        let expected_sha256 = normalize_sha256(&request.sha256)?;
        let cache_root = ensure_private_dir(&root)?;
        cleanup_expired_attachments(&cache_root, ATTACHMENT_RETENTION)?;
        let parent_dir = ensure_private_child_dir(&cache_root, &request.session_id)?;

        for _ in 0..4 {
            let upload_id = uuid::Uuid::new_v4().to_string();
            let target_path = parent_dir.join(format!("{upload_id}.{extension}"));
            let temporary_path = parent_dir.join(format!(".{upload_id}.upload.{extension}"));
            let file = match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary_path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("attachment_create_failed".to_string()),
            };
            if let Err(error) = set_private_file_permissions(&temporary_path) {
                drop(file);
                let _ = fs::remove_file(&temporary_path);
                return Err(error);
            }
            self.active.insert(
                upload_id.clone(),
                PendingFileAttachment {
                    cache_root: cache_root.clone(),
                    parent_dir: parent_dir.clone(),
                    temporary_path,
                    target_path,
                    file,
                    expected_size: request.size_bytes,
                    written: 0,
                    expected_sha256,
                    hasher: Sha256::new(),
                },
            );
            return Ok(FileAttachBeginResult { upload_id });
        }
        Err("attachment_create_failed".to_string())
    }

    pub fn append(&mut self, request: FileAttachChunkRequest) -> Result<u64, String> {
        if request.data_base64.is_empty()
            || request.data_base64.len() > MAX_ATTACHMENT_CHUNK_BASE64_BYTES
        {
            return Err("attachment_chunk_invalid".to_string());
        }
        let data = general_purpose::STANDARD
            .decode(request.data_base64)
            .map_err(|_| "attachment_chunk_invalid".to_string())?;
        if data.is_empty() || data.len() > MAX_ATTACHMENT_CHUNK_BYTES {
            return Err("attachment_chunk_invalid".to_string());
        }
        let pending = self
            .active
            .get_mut(&request.upload_id)
            .ok_or_else(|| "attachment_upload_not_found".to_string())?;
        if request.offset != pending.written {
            return Err("attachment_chunk_offset_invalid".to_string());
        }
        let next_size = pending
            .written
            .checked_add(data.len() as u64)
            .filter(|size| *size <= pending.expected_size)
            .ok_or_else(|| "attachment_size_mismatch".to_string())?;
        pending
            .file
            .write_all(&data)
            .map_err(|_| "attachment_write_failed".to_string())?;
        pending.hasher.update(&data);
        pending.written = next_size;
        Ok(next_size)
    }

    pub fn finish(&mut self, request: FileAttachFinishRequest) -> Result<FileAttachResult, String> {
        let pending = self
            .active
            .remove(&request.upload_id)
            .ok_or_else(|| "attachment_upload_not_found".to_string())?;
        finish_attachment(pending)
    }

    pub fn abort(&mut self, request: FileAttachAbortRequest) -> bool {
        let Some(pending) = self.active.remove(&request.upload_id) else {
            return false;
        };
        drop(pending.file);
        let _ = fs::remove_file(pending.temporary_path);
        true
    }
}

impl Drop for FileAttachmentUploads {
    fn drop(&mut self) {
        for (_, pending) in self.active.drain() {
            drop(pending.file);
            let _ = fs::remove_file(pending.temporary_path);
        }
    }
}

fn attachment_cache_root() -> Result<PathBuf, String> {
    let layout = resolve_layout().map_err(str::to_string)?;
    let cache_base = env::var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| layout.home.join(".cache"));
    if !cache_base.is_absolute() {
        return Err("attachment_cache_root_invalid".to_string());
    }
    Ok(cache_base.join("cli-manager-ssh-agent").join("attachments"))
}

fn validate_attachment_session_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("attachment_session_invalid".to_string());
    }
    Ok(())
}

fn attachment_extension(file_name: &str) -> Result<String, String> {
    if file_name.is_empty() || file_name.len() > 255 || file_name.contains(['\0', '\r', '\n']) {
        return Err("attachment_name_invalid".to_string());
    }
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| ATTACHMENT_EXTENSIONS.contains(&value.as_str()))
        .ok_or_else(|| "attachment_type_unsupported".to_string())?;
    Ok(extension)
}

fn normalize_sha256(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("attachment_sha256_invalid".to_string());
    }
    Ok(value.to_ascii_lowercase())
}

fn ensure_private_dir(path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|_| "attachment_cache_create_failed".to_string())?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "attachment_cache_unavailable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("attachment_cache_invalid".to_string());
    }
    set_private_dir_permissions(path)?;
    path.canonicalize()
        .map_err(|_| "attachment_cache_unavailable".to_string())
}

fn ensure_private_child_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    validate_attachment_session_id(name)?;
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("attachment_cache_invalid".to_string())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|_| "attachment_cache_create_failed".to_string())?;
        }
        Err(_) => return Err("attachment_cache_unavailable".to_string()),
    }
    set_private_dir_permissions(&path)?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "attachment_cache_unavailable".to_string())?;
    if !canonical.starts_with(root) {
        return Err("attachment_cache_invalid".to_string());
    }
    Ok(canonical)
}

#[cfg(unix)]
fn set_private_dir_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "attachment_permissions_failed".to_string())
}

#[cfg(not(unix))]
fn set_private_dir_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "attachment_permissions_failed".to_string())
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn finish_attachment(mut pending: PendingFileAttachment) -> Result<FileAttachResult, String> {
    let temporary_path = pending.temporary_path.clone();
    let result = (|| {
        if pending.written != pending.expected_size {
            return Err("attachment_size_mismatch".to_string());
        }
        pending
            .file
            .flush()
            .and_then(|_| pending.file.sync_all())
            .map_err(|_| "attachment_write_failed".to_string())?;
        let actual_sha256 = format!("{:x}", pending.hasher.finalize());
        if actual_sha256 != pending.expected_sha256 {
            return Err("attachment_sha256_mismatch".to_string());
        }
        let (width, height) = image::image_dimensions(&temporary_path)
            .map_err(|_| "attachment_image_invalid".to_string())?;
        validate_image_pixel_count(width, height)?;

        let parent = pending
            .target_path
            .parent()
            .ok_or_else(|| "attachment_cache_invalid".to_string())?;
        let metadata =
            fs::symlink_metadata(parent).map_err(|_| "attachment_cache_unavailable".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("attachment_cache_invalid".to_string());
        }
        let canonical_parent = parent
            .canonicalize()
            .map_err(|_| "attachment_cache_unavailable".to_string())?;
        if canonical_parent != pending.parent_dir
            || !canonical_parent.starts_with(&pending.cache_root)
        {
            return Err("attachment_cache_invalid".to_string());
        }
        if fs::symlink_metadata(&pending.target_path).is_ok() {
            return Err("attachment_target_exists".to_string());
        }
        let path = pending
            .target_path
            .to_str()
            .ok_or_else(|| "attachment_path_invalid".to_string())?
            .to_string();
        drop(pending.file);
        fs::rename(&temporary_path, &pending.target_path)
            .map_err(|_| "attachment_commit_failed".to_string())?;
        Ok(FileAttachResult {
            path,
            size_bytes: pending.written,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary_path);
    }
    result
}

fn cleanup_expired_attachments(root: &Path, retention: Duration) -> Result<(), String> {
    let now = SystemTime::now();
    for session in fs::read_dir(root).map_err(|_| "attachment_cleanup_failed".to_string())? {
        let session = session.map_err(|_| "attachment_cleanup_failed".to_string())?;
        let file_type = session
            .file_type()
            .map_err(|_| "attachment_cleanup_failed".to_string())?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        for entry in
            fs::read_dir(session.path()).map_err(|_| "attachment_cleanup_failed".to_string())?
        {
            let entry = entry.map_err(|_| "attachment_cleanup_failed".to_string())?;
            let file_type = entry
                .file_type()
                .map_err(|_| "attachment_cleanup_failed".to_string())?;
            if file_type.is_symlink() || !file_type.is_file() {
                continue;
            }
            let expired = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= retention);
            if expired {
                let _ = fs::remove_file(entry.path());
            }
        }
        if fs::read_dir(session.path())
            .ok()
            .is_some_and(|mut entries| entries.next().is_none())
        {
            let _ = fs::remove_dir(session.path());
        }
    }
    Ok(())
}

pub fn list(request: FileListRequest) -> Result<Vec<RemoteFileEntry>, String> {
    let root = resolve_root(&request.root_path)?;
    let directory = resolve_relative(&root, &request.relative_path)?;
    if !directory.is_dir() {
        return Err("remote_file_not_directory".to_string());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|_| "remote_file_list_failed".to_string())? {
        let entry = entry.map_err(|_| "remote_file_list_failed".to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|_| "remote_file_list_failed".to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| "remote_file_metadata_failed".to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = relative_path(&root, &entry.path())?;
        entries.push(RemoteFileEntry {
            name,
            relative_path,
            kind: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            }
            .to_string(),
            size_bytes: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    entries.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .reverse()
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn read(request: FileReadRequest) -> Result<RemoteFileRead, String> {
    let root = resolve_root(&request.root_path)?;
    let path = resolve_relative(&root, &request.relative_path)?;
    let metadata = path
        .metadata()
        .map_err(|_| "remote_file_not_found".to_string())?;
    if !metadata.is_file() {
        return Err("remote_file_not_file".to_string());
    }
    if is_video(&path) {
        return Err("video_preview_unsupported".to_string());
    }
    let image = is_image(&path);
    let max_bytes = if image {
        MAX_IMAGE_READ_BYTES
    } else {
        MAX_TEXT_READ_BYTES
    };
    if metadata.len() > max_bytes {
        return Err(if image {
            "image_file_too_large".to_string()
        } else {
            "remote_file_too_large".to_string()
        });
    }
    if image {
        validate_image_dimensions(&path)?;
    }
    let bytes = fs::read(&path).map_err(|_| "remote_file_read_failed".to_string())?;
    let kind = if image { "image" } else { "text" };
    let content = if kind == "image" {
        format!(
            "data:{};base64,{}",
            image_mime(&path),
            base64_encode(&bytes)
        )
    } else {
        String::from_utf8(bytes).map_err(|_| "remote_file_binary".to_string())?
    };
    Ok(RemoteFileRead {
        relative_path: relative_path(&root, &path)?,
        kind: kind.to_string(),
        content,
        size_bytes: metadata.len(),
        modified_ms: modified_ms(&metadata),
        truncated: false,
    })
}

pub fn search(request: FileSearchRequest) -> Result<Vec<RemoteFileEntry>, String> {
    let query = request.query.trim().to_lowercase();
    if query.chars().count() < 2 || query.len() > 256 {
        return Ok(Vec::new());
    }
    let root = resolve_root(&request.root_path)?;
    let mut results = Vec::new();
    let mut visited = 0;
    walk_search(
        &root,
        &root,
        &query,
        request.content,
        &mut results,
        &mut visited,
        0,
    )?;
    Ok(results)
}

fn walk_search(
    root: &Path,
    directory: &Path,
    query: &str,
    content: bool,
    results: &mut Vec<RemoteFileEntry>,
    visited: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 || results.len() >= MAX_SEARCH_RESULTS || *visited >= MAX_WALK_FILES {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(|_| "remote_file_search_failed".to_string())?;
    for entry in entries {
        if results.len() >= MAX_SEARCH_RESULTS {
            break;
        }
        if *visited >= MAX_WALK_FILES {
            break;
        }
        *visited += 1;
        let entry = entry.map_err(|_| "remote_file_search_failed".to_string())?;
        let kind = entry
            .file_type()
            .map_err(|_| "remote_file_search_failed".to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| "remote_file_metadata_failed".to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let name_match = name.to_lowercase().contains(query);
        let content_match = content
            && kind.is_file()
            && metadata.len() <= MAX_SEARCH_FILE_BYTES
            && fs::read(&path)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .is_some_and(|text| text.to_lowercase().contains(query));
        if name_match || content_match {
            results.push(RemoteFileEntry {
                name,
                relative_path: relative_path(root, &path)?,
                kind: if kind.is_dir() { "directory" } else { "file" }.to_string(),
                size_bytes: metadata.len(),
                modified_ms: modified_ms(&metadata),
            });
        }
        if kind.is_dir() {
            walk_search(root, &path, query, content, results, visited, depth + 1)?;
        }
    }
    Ok(())
}

fn resolve_root(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if !Path::new(value).is_absolute()
        || value.contains(['\0', '\r', '\n'])
        || (!cfg!(windows) && value.contains('\\'))
        || value.split('/').any(|part| part == "..")
    {
        return Err("remote_file_root_invalid".to_string());
    }
    let root = Path::new(value)
        .canonicalize()
        .map_err(|_| "remote_file_root_unavailable".to_string())?;
    if !root.is_dir() {
        return Err("remote_file_root_not_directory".to_string());
    }
    Ok(root)
}

fn resolve_relative(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains(['\0', '\r', '\n', '\\'])
        || Path::new(relative).is_absolute()
        || relative.split('/').any(|part| part == "..")
    {
        return Err("remote_file_path_invalid".to_string());
    }
    let path = root.join(relative);
    let canonical = path
        .canonicalize()
        .map_err(|_| "remote_file_not_found".to_string())?;
    if !canonical.starts_with(root) {
        return Err("remote_file_path_confined".to_string());
    }
    Ok(canonical)
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "remote_file_path_confined".to_string())
}

fn modified_ms(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_millis() as i64)
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
    )
}

fn is_video(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_lowercase)
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
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        return Ok(());
    }
    let (width, height) =
        image::image_dimensions(path).map_err(|_| "remote_file_image_invalid".to_string())?;
    validate_image_pixel_count(width, height)
}

fn validate_image_pixel_count(width: u32, height: u32) -> Result<(), String> {
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err("image_dimensions_too_large".to_string());
    }
    Ok(())
}

fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "image/png",
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or_default() as u32;
        let third = chunk.get(2).copied().unwrap_or_default() as u32;
        output.push(TABLE[((first >> 2) & 0x3f) as usize] as char);
        output.push(TABLE[(((first << 4) | (second >> 4)) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second << 2) | (third >> 6)) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{
        base64_encode, cleanup_expired_attachments, list, read, search, FileAttachAbortRequest,
        FileAttachBeginRequest, FileAttachChunkRequest, FileAttachFinishRequest,
        FileAttachmentUploads, FileListRequest, FileReadRequest, FileSearchRequest,
        ATTACHMENT_RETENTION, MAX_ENTRIES, MAX_SEARCH_RESULTS, MAX_TEXT_READ_BYTES,
    };
    use base64::{engine::general_purpose, Engine as _};
    use sha2::{Digest, Sha256};
    use std::fs;

    fn test_png(root: &std::path::Path) -> Vec<u8> {
        let path = root.join("source.png");
        image::save_buffer_with_format(
            &path,
            &[0, 0, 0, 0],
            1,
            1,
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        )
        .unwrap();
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(path).unwrap();
        bytes
    }

    fn begin_request(bytes: &[u8]) -> FileAttachBeginRequest {
        FileAttachBeginRequest {
            session_id: "session-1".into(),
            file_name: "screenshot.png".into(),
            size_bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    #[test]
    fn base64_encoding_is_standard() {
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn paths_reject_traversal_and_absolute_relative_refs() {
        assert!(super::resolve_root("relative").is_err());
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        assert!(super::resolve_relative(&root, "../secret").is_err());
        assert!(super::resolve_relative(&root, "/etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_entries_are_hidden_and_cannot_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("escape.txt"),
        )
        .unwrap();
        let entries = list(FileListRequest {
            root_path: root.path().display().to_string(),
            relative_path: String::new(),
        })
        .unwrap();
        assert!(entries.is_empty());
        assert!(read(FileReadRequest {
            root_path: root.path().display().to_string(),
            relative_path: "escape.txt".into()
        })
        .is_err());
    }

    #[test]
    fn read_rejects_binary_and_oversized_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("binary.bin"), [0xff, 0xfe]).unwrap();
        fs::write(
            root.path().join("large.txt"),
            vec![b'a'; MAX_TEXT_READ_BYTES as usize + 1],
        )
        .unwrap();
        let root_path = root.path().display().to_string();
        assert_eq!(
            read(FileReadRequest {
                root_path: root_path.clone(),
                relative_path: "binary.bin".into()
            })
            .unwrap_err(),
            "remote_file_binary"
        );
        assert_eq!(
            read(FileReadRequest {
                root_path,
                relative_path: "large.txt".into()
            })
            .unwrap_err(),
            "remote_file_too_large"
        );
    }

    #[test]
    fn list_and_search_enforce_result_limits() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..(MAX_ENTRIES + 20) {
            fs::write(root.path().join(format!("match-{index:04}.txt")), "needle").unwrap();
        }
        let root_path = root.path().display().to_string();
        assert_eq!(
            list(FileListRequest {
                root_path: root_path.clone(),
                relative_path: String::new()
            })
            .unwrap()
            .len(),
            MAX_ENTRIES
        );
        assert_eq!(
            search(FileSearchRequest {
                root_path,
                query: "match".into(),
                content: false
            })
            .unwrap()
            .len(),
            MAX_SEARCH_RESULTS
        );
    }

    #[test]
    fn image_read_returns_data_url() {
        let root = tempfile::tempdir().unwrap();
        image::save_buffer_with_format(
            root.path().join("pixel.png"),
            &[0, 0, 0, 0],
            1,
            1,
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        )
        .unwrap();
        let result = read(FileReadRequest {
            root_path: root.path().display().to_string(),
            relative_path: "pixel.png".into(),
        })
        .unwrap();
        assert_eq!(result.kind, "image");
        assert!(result.content.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn read_rejects_video_before_reading_content() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("clip.mp4"), b"not-a-video").unwrap();
        assert_eq!(
            read(FileReadRequest {
                root_path: root.path().display().to_string(),
                relative_path: "clip.mp4".into(),
            })
            .unwrap_err(),
            "video_preview_unsupported"
        );
    }

    #[test]
    fn image_pixel_limit_allows_boundary_and_rejects_excess() {
        assert!(super::validate_image_pixel_count(4_000, 3_000).is_ok());
        assert_eq!(
            super::validate_image_pixel_count(4_000, 3_001).unwrap_err(),
            "image_dimensions_too_large"
        );
    }

    #[test]
    fn attachment_upload_is_chunked_verified_and_committed_under_session_cache() {
        let root = tempfile::tempdir().unwrap();
        let bytes = test_png(root.path());
        let mut uploads = FileAttachmentUploads::default();
        let upload_id = uploads
            .begin_in_root(begin_request(&bytes), root.path().join("attachments"))
            .unwrap()
            .upload_id;
        let split = bytes.len() / 2;
        assert_eq!(
            uploads
                .append(FileAttachChunkRequest {
                    upload_id: upload_id.clone(),
                    offset: 0,
                    data_base64: general_purpose::STANDARD.encode(&bytes[..split]),
                })
                .unwrap(),
            split as u64
        );
        uploads
            .append(FileAttachChunkRequest {
                upload_id: upload_id.clone(),
                offset: split as u64,
                data_base64: general_purpose::STANDARD.encode(&bytes[split..]),
            })
            .unwrap();
        let result = uploads
            .finish(FileAttachFinishRequest { upload_id })
            .unwrap();
        let path = std::path::PathBuf::from(&result.path);
        assert!(path.starts_with(
            root.path()
                .join("attachments/session-1")
                .canonicalize()
                .unwrap()
        ));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert_eq!(fs::read(path).unwrap(), bytes);
        assert_eq!(result.size_bytes, bytes.len() as u64);

        let path = std::path::PathBuf::from(result.path);
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::UNIX_EPOCH))
            .unwrap();
        cleanup_expired_attachments(&root.path().join("attachments"), ATTACHMENT_RETENTION)
            .unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn attachment_upload_rejects_bad_metadata_and_removes_failed_content() {
        let root = tempfile::tempdir().unwrap();
        let bytes = test_png(root.path());
        let mut uploads = FileAttachmentUploads::default();
        let mut unsupported = begin_request(&bytes);
        unsupported.file_name = "notes.txt".into();
        assert_eq!(
            uploads
                .begin_in_root(unsupported, root.path().join("attachments"))
                .unwrap_err(),
            "attachment_type_unsupported"
        );

        let mut mismatched = begin_request(&bytes);
        mismatched.sha256 = "0".repeat(64);
        let upload_id = uploads
            .begin_in_root(mismatched, root.path().join("attachments"))
            .unwrap()
            .upload_id;
        uploads
            .append(FileAttachChunkRequest {
                upload_id: upload_id.clone(),
                offset: 0,
                data_base64: general_purpose::STANDARD.encode(&bytes),
            })
            .unwrap();
        assert_eq!(
            uploads
                .finish(FileAttachFinishRequest { upload_id })
                .unwrap_err(),
            "attachment_sha256_mismatch"
        );
        assert!(fs::read_dir(root.path().join("attachments/session-1"))
            .unwrap()
            .next()
            .is_none());

        let invalid_image = b"not-an-image";
        let upload_id = uploads
            .begin_in_root(
                begin_request(invalid_image),
                root.path().join("attachments"),
            )
            .unwrap()
            .upload_id;
        uploads
            .append(FileAttachChunkRequest {
                upload_id: upload_id.clone(),
                offset: 0,
                data_base64: general_purpose::STANDARD.encode(invalid_image),
            })
            .unwrap();
        assert_eq!(
            uploads
                .finish(FileAttachFinishRequest { upload_id })
                .unwrap_err(),
            "attachment_image_invalid"
        );
        assert!(fs::read_dir(root.path().join("attachments/session-1"))
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn attachment_upload_enforces_offsets_and_abort_removes_partial_file() {
        let root = tempfile::tempdir().unwrap();
        let bytes = test_png(root.path());
        let mut uploads = FileAttachmentUploads::default();
        let upload_id = uploads
            .begin_in_root(begin_request(&bytes), root.path().join("attachments"))
            .unwrap()
            .upload_id;
        assert_eq!(
            uploads
                .append(FileAttachChunkRequest {
                    upload_id: upload_id.clone(),
                    offset: 1,
                    data_base64: general_purpose::STANDARD.encode(&bytes),
                })
                .unwrap_err(),
            "attachment_chunk_offset_invalid"
        );
        assert!(uploads.abort(FileAttachAbortRequest { upload_id }));
        assert!(fs::read_dir(root.path().join("attachments/session-1"))
            .unwrap()
            .next()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_upload_rejects_a_symlinked_session_cache() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let attachments = root.path().join("attachments");
        fs::create_dir(&attachments).unwrap();
        symlink(outside.path(), attachments.join("session-1")).unwrap();
        let bytes = test_png(root.path());
        let mut uploads = FileAttachmentUploads::default();
        assert_eq!(
            uploads
                .begin_in_root(begin_request(&bytes), attachments)
                .unwrap_err(),
            "attachment_cache_invalid"
        );
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}
