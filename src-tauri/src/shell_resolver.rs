use std::env;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

#[cfg(target_os = "windows")]
use crate::process_job::ChildJob;

pub const GIT_BASH_NOT_FOUND_MESSAGE: &str =
    "Git Bash executable not found. Please install Git for Windows or add Git Bash to PATH.";

const GIT_BASH_CANDIDATES: [&str; 4] = [
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files\Git\usr\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 构造"静默执行"的 Command：Windows 下附加 CREATE_NO_WINDOW，避免后台命令闪出控制台窗口。
///
/// 约定：本应用内任何不需要可见窗口的进程 spawn 必须复用本 helper，
/// 直接用 `Command::new` 会导致闪窗问题复发。
/// 有意打开可见窗口的场景（如 `commands/shell.rs` 中 spawn `wt.exe`）除外。
#[cfg(windows)]
pub fn silent_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// 非 Windows 平台行为与 `Command::new` 完全一致。
#[cfg(not(windows))]
pub fn silent_command(program: &str) -> Command {
    Command::new(program)
}

/// 执行外部进程并强制超时：超过 `timeout` 后 kill 子进程并返回 `TimedOut` 错误。
///
/// 约定：任何"探测型"子进程（`wsl.exe`、`bun --version` 等）必须走本 helper。
/// 探测目标损坏时（如 WSL 服务异常）裸 `.output()` 会无限期阻塞调用线程，
/// 若调用方是同步 Tauri 命令还会卡死主线程导致整个窗口无响应。
pub fn output_with_timeout(
    mut command: Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    #[cfg(target_os = "windows")]
    let job = match ChildJob::assign(&child, "probe process") {
        Ok(job) => job,
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other(err));
        }
    };

    // 独立线程排空管道，避免子进程输出填满管道缓冲后互相等待。
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(err) => {
                #[cfg(target_os = "windows")]
                job.terminate();
                #[cfg(unix)]
                terminate_process_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
        }
        if std::time::Instant::now() >= deadline {
            #[cfg(target_os = "windows")]
            job.terminate();
            #[cfg(unix)]
            terminate_process_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
            // Cleanup is best-effort. Do not turn a bounded timeout back into an
            // unbounded wait if the OS cannot terminate a descendant or close its pipe.
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("进程超过 {}s 未结束，已终止", timeout.as_secs()),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    };

    // A launcher can exit before a descendant that inherited its stdout/stderr pipes.
    // Tear down the owned tree before joining readers so successful probes cannot hang.
    #[cfg(target_os = "windows")]
    drop(job);
    #[cfg(unix)]
    terminate_process_group(child.id());

    Ok(std::process::Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

#[cfg(unix)]
fn terminate_process_group(pid: u32) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;

    let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
}

#[cfg(all(test, unix))]
mod process_tree_tests {
    use super::*;

    #[test]
    fn launcher_exit_does_not_leave_a_descendant_holding_output_pipes() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 &"]);
        let started = std::time::Instant::now();

        let output = output_with_timeout(command, std::time::Duration::from_secs(2)).unwrap();

        assert!(output.status.success());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}

pub fn resolve_git_bash_exe() -> Option<PathBuf> {
    fixed_path_candidate()
        .or_else(path_git_candidate)
        .or_else(registry_git_candidate)
}

fn fixed_path_candidate() -> Option<PathBuf> {
    GIT_BASH_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.exists())
}

fn path_git_candidate() -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .filter(is_git_path_dir)
            .map(|dir| dir.join("bash.exe"))
            .find(|candidate| candidate.exists())
    })
}

fn is_git_path_dir(dir: &PathBuf) -> bool {
    let normalized = dir.to_string_lossy().replace('\\', "/").to_lowercase();
    normalized.ends_with("/git/bin") || normalized.ends_with("/git/usr/bin")
}

#[cfg(windows)]
fn registry_git_candidate() -> Option<PathBuf> {
    app_paths_candidate().or_else(uninstall_key_candidate)
}

#[cfg(not(windows))]
fn registry_git_candidate() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
fn app_paths_candidate() -> Option<PathBuf> {
    const APP_PATH_KEYS: [&str; 4] = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\bash.exe",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\bash.exe",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\bash.exe",
        r"HKCU\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\bash.exe",
    ];

    APP_PATH_KEYS
        .iter()
        .filter_map(|key| reg_query_value(key, None))
        .map(PathBuf::from)
        .find(|candidate| candidate.exists() && is_git_bash_path(candidate))
}

#[cfg(windows)]
fn uninstall_key_candidate() -> Option<PathBuf> {
    const UNINSTALL_KEYS: [&str; 4] = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    UNINSTALL_KEYS.iter().find_map(|key| {
        let output = silent_command("reg")
            .args(["query", key, "/s", "/f", "Git", "/d"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }

        let text = String::from_utf8_lossy(&output.stdout);
        install_locations_from_reg_output(&text)
            .into_iter()
            .flat_map(git_bash_candidates_from_install_dir)
            .find(|candidate| candidate.exists())
    })
}

#[cfg(windows)]
fn reg_query_value(key: &str, value: Option<&str>) -> Option<String> {
    let mut args = vec!["query", key];
    if let Some(value) = value {
        args.extend(["/v", value]);
    } else {
        args.push("/ve");
    }

    let output = silent_command("reg").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }

    parse_reg_value(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(windows)]
fn parse_reg_value(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let value_start = trimmed.find("REG_")?;
        let value = trimmed[value_start..].split_once(char::is_whitespace)?.1;
        let cleaned = clean_registry_path(value.trim());
        (!cleaned.is_empty()).then_some(cleaned)
    })
}

#[cfg(windows)]
fn install_locations_from_reg_output(output: &str) -> Vec<PathBuf> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if !trimmed.starts_with("InstallLocation") {
                return None;
            }
            parse_reg_value(trimmed).map(PathBuf::from)
        })
        .collect()
}

#[cfg(windows)]
fn clean_registry_path(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"');
    let without_icon_index = trimmed
        .strip_suffix(",0")
        .or_else(|| trimmed.strip_suffix(",-0"))
        .unwrap_or(trimmed);
    without_icon_index.trim_matches('"').to_string()
}

#[cfg(windows)]
fn git_bash_candidates_from_install_dir(dir: PathBuf) -> Vec<PathBuf> {
    vec![
        dir.join("bin").join("bash.exe"),
        dir.join("usr").join("bin").join("bash.exe"),
    ]
}

#[cfg(windows)]
fn is_git_bash_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    (normalized.ends_with("/git/bin/bash.exe") || normalized.ends_with("/git/usr/bin/bash.exe"))
        && path.exists()
}
