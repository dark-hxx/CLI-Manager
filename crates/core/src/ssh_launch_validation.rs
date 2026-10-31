use crate::ssh_shell::{
    format_remote_home_path, validate_remote_home_path, SshRemoteHomePathError,
};

/// 校验远端工作目录的绝对 POSIX 路径。
pub fn validate_remote_path(path: &str) -> Result<(), String> {
    let path = path.trim();
    if !path.starts_with('/') || path.contains(['\0', '\r', '\n']) {
        return Err("ssh_remote_path_invalid".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("ssh_remote_path_parent_forbidden".to_string());
    }
    Ok(())
}

/// 校验工具配置根目录，并映射为启动层错误码。
pub fn validate_tool_config_root(path: &str) -> Result<(), String> {
    match validate_remote_home_path(path) {
        Ok(()) => Ok(()),
        Err(SshRemoteHomePathError::Invalid) => Err("ssh_tool_config_root_invalid".to_string()),
        Err(SshRemoteHomePathError::ParentTraversal) => {
            Err("ssh_tool_config_root_parent_forbidden".to_string())
        }
    }
}

/// 将经过校验的工具配置根目录格式化为远端 shell 表达式。
pub fn format_tool_config_root(path: &str) -> String {
    format_remote_home_path(path)
}

/// 仅接受 ASCII 字母或下划线开头、后续可含数字的环境变量名。
pub fn is_valid_environment_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|ch| matches!(ch, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_remote_paths_and_environment_keys() {
        assert!(validate_remote_path("/srv/project").is_ok());
        assert_eq!(
            validate_remote_path("/srv/../project"),
            Err("ssh_remote_path_parent_forbidden".into())
        );
        assert!(is_valid_environment_key("CLI_MANAGER_2"));
        assert!(!is_valid_environment_key("2CLI_MANAGER"));
    }

    #[test]
    fn formats_tool_config_roots_with_home_expansion() {
        assert_eq!(
            format_tool_config_root("~/.config/tool"),
            "\"${HOME}\"/'.config/tool'"
        );
    }
}
