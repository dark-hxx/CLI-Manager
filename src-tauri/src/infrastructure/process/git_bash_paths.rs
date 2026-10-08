//! Additional Git for Windows layouts, without executing PATH commands or changing PATH.
use std::env;
use std::path::{Path, PathBuf};

// Require Git for Windows layout markers before accepting a Bash executable.
fn bash_from_root(root: &Path) -> Option<PathBuf> {
    if !root.join("cmd/git.exe").is_file() || !root.join("usr/bin/bash.exe").is_file() {
        return None;
    }
    [root.join("bin/bash.exe"), root.join("usr/bin/bash.exe")]
        .into_iter()
        .find(|candidate| candidate.is_file())
}

// Prefer Scoop's stable current junction, so upgrading Git does not leave a versioned path.
fn bash_from_scoop_root(root: &Path) -> Option<PathBuf> {
    bash_from_root(&root.join("apps/git/current"))
}

// Examine only adjacent installation roots; never accept arbitrary PATH bash.exe or WSL Bash.
pub(super) fn path_candidate() -> Option<PathBuf> {
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
        // cmd/bin/usr/bin and an installation root can all be exposed on PATH.
        dir.ancestors().take(3).find_map(bash_from_root)
    })
}

// Support per-user/global defaults and explicitly configured Scoop roots, without PATH edits.
pub(super) fn scoop_candidate() -> Option<PathBuf> {
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
