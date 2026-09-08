use super::{build_wsl_git_command_args, resolve_wsl_mnt_git_project_path};
use crate::shell_resolver::silent_command;
use std::path::Path;

/// 把 git stderr 映射为稳定错误码 + 原始片段，供前端 toast 展示。
/// 形如 "not_fast_forward: <git 原文>"。
// 按 stderr 特征映射稳定 Git 错误码，并保留最多三百字符的原始片段。
pub(super) fn map_git_cli_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    let code = if s.contains("authentication failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("permission denied")
        || s.contains("invalid username or password")
    {
        "auth_failed"
    } else if s.contains("non-fast-forward")
        || s.contains("fetch first")
        || s.contains("updates were rejected")
        || s.contains("[rejected]")
        || s.contains("not possible to fast-forward")
        || s.contains("diverging")
        || s.contains("divergent")
    {
        "not_fast_forward"
    } else if s.contains("no upstream") || s.contains("has no upstream") {
        "no_upstream"
    } else if s.contains("would be overwritten by checkout")
        || s.contains("would be overwritten by merge")
        || s.contains("please commit your changes or stash them")
    {
        "checkout_conflict"
    } else if s.contains("could not read from remote")
        || s.contains("does not appear to be a git repository")
        || s.contains("no configured push destination")
        || s.contains("no such remote")
        || s.contains("'origin' does not appear")
    {
        "no_remote"
    } else {
        "git_failed"
    };
    let snippet: String = stderr.trim().chars().take(300).collect();
    format!("{code}: {snippet}")
}

// 按本地或 WSL 路径执行参数数组，WSL 挂载 Windows 盘时回退本地 Git。
pub(in crate::commands) fn git_command_output(
    project_path: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(project_path) {
        if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
            let path = Path::new(&windows_path);
            if !path.exists() {
                return Err("path_not_found".to_string());
            }
            let mut cmd = silent_command("git");
            cmd.current_dir(path).args(args);
            return cmd.output().map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "git_not_found".to_string()
                } else {
                    format!("spawn_failed: {e}")
                }
            });
        }

        let program = crate::wsl::find_wsl_exe()
            .as_deref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "wsl.exe".to_string());
        let mut cmd = silent_command(&program);
        let wsl_args = build_wsl_git_command_args(&distro, &linux_path, args);
        cmd.args(&wsl_args);
        return cmd.output().map_err(|e| format!("spawn_failed: {e}"));
    }

    let path = Path::new(project_path);
    if !path.exists() {
        return Err("path_not_found".to_string());
    }

    let mut cmd = silent_command("git");
    cmd.current_dir(path).args(args);

    cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("spawn_failed: {e}")
        }
    })
}

/// shell out 系统 `git` 执行网络操作，继承用户凭据管理器 / SSH / git config 代理。
/// WSL UNC 路径改由 wsl.exe 内部执行 git，避免 Windows git 在 UNC/Plan 9 上失败。
/// 用 args 数组（非 shell）避免注入；成功返回合并输出，失败返回映射错误码。
// 执行系统 Git，成功合并标准输出与错误输出，失败映射稳定错误。
pub(in crate::commands) fn run_git_cli(
    project_path: &str,
    args: &[&str],
) -> Result<String, String> {
    let output = git_command_output(project_path, args)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(map_git_cli_error(&format!("{stderr}{stdout}")))
    }
}

/// 校验分支名安全：非空、不以 '-' 开头（防被当作 git flag）、无空白/控制字符。
// 拒绝空名、选项前缀、空白控制字符及 Git 分支名危险结构。
pub(super) fn validate_branch_name(branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Err("empty_branch".into());
    }
    if branch.starts_with('-') {
        return Err("invalid_branch".into());
    }
    if branch.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("invalid_branch".into());
    }
    if branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch
            .chars()
            .any(|c| matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err("invalid_branch".into());
    }
    Ok(())
}

// 先检查分支名基础规则，再运行 Git check-ref-format 验证。
pub(super) fn validate_branch_name_with_git(
    project_path: &str,
    branch: &str,
) -> Result<(), String> {
    validate_branch_name(branch)?;
    run_git_cli(project_path, &["check-ref-format", "--branch", branch])
        .map(|_| ())
        .map_err(|_| "invalid_branch".to_string())
}

// 限制操作引用的长度并拒绝选项前缀、空白及控制字符。
pub(in crate::commands) fn validate_operation_ref(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value.starts_with('-')
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("invalid_git_ref".to_string());
    }
    Ok(())
}

// 检查引用参数形状后通过 Git rev-parse 验证其存在。
pub(in crate::commands) fn validate_commit_ref(
    project_path: &str,
    value: &str,
) -> Result<(), String> {
    validate_operation_ref(value)?;
    run_git_cli(project_path, &["rev-parse", "--verify", value])
        .map(|_| ())
        .map_err(|_| "commit_not_found".to_string())
}

// 按首个斜杠拆分远程名和分支名，要求两部分均非空。
pub(super) fn split_remote_branch(branch: &str) -> Option<(&str, &str)> {
    let (remote, name) = branch.split_once('/')?;
    (!remote.is_empty() && !name.is_empty()).then_some((remote, name))
}

// 普通切换本地分支，或验证远程名结构后创建跟踪分支。
pub(super) fn run_checkout_branch(
    project_path: &str,
    branch: &str,
    remote: bool,
) -> Result<String, String> {
    if remote {
        if split_remote_branch(branch).is_none() {
            return Err("invalid_branch".to_string());
        }
        run_git_cli(project_path, &["checkout", "--track", branch])
    } else {
        run_git_cli(project_path, &["checkout", branch])
    }
}

// 按英文输出识别 stash 没有保存本地变更的情况。
pub(super) fn is_no_stash_created(output: &str) -> bool {
    let s = output.to_lowercase();
    s.contains("no local changes to save") || s.contains("no local changes")
}
