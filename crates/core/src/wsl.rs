/// Convert a Windows drive path to the default WSL mount path.
pub fn windows_path_to_wsl(path: &str) -> Option<String> {
    let path = path.trim();
    let bytes = path.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }
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

/// Convert a default WSL mount path back to a Windows drive path.
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

pub fn is_wsl_config_dir(path: &str) -> bool {
    let normalized = normalize_wsl_unc_path(path).to_ascii_lowercase();
    normalized.starts_with("\\\\wsl.localhost\\") || normalized.starts_with("\\\\wsl$\\")
}

pub fn parse_wsl_unc_path(path: &str) -> Option<(String, String)> {
    let normalized = normalize_wsl_unc_path(path);
    if !is_wsl_config_dir(&normalized) {
        return None;
    }
    let lower = normalized.to_ascii_lowercase();
    let after_prefix = if lower.starts_with("\\\\wsl.localhost\\") {
        &normalized["\\\\wsl.localhost\\".len()..]
    } else {
        &normalized["\\\\wsl$\\".len()..]
    };
    let (distro, tail) = after_prefix.split_once('\\')?;
    if distro.is_empty() {
        return None;
    }
    Some((distro.to_string(), format!("/{}", tail.replace('\\', "/"))))
}

pub fn linux_to_unc_wsl_path(linux_path: &str, distro: &str) -> String {
    let tail = linux_path.trim().trim_start_matches('/').replace('/', "\\");
    format!("\\\\wsl.localhost\\{distro}\\{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_drive_paths() {
        assert_eq!(
            windows_path_to_wsl(r"D:\work\x").as_deref(),
            Some("/mnt/d/work/x")
        );
        assert_eq!(windows_path_to_wsl(r"C:\").as_deref(), Some("/mnt/c"));
        assert_eq!(
            wsl_mnt_path_to_windows("/mnt/d/work/x").as_deref(),
            Some(r"D:\work\x")
        );
        assert_eq!(wsl_mnt_path_to_windows("/mnt/c").as_deref(), Some(r"C:\"));
    }

    #[test]
    fn parses_wsl_unc_paths_and_rejects_other_paths() {
        assert_eq!(
            parse_wsl_unc_path(r"\\wsl.localhost\Ubuntu\home\me"),
            Some(("Ubuntu".into(), "/home/me".into()))
        );
        assert!(is_wsl_config_dir(r"\\?\UNC\wsl$\Debian\root"));
        assert!(parse_wsl_unc_path(r"\\server\share\path").is_none());
    }
}
