use std::env;
use std::path::{Path, PathBuf};

const FIXED_CANDIDATES: [&str; 4] = [
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files\Git\usr\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
];

/// Select an existing executable from the conventional Git for Windows paths.
pub fn fixed_path_candidate() -> Option<PathBuf> {
    FIXED_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.exists())
}

/// Accept only PATH entries that are Git for Windows `bin` directories.
pub fn is_git_path_dir(dir: &Path) -> bool {
    let normalized = dir.to_string_lossy().replace('\\', "/").to_lowercase();
    normalized.ends_with("/git/bin") || normalized.ends_with("/git/usr/bin")
}

/// Check the executable suffix used by Git Bash installations.
pub fn is_git_bash_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    normalized.ends_with("/git/bin/bash.exe") || normalized.ends_with("/git/usr/bin/bash.exe")
}

// Require Git for Windows layout markers before accepting a Bash executable.
fn bash_from_root(root: &Path) -> Option<PathBuf> {
    if !root.join("cmd/git.exe").is_file() || !root.join("usr/bin/bash.exe").is_file() {
        return None;
    }
    [root.join("bin/bash.exe"), root.join("usr/bin/bash.exe")]
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn bash_from_scoop_root(root: &Path) -> Option<PathBuf> {
    bash_from_root(&root.join("apps/git/current"))
}

/// 从 PATH 邻近的 Git for Windows 安装目录中查找 Bash。
pub fn path_candidate() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path).find_map(|dir| {
        if dir
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("shims"))
        {
            if let Some(bash) = dir.parent().and_then(bash_from_scoop_root) {
                return Some(bash);
            }
        }
        dir.ancestors().take(3).find_map(bash_from_root)
    })
}

/// 从 Scoop 的用户级、全局和显式环境变量根目录中查找 Bash。
pub fn scoop_candidate() -> Option<PathBuf> {
    let mut roots = Vec::new();
    for name in ["SCOOP", "SCOOP_GLOBAL"] {
        if let Some(root) = env::var_os(name).filter(|value| !value.is_empty()) {
            roots.push(PathBuf::from(root));
        }
    }
    for name in ["USERPROFILE", "ProgramData"] {
        if let Some(root) = env::var_os(name).filter(|value| !value.is_empty()) {
            roots.push(PathBuf::from(root).join("scoop"));
        }
    }
    roots.iter().find_map(|root| bash_from_scoop_root(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_git_path_layouts() {
        assert!(is_git_path_dir(Path::new(r"C:\Git\bin")));
        assert!(is_git_path_dir(Path::new(r"C:\Git\usr\bin")));
        assert!(!is_git_path_dir(Path::new(r"C:\Other\bin")));
        assert!(!is_git_path_dir(Path::new(r"C:\Git\mingw64\bin")));
    }

    #[test]
    fn recognizes_git_bash_executable_suffixes() {
        assert!(is_git_bash_path(Path::new(r"C:\Git\bin\bash.exe")));
        assert!(is_git_bash_path(Path::new(r"C:\Git\usr\bin\BASH.EXE")));
        assert!(!is_git_bash_path(Path::new(r"C:\Git\bin\sh.exe")));
    }
}
