use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

fn directory_matches(left: &Path, right: &Path) -> bool {
    left == right
        || matches!(
            (fs::canonicalize(left), fs::canonicalize(right)),
            (Ok(left), Ok(right)) if left == right
        )
}

pub fn resolve_program_from_path(
    program: &str,
    path_value: &OsStr,
    skip_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    for directory in std::env::split_paths(path_value) {
        if skip_dir.is_some_and(|skip| directory_matches(&directory, skip)) {
            continue;
        }
        #[cfg(target_os = "windows")]
        let candidates = if Path::new(program).extension().is_some() {
            vec![program.to_string()]
        } else {
            ["exe", "cmd", "bat", "com", "ps1"]
                .map(|ext| format!("{program}.{ext}"))
                .to_vec()
        };
        #[cfg(not(target_os = "windows"))]
        let candidates = vec![program.to_string()];
        for candidate in candidates {
            let candidate = directory.join(candidate);
            #[cfg(not(target_os = "windows"))]
            {
                use std::os::unix::fs::PermissionsExt;
                let Ok(metadata) = candidate.metadata() else {
                    continue;
                };
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
        let path = std::env::join_paths([&wrapper, &actual]).unwrap();
        assert_eq!(
            resolve_program_from_path("codex", &path, Some(&wrapper)).unwrap(),
            actual.join(name).canonicalize().unwrap()
        );
        assert!(resolve_program_from_path("missing-tool", &path, None).is_err());
    }
}
