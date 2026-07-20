// WSL 路径互转与判定工具。
// 用户在 Windows 上把终端 shell 选成 WSL 时，claude/codex 跑在 Linux 内：
// - 会话按 Linux cwd（/mnt/d/...）编码，需要把项目的 Windows 路径转成 WSL 形式做匹配；
// - hook 注册命令里的 exe 必须是 Linux 可执行形式（/mnt/c/...exe），否则 /bin/sh 报 not found。

/// `D:\a\b` -> `/mnt/d/a/b`（盘符小写、反斜杠转正斜杠）。
/// 仅当输入形如 `<盘符>:\...` 或 `<盘符>:/...` 时返回 Some，否则 None（已是 Linux 路径/UNC 等不转）。
pub fn windows_path_to_wsl(path: &str) -> Option<String> {
    let path = path.trim();
    let bytes = path.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }
    // 第三个字符必须是路径分隔符，避免把 `C:relative` 这类奇异形式误转
    let rest = &path[2..];
    if !rest.starts_with('\\') && !rest.starts_with('/') {
        return None;
    }
    let drive = path[..1].to_ascii_lowercase();
    let tail = rest.replace('\\', "/");
    let tail = tail.trim_start_matches('/');
    if tail.is_empty() {
        Some(format!("/mnt/{drive}"))
    } else {
        Some(format!("/mnt/{drive}/{tail}"))
    }
}

/// `/mnt/d/a/b` -> `D:\a\b`（盘符大写、正斜杠转反斜杠）。
/// 仅处理 WSL 默认挂载的 Windows 盘路径，Linux 原生路径返回 None。
pub fn wsl_mnt_path_to_windows(path: &str) -> Option<String> {
    let path = path.trim();
    let rest = path.strip_prefix("/mnt/")?;
    let (drive, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if drive.len() != 1 || !drive.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }

    let drive = drive.to_ascii_uppercase();
    let tail = tail.replace('/', "\\");
    if tail.is_empty() {
        Some(format!("{drive}:\\"))
    } else {
        Some(format!("{drive}:\\{tail}"))
    }
}

/// 将 Windows verbatim WSL UNC 归一化为标准 UNC。
pub fn normalize_wsl_unc_path(path: &str) -> String {
    let normalized = path.trim().replace('/', "\\");
    let lower = normalized.to_ascii_lowercase();
    const VERBATIM_UNC_PREFIX: &str = "\\\\?\\UNC\\";
    const VERBATIM_WSL_LOCALHOST_PREFIX: &str = "\\\\?\\UNC\\wsl.localhost\\";
    const VERBATIM_WSL_DOLLAR_PREFIX: &str = "\\\\?\\UNC\\wsl$\\";

    if lower.starts_with(&VERBATIM_WSL_LOCALHOST_PREFIX.to_ascii_lowercase())
        || lower.starts_with(&VERBATIM_WSL_DOLLAR_PREFIX.to_ascii_lowercase())
    {
        return format!("\\\\{}", &normalized[VERBATIM_UNC_PREFIX.len()..]);
    }

    normalized
}

/// 判断一个配置目录路径是否指向 WSL（`\\wsl.localhost\...` 或 `\\wsl$\...`，大小写不敏感）。
pub fn is_wsl_config_dir(path: &str) -> bool {
    let normalized = normalize_wsl_unc_path(path).to_ascii_lowercase();
    normalized.starts_with("\\\\wsl.localhost\\") || normalized.starts_with("\\\\wsl$\\")
}

/// 解析 WSL UNC 路径为 `(distro, linux_path)`。
/// `\\wsl.localhost\Ubuntu\home\venti\.claude` → `Some(("Ubuntu", "/home/venti/.claude"))`
pub fn parse_wsl_unc_path(path: &str) -> Option<(String, String)> {
    let normalized = normalize_wsl_unc_path(path);
    if !is_wsl_config_dir(&normalized) {
        return None;
    }

    // 剥离前缀，得到 `<distro>\<rest>`
    let after_prefix = if normalized
        .to_ascii_lowercase()
        .starts_with("\\\\wsl.localhost\\")
    {
        &normalized["\\\\wsl.localhost\\".len()..]
    } else {
        &normalized["\\\\wsl$\\".len()..]
    };

    let (distro, tail) = after_prefix.split_once('\\')?;
    if distro.is_empty() {
        return None;
    }
    let distro = distro.to_string();
    let linux_path = format!("/{}", tail.replace('\\', "/"));
    Some((distro, linux_path))
}

/// 将 WSL Linux 路径转回 UNC 形式。
/// `("/home/venti/.claude", "Ubuntu")` → `\\wsl.localhost\Ubuntu\home\venti\.claude`
pub fn linux_to_unc_wsl_path(linux_path: &str, distro: &str) -> String {
    let tail = linux_path.trim().trim_start_matches('/').replace('/', "\\");
    format!("\\\\wsl.localhost\\{distro}\\{tail}")
}

/// 定位 `wsl.exe`，通常位于 `%SystemRoot%\System32\wsl.exe`。
pub fn find_wsl_exe() -> Option<std::path::PathBuf> {
    std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .map(|root| root.join("System32").join("wsl.exe"))
        .filter(|candidate| candidate.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_drive_paths() {
        assert_eq!(
            windows_path_to_wsl(r"D:\work\pythonProject\CLI-Manager").as_deref(),
            Some("/mnt/d/work/pythonProject/CLI-Manager")
        );
        assert_eq!(
            windows_path_to_wsl(r"C:\Users\me\app.exe").as_deref(),
            Some("/mnt/c/Users/me/app.exe")
        );
        // 正斜杠输入与盘根
        assert_eq!(
            windows_path_to_wsl("E:/data").as_deref(),
            Some("/mnt/e/data")
        );
        assert_eq!(windows_path_to_wsl(r"F:\").as_deref(), Some("/mnt/f"));
    }

    #[test]
    fn rejects_non_drive_paths() {
        assert_eq!(windows_path_to_wsl("/mnt/d/work"), None);
        assert_eq!(windows_path_to_wsl(r"\\wsl.localhost\Ubuntu\home"), None);
        assert_eq!(windows_path_to_wsl("relative/path"), None);
        assert_eq!(windows_path_to_wsl("C:relative"), None);
    }

    #[test]
    fn converts_wsl_mnt_paths_to_windows_paths() {
        assert_eq!(
            wsl_mnt_path_to_windows("/mnt/d/work/pythonProject/acGo").as_deref(),
            Some(r"D:\work\pythonProject\acGo")
        );
        assert_eq!(wsl_mnt_path_to_windows("/mnt/c").as_deref(), Some(r"C:\"));
    }

    #[test]
    fn rejects_non_wsl_mnt_paths_for_windows_conversion() {
        assert_eq!(wsl_mnt_path_to_windows("/home/me/project"), None);
        assert_eq!(wsl_mnt_path_to_windows("/mnt/dd/project"), None);
        assert_eq!(wsl_mnt_path_to_windows(r"D:\work"), None);
    }

    #[test]
    fn detects_wsl_config_dir() {
        assert!(is_wsl_config_dir(
            r"\\wsl.localhost\Ubuntu-22.04\home\me\.claude"
        ));
        assert!(is_wsl_config_dir(r"\\wsl$\Ubuntu\home\me\.claude"));
        assert!(is_wsl_config_dir(
            r"\\?\UNC\wsl.localhost\Ubuntu\home\me\.claude"
        ));
        assert!(is_wsl_config_dir(r"\\?\UNC\wsl$\Ubuntu\home\me\.claude"));
        assert!(is_wsl_config_dir(r"\\WSL.LOCALHOST\Ubuntu\home")); // 大小写不敏感
        assert!(!is_wsl_config_dir(r"C:\Users\me\.claude"));
        assert!(!is_wsl_config_dir(r"\\server\share\.claude")); // 普通 UNC 不算
    }

    #[test]
    fn parse_wsl_unc_extracts_distro_and_linux_path() {
        let result = parse_wsl_unc_path(r"\\wsl.localhost\Ubuntu\home\venti\.claude");
        assert!(result.is_some());
        let (distro, linux) = result.unwrap();
        assert_eq!(distro, "Ubuntu");
        assert_eq!(linux, "/home/venti/.claude");
    }

    #[test]
    fn parse_wsl_unc_handles_wsl_dollar() {
        let result = parse_wsl_unc_path(r"\\wsl$\Debian\root\projects");
        assert!(result.is_some());
        let (distro, linux) = result.unwrap();
        assert_eq!(distro, "Debian");
        assert_eq!(linux, "/root/projects");
    }

    #[test]
    fn parse_wsl_unc_handles_verbatim_unc() {
        let result = parse_wsl_unc_path(r"\\?\UNC\wsl.localhost\Ubuntu\home\venti\.codex\sessions");
        assert_eq!(
            result,
            Some((
                "Ubuntu".to_string(),
                "/home/venti/.codex/sessions".to_string()
            ))
        );
    }

    #[test]
    fn parse_wsl_unc_rejects_non_wsl_unc() {
        assert!(parse_wsl_unc_path(r"C:\Users\me\.claude").is_none());
        assert!(parse_wsl_unc_path(r"\\server\share\path").is_none());
    }

    #[test]
    fn linux_to_unc_roundtrip() {
        let linux = "/home/venti/.claude/projects";
        let unc = linux_to_unc_wsl_path(linux, "Ubuntu");
        assert_eq!(
            unc,
            "\\\\wsl.localhost\\Ubuntu\\home\\venti\\.claude\\projects"
        );
    }

    #[test]
    fn linux_to_unc_handles_trailing_slash() {
        let unc = linux_to_unc_wsl_path("/home/venti/", "Ubuntu");
        assert_eq!(unc, "\\\\wsl.localhost\\Ubuntu\\home\\venti\\");
    }
}
