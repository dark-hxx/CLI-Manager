use std::path::Path;

/// 拒绝会破坏 SSH 参数边界的控制字符。
pub fn validate_single_line(value: &str) -> Result<(), String> {
    if value.contains(['\0', '\r', '\n']) {
        return Err("ssh_launch_argument_invalid".to_string());
    }
    Ok(())
}

/// 校验可选的本机 SSH 配置文件路径。
pub fn validate_config_file(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.contains(['\0', '\r', '\n']) || !Path::new(trimmed).is_absolute() {
        return Err("ssh_config_file_invalid".to_string());
    }
    if !Path::new(trimmed).is_file() {
        return Err("ssh_config_file_not_found".to_string());
    }
    Ok(())
}

/// 检测 URL authority 中带密码的 userinfo，避免凭据进入代理命令。
pub fn contains_url_credentials(value: &str) -> bool {
    value.split_whitespace().any(|token| {
        let Some((_, remainder)) = token.split_once("://") else {
            return false;
        };
        let authority = remainder.split('/').next().unwrap_or(remainder);
        authority
            .split_once('@')
            .is_some_and(|(userinfo, _)| userinfo.contains(':'))
    })
}

#[cfg(test)]
mod tests {
    use super::{contains_url_credentials, validate_single_line};

    #[test]
    fn rejects_argument_line_breaks() {
        assert!(validate_single_line("ssh\n-target").is_err());
        assert!(validate_single_line("ssh-target").is_ok());
    }

    #[test]
    fn detects_only_url_userinfo_with_a_password_separator() {
        assert!(contains_url_credentials(
            "https://user:pass@example.com/path"
        ));
        assert!(!contains_url_credentials("https://example.com/path"));
        assert!(!contains_url_credentials("user:pass@example.com"));
    }
}
