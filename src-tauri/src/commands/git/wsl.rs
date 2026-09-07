use super::{normalize_path, GitFileChange, WSL_GIT_COMMAND_TIMEOUT};
use crate::shell_resolver::{output_with_timeout, silent_command};
use std::path::Path;

pub(in crate::commands) fn run_wsl_git(
    distro: &str,
    linux_path: &str,
    git_args: &[&str],
) -> Result<Vec<u8>, String> {
    let program = crate::wsl::find_wsl_exe()
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string());

    let mut cmd = silent_command(&program);
    let args = build_wsl_git_command_args(distro, linux_path, git_args);
    cmd.args(&args);

    let output = output_with_timeout(cmd, WSL_GIT_COMMAND_TIMEOUT).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            "wsl_git_timeout".to_string()
        } else {
            format!("spawn_failed: {e}")
        }
    })?;
    if output.status.success() {
        return Ok(output.stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let combined_output = format!("{stderr}{stdout}");
    if is_not_git_repository_output(&combined_output) {
        return Err("not_git_repository".to_string());
    }
    let snippet = combined_output.trim().chars().take(300).collect::<String>();
    Err(format!(
        "wsl_git_failed(exit={}): {}",
        output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".to_string()),
        snippet
    ))
}

pub(super) fn is_not_git_repository_output(output: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    normalized.contains("not a git repository")
        || normalized.contains("不是一个 git 仓库")
        || normalized.contains("不是 git 仓库")
}

pub(in crate::commands) fn resolve_wsl_mnt_git_project_path(
    distro: &str,
    linux_path: &str,
) -> Option<String> {
    let resolved_linux_path =
        resolve_wsl_linux_realpath(distro, linux_path).unwrap_or_else(|| linux_path.to_string());
    let windows_path = crate::wsl::wsl_mnt_path_to_windows(&resolved_linux_path)?;
    if Path::new(&windows_path).exists() {
        Some(windows_path)
    } else {
        log::warn!(
            "[git:wsl] WSL 路径已解析为 /mnt 挂载但 Windows 路径不存在: linux_path={} resolved={} windows_path={}",
            linux_path,
            resolved_linux_path,
            windows_path
        );
        None
    }
}

pub(super) fn effective_git_project_path(project_path: &str) -> String {
    crate::wsl::parse_wsl_unc_path(project_path)
        .and_then(|(distro, linux_path)| resolve_wsl_mnt_git_project_path(&distro, &linux_path))
        .unwrap_or_else(|| project_path.to_string())
}

pub(super) fn resolve_wsl_linux_realpath(distro: &str, linux_path: &str) -> Option<String> {
    let program = crate::wsl::find_wsl_exe()
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string());
    let mut command = silent_command(&program);
    command.args(["-d", distro, "--exec", "readlink", "-f", linux_path]);
    let output = output_with_timeout(command, WSL_GIT_COMMAND_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if resolved.is_empty() {
        None
    } else {
        Some(resolved)
    }
}

pub(super) fn build_wsl_git_command_args(
    distro: &str,
    linux_path: &str,
    git_args: &[&str],
) -> Vec<String> {
    let mut args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "git".to_string(),
        "-c".to_string(),
        format!("safe.directory={linux_path}"),
        "-C".to_string(),
        linux_path.to_string(),
    ];
    args.extend(git_args.iter().map(|arg| (*arg).to_string()));
    args
}

pub(super) fn parse_wsl_git_status(stdout: &[u8]) -> Vec<GitFileChange> {
    let records: Vec<&[u8]> = stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect();
    let mut changes = Vec::new();
    let mut index = 0usize;

    while index < records.len() {
        let record = records[index];
        index += 1;

        if record.len() < 4 {
            continue;
        }

        let x = record[0];
        let y = record[1];
        let path_bytes = if record[2] == b' ' {
            &record[3..]
        } else {
            &record[2..]
        };
        let path = normalize_path(&String::from_utf8_lossy(path_bytes));
        if path.is_empty() {
            continue;
        }

        let (status, staged) = parse_porcelain_status(x, y);
        changes.push(GitFileChange {
            path,
            status: status.to_string(),
            staged,
            added: 0,
            deleted: 0,
        });

        // `git status -z` emits an extra old path record after renamed/copied entries.
        if x == b'R' || x == b'C' {
            index = index.saturating_add(1);
        }
    }

    changes
}

pub(super) fn parse_porcelain_status(x: u8, y: u8) -> (&'static str, bool) {
    if is_porcelain_conflict(x, y) {
        return ("C", false);
    }
    if x == b'?' && y == b'?' {
        return ("U", false);
    }
    if x != b' ' {
        return (map_porcelain_status_byte(x), true);
    }
    if y != b' ' {
        return (map_porcelain_status_byte(y), false);
    }
    ("M", false)
}

pub(super) fn is_porcelain_conflict(x: u8, y: u8) -> bool {
    x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D')
}

pub(super) fn map_porcelain_status_byte(status: u8) -> &'static str {
    match status {
        b'A' => "A",
        b'D' => "D",
        b'R' => "R",
        _ => "M",
    }
}
