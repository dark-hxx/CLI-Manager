use super::{
    redact_log_line, CONFIG_FILE_NAME, CONTROL_WORK_DIR_NAME, LOG_FILE_NAME,
    MAX_WEIXIN_AUTH_QR_BYTES, PROFILE_FILE_NAME, WEIXIN_AUTH_CONFIG_FILE_NAME,
    WEIXIN_AUTH_DIR_NAME, WEIXIN_AUTH_QR_FILE_NAME, WEIXIN_AUTH_STDERR_FILE_NAME,
    WEIXIN_AUTH_STDOUT_FILE_NAME,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::fs::{self};
use std::path::{Path, PathBuf};

// 返回当前 UTC Unix 毫秒时间戳。
pub(super) fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
// 返回应用数据目录下的远程管理根路径。
pub(super) fn remote_manager_dir() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?.join("remote-manager"))
}
// 返回远程管理连接配置 JSON 路径。
pub(super) fn profile_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(PROFILE_FILE_NAME))
}
// 返回生成的 cc-connect TOML 配置路径。
pub(super) fn config_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(CONFIG_FILE_NAME))
}
// 返回 cc-connect 状态数据根目录路径。
pub(super) fn data_dir() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join("data"))
}
// 创建并规范化项目无关的远程控制工作目录。
pub(super) fn control_work_dir() -> Result<PathBuf, String> {
    let path = remote_manager_dir()?.join(CONTROL_WORK_DIR_NAME);
    fs::create_dir_all(&path)
        .map_err(|err| format!("create cc-connect control work directory failed: {err}"))?;
    path.canonicalize()
        .map_err(|err| format!("canonicalize cc-connect control work directory failed: {err}"))
}
// 将微信目录片段中的路径分隔符、冒号和 NUL 替换为下划线。
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
// 按清理后的项目名称及标识构造微信账户数据目录。
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
// 在当前托管数据根目录下定位微信账户目录。
pub(super) fn weixin_account_dir(project_name: &str, project_id: &str) -> Result<PathBuf, String> {
    Ok(weixin_account_dir_at(
        &data_dir()?,
        project_name,
        project_id,
    ))
}
// 返回日志目录中的 cc-connect 日志路径。
pub(super) fn log_path() -> Result<PathBuf, String> {
    Ok(crate::app_paths::logs_dir()?.join(LOG_FILE_NAME))
}

// 返回微信授权临时文件目录。
pub(super) fn weixin_authorization_dir() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(WEIXIN_AUTH_DIR_NAME))
}

// 组合微信授权配置、二维码及两个输出日志路径。
pub(super) fn weixin_authorization_paths() -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let dir = weixin_authorization_dir()?;
    Ok((
        dir.join(WEIXIN_AUTH_CONFIG_FILE_NAME),
        dir.join(WEIXIN_AUTH_QR_FILE_NAME),
        dir.join(WEIXIN_AUTH_STDOUT_FILE_NAME),
        dir.join(WEIXIN_AUTH_STDERR_FILE_NAME),
    ))
}

// 删除单个文件，将不存在视为成功。
pub(super) fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("remove {} failed: {err}", path.display())),
    }
}

// 尽力删除四个授权临时文件，忽略各项删除错误。
pub(super) fn cleanup_weixin_authorization_files(paths: [&Path; 4]) {
    for path in paths {
        let _ = remove_file_if_exists(path);
    }
}

// 检查二维码文件元数据和 PNG 签名后编码为 data URL。
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

// 读取授权日志，返回末尾四条非空脱敏信息。
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

// 将平台路径有损转换为显示字符串。
pub(super) fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}
