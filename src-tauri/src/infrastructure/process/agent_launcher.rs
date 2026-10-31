use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// 保留旧托管 wrapper 的排除规则，升级后也不能解析到递归调用自己的启动器。
fn directory_matches(left: &Path, right: &Path) -> bool {
    left == right || matches!((fs::canonicalize(left), fs::canonicalize(right)),
        (Ok(left), Ok(right)) if left == right)
}

// 按平台规则寻找真实 CLI；显式路径相对于项目目录解析，不执行自由 shell 文本。
pub(crate) fn resolve_local_agent_program(program: &str, work_dir: &Path) -> Result<PathBuf, String> {
    let configured = Path::new(program);
    if configured.is_absolute() || program.contains(['/', '\\']) {
        let candidate = if configured.is_absolute() {
            configured.to_path_buf()
        } else {
            work_dir.join(configured)
        };
        return candidate.canonicalize()
            .ok().filter(|path| path.is_file())
            .ok_or_else(|| "cli_launcher_unavailable".to_string());
    }
    let path = env::var_os("PATH").ok_or("cli_launcher_unavailable")?;
    let skip = (program.eq_ignore_ascii_case("codex") || program.eq_ignore_ascii_case("codex.exe"))
        .then(|| crate::app_paths::cli_manager_data_dir().map(|dir| dir.join("remote-manager/bin")))
        .transpose()?;
    resolve_program_from_path(program, &path, skip.as_deref())
}

fn resolve_program_from_path(
    program: &str,
    path_value: &std::ffi::OsStr,
    skip_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    for directory in env::split_paths(path_value) {
        if skip_dir.is_some_and(|skip| directory_matches(&directory, skip)) {
            continue;
        }
        #[cfg(target_os = "windows")]
        let candidates = if Path::new(program).extension().is_some() {
            vec![program.to_string()]
        } else {
            ["exe", "cmd", "bat", "com", "ps1"].map(|ext| format!("{program}.{ext}")).to_vec()
        };
        #[cfg(not(target_os = "windows"))]
        let candidates = vec![program.to_string()];
        for candidate in candidates {
            let candidate = directory.join(candidate);
            #[cfg(not(target_os = "windows"))]
            {
                use std::os::unix::fs::PermissionsExt;
                let Ok(metadata) = candidate.metadata() else { continue };
                if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            if candidate.is_file() {
                if let Ok(canonical) = candidate.canonicalize() {
                    return Ok(canonical);
                }
            }
        }
    }
    Err("cli_launcher_unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_paths_resolve_against_project_and_reject_directories() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("local-tool.cmd");
        fs::write(&file, "test").unwrap();
        assert_eq!(resolve_local_agent_program("./local-tool.cmd", dir.path()).unwrap(), file.canonicalize().unwrap());
        assert!(resolve_local_agent_program("./missing.cmd", dir.path()).is_err());
        assert!(resolve_local_agent_program(&dir.path().to_string_lossy(), dir.path()).is_err());
    }

    #[test]
    fn skips_legacy_wrapper_and_finds_real_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let wrapper = dir.path().join("wrapper");
        let actual = dir.path().join("actual");
        fs::create_dir_all(&wrapper).unwrap();
        fs::create_dir_all(&actual).unwrap();
        let name = if cfg!(windows) { "codex.cmd" } else { "codex" };
        for directory in [&wrapper, &actual] {
            let file = directory.join(name);
            fs::write(&file, "test").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let path = env::join_paths([&wrapper, &actual]).unwrap();
        assert_eq!(resolve_program_from_path("codex", &path, Some(&wrapper)).unwrap(), actual.join(name).canonicalize().unwrap());
        assert!(resolve_program_from_path("missing-tool", &path, None).is_err());
    }
}
