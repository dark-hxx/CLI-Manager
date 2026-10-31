//! Resolve the Linux target before creating a Windows PTY process.
pub(super) fn resolve_wsl_launch(cwd: Option<&str>) -> Result<(Vec<String>, Option<String>), String> {
    let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) else {
        return Ok((Vec::new(), None));
    };
    if cwd.chars().any(char::is_control) { return Err("history_resume_wsl_path_invalid".into()); }
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(cwd) {
        return Ok((vec!["--distribution".into(), distro, "--cd".into(), linux_path], None));
    }
    if cwd.starts_with('/') && !cwd.starts_with("//") {
        return Ok((vec!["--cd".into(), cwd.to_string()], None));
    }
    if let Some(linux_path) = crate::wsl::windows_path_to_wsl(cwd) {
        return Ok((vec!["--cd".into(), linux_path], None));
    }
    Err("history_resume_wsl_path_invalid".into())
}

pub(super) fn validate_wsl_directory(args: &[String]) -> Result<(), String> {
    let Some(index) = args.iter().position(|arg| arg == "--cd") else { return Ok(()) };
    let path = args.get(index + 1).ok_or("history_resume_wsl_path_invalid")?;
    let mut command = crate::shell_resolver::silent_command("wsl.exe");
    if let Some(index) = args.iter().position(|arg| arg == "--distribution") {
        command.args(["--distribution", args.get(index + 1).ok_or("history_resume_wsl_distro_required")?]);
    }
    command.args(["--exec", "test", "-d", path]);
    let output = crate::shell_resolver::output_with_timeout(command, std::time::Duration::from_secs(10))
        .map_err(|error| if error.kind() == std::io::ErrorKind::TimedOut {
            "history_resume_wsl_timeout".to_string()
        } else { "history_resume_wsl_unavailable".to_string() })?;
    if !output.status.success() { return Err("history_resume_wsl_cwd_unavailable".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wsl_launch_separates_host_and_guest_directories() {
        for path in [r"\\wsl.localhost\Ubuntu Test\home\dev\my project", r"\\wsl$\Ubuntu Test\home\dev\my project"] {
            let (args, host_cwd) = resolve_wsl_launch(Some(path)).unwrap();
            assert_eq!(args, ["--distribution", "Ubuntu Test", "--cd", "/home/dev/my project"]);
            assert_eq!(host_cwd, None);
        }
        assert_eq!(resolve_wsl_launch(Some("/home/dev/project")).unwrap(), (vec!["--cd".into(), "/home/dev/project".into()], None));
        assert_eq!(resolve_wsl_launch(Some(r"D:\my project")).unwrap().0, ["--cd", "/mnt/d/my project"]);
        assert!(resolve_wsl_launch(Some("relative/path")).is_err());
        assert!(resolve_wsl_launch(Some("/home/bad\npath")).is_err());
    }
}
