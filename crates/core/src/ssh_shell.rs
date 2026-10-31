/// 远端 POSIX HOME 路径校验失败原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshRemoteHomePathError {
    Invalid,
    ParentTraversal,
}

/// 仅接受绝对 POSIX 或 ~/ 简写，拒绝父目录段及 shell 控制字符。
pub fn validate_remote_home_path(path: &str) -> Result<(), SshRemoteHomePathError> {
    if path.contains(['\0', '\r', '\n', '\\', '$', '`'])
        || !(path.starts_with('/') || path == "~" || path.starts_with("~/"))
    {
        return Err(SshRemoteHomePathError::Invalid);
    }
    if path.split('/').any(|part| part == "..") {
        return Err(SshRemoteHomePathError::ParentTraversal);
    }
    Ok(())
}

/// 将经过校验的路径转为受保护的远端 shell 表达式。
pub fn format_remote_home_path(path: &str) -> String {
    if path == "~" {
        return "\"${HOME}\"".to_string();
    }
    if let Some(suffix) = path.strip_prefix("~/") {
        return format!("\"${{HOME}}\"/{}", posix_quote(suffix));
    }
    posix_quote(path)
}

/// 用 POSIX 单引号包装字符串并转义其中的单引号。
pub fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
