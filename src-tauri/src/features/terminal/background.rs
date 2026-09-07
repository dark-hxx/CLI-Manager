use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// 5 MiB — 超过此大小返回 warning，但不阻断保存。
const SIZE_WARN_THRESHOLD: u64 = 5 * 1024 * 1024;
const SIZE_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// 允许的扩展名（小写）。**不支持 webp**。
const ALLOWED_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBackground {
    pub relative_path: String,
    pub size_bytes: u64,
    pub warning: Option<String>,
}

// -----------------------------------------------------------------------------
// 纯函数辅助（便于单元测试，不依赖 AppHandle）
// -----------------------------------------------------------------------------

/// 校验文件扩展名（大小写不敏感），返回归一化的小写扩展名。
pub(crate) fn validate_extension(file_name: &str) -> Result<String, &'static str> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .ok_or("missing_extension")?
        .to_ascii_lowercase();
    if ALLOWED_EXTS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err("unsupported_format")
    }
}

/// 根据字节计算 SHA-256，取前 16 hex 字符作为文件名 stem，拼上扩展名。
pub(crate) fn compute_filename(bytes: &[u8], ext: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let stem: String = digest
        .iter()
        .take(8) // 16 hex chars = 8 bytes
        .map(|b| format!("{:02x}", b))
        .collect();
    format!("{}.{}", stem, ext)
}

/// 文件大小超过阈值时返回 warning 标记。
pub(crate) fn check_size_warning(bytes: u64) -> Option<&'static str> {
    if bytes > SIZE_WARN_THRESHOLD {
        Some("file_too_large")
    } else {
        None
    }
}

/// 校验前端传入的相对路径，必须满足：
/// - 不含 `..`（防止目录穿越）
/// - 不含反斜杠（Windows 风格分隔符）
/// - 不以 `/` 开头（避免被当作绝对路径）
/// - 必须以 `backgrounds/` 开头（锁定到背景目录）
pub(crate) fn validate_relative_path(p: &str) -> Result<(), &'static str> {
    if p.is_empty() {
        return Err("empty_path");
    }
    if p.contains("..") {
        return Err("path_contains_parent_segment");
    }
    if p.contains('\\') {
        return Err("path_contains_backslash");
    }
    if p.starts_with('/') {
        return Err("path_is_absolute");
    }
    if !p.starts_with("backgrounds/") {
        return Err("path_outside_backgrounds_dir");
    }
    Ok(())
}

/// 解析 backgrounds 目录的绝对路径，并确保目录存在。
fn resolve_backgrounds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let dir = base.join("backgrounds");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    }
    Ok(dir)
}

// -----------------------------------------------------------------------------
// Tauri 命令
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn save_background_image(
    app: AppHandle,
    source_path: String,
) -> Result<SavedBackground, String> {
    // 1. Source 必须是绝对路径 + 真实存在的文件
    let src = PathBuf::from(&source_path);
    if !src.is_absolute() {
        return Err("source_path_not_absolute".into());
    }

    // 2. 扩展名白名单
    let file_name = src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid_source_filename".to_string())?
        .to_string();
    let ext = validate_extension(&file_name).map_err(|e| e.to_string())?;

    let src_metadata =
        std::fs::metadata(&src).map_err(|e| format!("source_metadata_failed: {e}"))?;
    if !src_metadata.is_file() {
        return Err("source_not_file".into());
    }
    if src_metadata.len() > SIZE_MAX_BYTES {
        return Err("file_too_large".into());
    }

    // 3. 读取源文件字节（阻塞 IO 放到 spawn_blocking）
    let src_for_read = src.clone();
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&src_for_read))
        .await
        .map_err(|e| format!("join_error: {e}"))?
        .map_err(|e| format!("read_source_failed: {e}"))?;

    let size_bytes = bytes.len() as u64;
    if size_bytes > SIZE_MAX_BYTES {
        return Err("file_too_large".into());
    }
    let warning = check_size_warning(size_bytes).map(String::from);

    // 4. 计算 hash 文件名
    let file_name = compute_filename(&bytes, &ext);

    // 5. 解析目标目录并写入
    let dir = resolve_backgrounds_dir(&app)?;
    let dest = dir.join(&file_name);

    // 防御：dest 不能逃出 backgrounds 目录
    let canon_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let canon_dest_parent = dest
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .unwrap_or_else(|| dir.clone());
    if !canon_dest_parent.starts_with(&canon_dir) {
        return Err("path_escapes_backgrounds_dir".into());
    }

    if !dest.exists() {
        let dest_for_write = dest.clone();
        tokio::task::spawn_blocking(move || std::fs::write(&dest_for_write, &bytes))
            .await
            .map_err(|e| format!("join_error: {e}"))?
            .map_err(|e| format!("write_dest_failed: {e}"))?;
    }

    Ok(SavedBackground {
        relative_path: format!("backgrounds/{}", file_name),
        size_bytes,
        warning,
    })
}

#[tauri::command]
pub async fn background_image_exists(
    app: AppHandle,
    relative_path: String,
) -> Result<bool, String> {
    validate_relative_path(&relative_path).map_err(|e| e.to_string())?;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    Ok(base.join(&relative_path).exists())
}

#[tauri::command]
pub async fn cleanup_unused_backgrounds(
    app: AppHandle,
    keep_relative_paths: Vec<String>,
) -> Result<u32, String> {
    let dir = resolve_backgrounds_dir(&app)?;

    // 归一化白名单：只看 file_name 部分（兼容 "backgrounds/abc.jpg" 与裸文件名）。
    let keep_names: std::collections::HashSet<String> = keep_relative_paths
        .into_iter()
        .filter_map(|p| {
            Path::new(&p)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .collect();

    tokio::task::spawn_blocking(move || cleanup_dir(&dir, &keep_names))
        .await
        .map_err(|e| format!("join_error: {e}"))?
}

fn cleanup_dir(dir: &Path, keep_names: &std::collections::HashSet<String>) -> Result<u32, String> {
    let mut deleted: u32 = 0;
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("read_dir_entry: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if keep_names.contains(&name) {
            continue;
        }
        if let Err(e) = std::fs::remove_file(&path) {
            return Err(format!("remove_file({}): {e}", name));
        }
        deleted += 1;
    }
    Ok(deleted)
}

// -----------------------------------------------------------------------------
// 单元测试
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use tempfile::TempDir;

    // ---------- validate_extension ----------

    #[test]
    fn accepts_jpg_jpeg_png_gif_case_insensitive() {
        assert_eq!(validate_extension("a.jpg").unwrap(), "jpg");
        assert_eq!(validate_extension("a.JPG").unwrap(), "jpg");
        assert_eq!(validate_extension("a.jpeg").unwrap(), "jpeg");
        assert_eq!(validate_extension("a.JPEG").unwrap(), "jpeg");
        assert_eq!(validate_extension("a.png").unwrap(), "png");
        assert_eq!(validate_extension("a.PNG").unwrap(), "png");
        assert_eq!(validate_extension("a.gif").unwrap(), "gif");
        assert_eq!(validate_extension("a.GIF").unwrap(), "gif");
    }

    #[test]
    fn rejects_webp_bmp_exe_and_missing_ext() {
        assert_eq!(
            validate_extension("a.webp").unwrap_err(),
            "unsupported_format"
        );
        assert_eq!(
            validate_extension("a.WEBP").unwrap_err(),
            "unsupported_format"
        );
        assert_eq!(
            validate_extension("a.bmp").unwrap_err(),
            "unsupported_format"
        );
        assert_eq!(
            validate_extension("a.exe").unwrap_err(),
            "unsupported_format"
        );
        assert_eq!(
            validate_extension("noext").unwrap_err(),
            "missing_extension"
        );
    }

    // ---------- compute_filename ----------

    #[test]
    fn compute_filename_is_deterministic() {
        let bytes = b"hello world";
        let n1 = compute_filename(bytes, "jpg");
        let n2 = compute_filename(bytes, "jpg");
        assert_eq!(n1, n2);
    }

    #[test]
    fn compute_filename_differs_on_different_bytes() {
        let n1 = compute_filename(b"hello world", "jpg");
        let n2 = compute_filename(b"hello world!", "jpg");
        assert_ne!(n1, n2);
    }

    #[test]
    fn compute_filename_stem_is_16_hex_chars() {
        let name = compute_filename(b"x", "png");
        let stem = name.trim_end_matches(".png");
        assert_eq!(stem.len(), 16);
        assert!(stem.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn compute_filename_appends_ext_lowercase() {
        let name = compute_filename(b"x", "gif");
        assert!(name.ends_with(".gif"));
    }

    // ---------- check_size_warning ----------

    #[test]
    fn size_warning_below_threshold_is_none() {
        assert_eq!(check_size_warning(0), None);
        assert_eq!(check_size_warning(SIZE_WARN_THRESHOLD - 1), None);
        assert_eq!(check_size_warning(SIZE_WARN_THRESHOLD), None); // exact 5 MiB ok
    }

    #[test]
    fn size_warning_above_threshold_is_some() {
        assert_eq!(
            check_size_warning(SIZE_WARN_THRESHOLD + 1),
            Some("file_too_large")
        );
        assert_eq!(check_size_warning(8 * 1024 * 1024), Some("file_too_large"));
    }

    // ---------- cleanup_dir ----------

    fn touch(p: &Path) {
        fs::write(p, b"x").unwrap();
    }

    #[test]
    fn cleanup_keeps_files_in_keep_list() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        touch(&dir.join("aaaaaaaaaaaaaaaa.jpg"));
        touch(&dir.join("bbbbbbbbbbbbbbbb.png"));
        touch(&dir.join("cccccccccccccccc.gif"));

        let mut keep = HashSet::new();
        keep.insert("aaaaaaaaaaaaaaaa.jpg".to_string());
        keep.insert("bbbbbbbbbbbbbbbb.png".to_string());

        let deleted = cleanup_dir(dir, &keep).unwrap();
        assert_eq!(deleted, 1);
        assert!(dir.join("aaaaaaaaaaaaaaaa.jpg").exists());
        assert!(dir.join("bbbbbbbbbbbbbbbb.png").exists());
        assert!(!dir.join("cccccccccccccccc.gif").exists());
    }

    #[test]
    fn cleanup_deletes_all_when_keep_empty() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        touch(&dir.join("x.jpg"));
        touch(&dir.join("y.png"));

        let keep = HashSet::new();
        let deleted = cleanup_dir(dir, &keep).unwrap();
        assert_eq!(deleted, 2);
        assert!(!dir.join("x.jpg").exists());
        assert!(!dir.join("y.png").exists());
    }

    #[test]
    fn cleanup_missing_dir_returns_zero() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("does_not_exist");
        let keep = HashSet::new();
        let deleted = cleanup_dir(&missing, &keep).unwrap();
        assert_eq!(deleted, 0);
    }

    #[test]
    fn cleanup_ignores_subdirectories() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        fs::create_dir(dir.join("sub")).unwrap();
        touch(&dir.join("a.jpg"));

        let keep = HashSet::new();
        let deleted = cleanup_dir(dir, &keep).unwrap();
        assert_eq!(deleted, 1);
        assert!(dir.join("sub").exists());
        assert!(!dir.join("a.jpg").exists());
    }

    // ---------- validate_relative_path ----------

    #[test]
    fn validate_accepts_normal_backgrounds_path() {
        assert!(validate_relative_path("backgrounds/abc.jpg").is_ok());
        assert!(validate_relative_path("backgrounds/1234567890abcdef.png").is_ok());
        assert!(validate_relative_path("backgrounds/x.gif").is_ok());
    }

    #[test]
    fn validate_rejects_empty() {
        assert_eq!(validate_relative_path("").unwrap_err(), "empty_path");
    }

    #[test]
    fn validate_rejects_parent_traversal() {
        assert_eq!(
            validate_relative_path("backgrounds/../secret.txt").unwrap_err(),
            "path_contains_parent_segment"
        );
        assert_eq!(
            validate_relative_path("../etc/passwd").unwrap_err(),
            "path_contains_parent_segment"
        );
    }

    #[test]
    fn validate_rejects_backslash() {
        assert_eq!(
            validate_relative_path("backgrounds\\abc.jpg").unwrap_err(),
            "path_contains_backslash"
        );
    }

    #[test]
    fn validate_rejects_leading_slash() {
        assert_eq!(
            validate_relative_path("/etc/passwd").unwrap_err(),
            "path_is_absolute"
        );
    }

    #[test]
    fn validate_rejects_outside_backgrounds_dir() {
        assert_eq!(
            validate_relative_path("other/abc.jpg").unwrap_err(),
            "path_outside_backgrounds_dir"
        );
        assert_eq!(
            validate_relative_path("settings.json").unwrap_err(),
            "path_outside_backgrounds_dir"
        );
    }
}
