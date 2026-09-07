use super::{
    redact_log_line, CONFIG_FILE_NAME, CONTROL_WORK_DIR_NAME, LOG_FILE_NAME,
    MAX_WEIXIN_AUTH_QR_BYTES, PROFILE_FILE_NAME, WEIXIN_AUTH_CONFIG_FILE_NAME,
    WEIXIN_AUTH_DIR_NAME, WEIXIN_AUTH_QR_FILE_NAME, WEIXIN_AUTH_STDERR_FILE_NAME,
    WEIXIN_AUTH_STDOUT_FILE_NAME,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::fs::{self};
use std::path::{Path, PathBuf};

pub(super) fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub(super) fn remote_manager_dir() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?.join("remote-manager"))
}
pub(super) fn profile_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(PROFILE_FILE_NAME))
}
pub(super) fn config_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(CONFIG_FILE_NAME))
}
pub(super) fn data_dir() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join("data"))
}
pub(super) fn control_work_dir() -> Result<PathBuf, String> {
    let path = remote_manager_dir()?.join(CONTROL_WORK_DIR_NAME);
    fs::create_dir_all(&path)
        .map_err(|err| format!("create cc-connect control work directory failed: {err}"))?;
    path.canonicalize()
        .map_err(|err| format!("canonicalize cc-connect control work directory failed: {err}"))
}
pub(super) fn sanitize_weixin_path_segment(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "default".to_string();
    }
    value
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':' | '\0') {
                '_'
            } else {
                character
            }
        })
        .collect()
}
pub(super) fn weixin_account_dir_at(
    data_root: &Path,
    project_name: &str,
    project_id: &str,
) -> PathBuf {
    data_root
        .join("weixin")
        .join(sanitize_weixin_path_segment(project_name))
        .join(sanitize_weixin_path_segment(project_id))
}
pub(super) fn weixin_account_dir(project_name: &str, project_id: &str) -> Result<PathBuf, String> {
    Ok(weixin_account_dir_at(
        &data_dir()?,
        project_name,
        project_id,
    ))
}
pub(super) fn log_path() -> Result<PathBuf, String> {
    Ok(crate::app_paths::logs_dir()?.join(LOG_FILE_NAME))
}

pub(super) fn weixin_authorization_dir() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(WEIXIN_AUTH_DIR_NAME))
}

pub(super) fn weixin_authorization_paths() -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let dir = weixin_authorization_dir()?;
    Ok((
        dir.join(WEIXIN_AUTH_CONFIG_FILE_NAME),
        dir.join(WEIXIN_AUTH_QR_FILE_NAME),
        dir.join(WEIXIN_AUTH_STDOUT_FILE_NAME),
        dir.join(WEIXIN_AUTH_STDERR_FILE_NAME),
    ))
}

pub(super) fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("remove {} failed: {err}", path.display())),
    }
}

pub(super) fn cleanup_weixin_authorization_files(paths: [&Path; 4]) {
    for path in paths {
        let _ = remove_file_if_exists(path);
    }
}

pub(super) fn weixin_authorization_qr_data_url(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("inspect Weixin authorization QR failed: {err}")),
    };
    if metadata.len() == 0 || metadata.len() > MAX_WEIXIN_AUTH_QR_BYTES {
        return Ok(None);
    }
    let bytes =
        fs::read(path).map_err(|err| format!("read Weixin authorization QR failed: {err}"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(None);
    }
    Ok(Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(bytes)
    )))
}

pub(super) fn weixin_authorization_error_detail(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let lines = raw
        .lines()
        .rev()
        .filter_map(|line| {
            let line = redact_log_line(line.trim(), &[]);
            (!line.is_empty()).then_some(line)
        })
        .take(4)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        None
    } else {
        Some(lines.into_iter().rev().collect::<Vec<_>>().join(" | "))
    }
}

pub(super) fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}
