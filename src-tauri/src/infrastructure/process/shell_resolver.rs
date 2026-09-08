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
// 创建隐藏控制台的命令构造器，尚未启动进程；后续参数和输出方式由调用方设置。
pub fn silent_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// 非 Windows 平台行为与 `Command::new` 完全一致。
#[cfg(not(windows))]
// 非 Windows 直接构造命令，不附加平台专用启动标志，也不执行程序。
pub fn silent_command(program: &str) -> Command {
    Command::new(program)
}

/// 执行外部进程并强制超时：超过 `timeout` 后 kill 子进程并返回 `TimedOut` 错误。
///
/// 约定：任何"探测型"子进程（`wsl.exe`、`bun --version` 等）必须走本 helper。
/// 探测目标损坏时（如 WSL 服务异常）裸 `.output()` 会无限期阻塞调用线程，
/// 若调用方是同步 Tauri 命令还会卡死主线程导致整个窗口无响应。
// 关闭标准输入并并发收集完整输出；轮询超时或失败时清理进程树，成功后也清理继承管道的后代。
// 返回子进程原始退出状态，不将非零退出码转为错误；此版本不限制输出占用的内存。
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

/// Output from a probe whose retained stdout is capped while the pipe is still fully drained.
pub struct BoundedOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stdout_truncated: bool,
}

// 持续排空管道但只保留前 limit 字节，返回是否丢弃过数据；读取失败按结束处理，不向上传播。
fn drain_bounded<R: std::io::Read>(pipe: Option<R>, limit: usize) -> (Vec<u8>, bool) {
    let mut retained = Vec::with_capacity(limit.min(8 * 1024));
    let mut truncated = false;
    let Some(mut pipe) = pipe else {
        return (retained, truncated);
    };
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let count = match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let remaining = limit.saturating_sub(retained.len());
        let copy_count = remaining.min(count);
        retained.extend_from_slice(&chunk[..copy_count]);
        truncated |= copy_count < count;
    }
    (retained, truncated)
}

/// Executes a probe with timeout and a hard cap on retained stdout bytes.
///
/// Bytes beyond `stdout_limit` are discarded while the pipe continues to be drained, so a noisy
/// child cannot grow the application process without bound or deadlock on a full pipe.
// 带超时运行探测进程，限量保留 stdout 并完全丢弃 stderr；两路均持续读取以避免管道阻塞。
// 超时/轮询失败清理进程树，正常退出也清理后代；截断标志与原始退出状态一起交给调用方判断。
pub fn output_with_timeout_bounded(
    mut command: Command,
    timeout: std::time::Duration,
    stdout_limit: usize,
) -> std::io::Result<BoundedOutput> {
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
    let job = match ChildJob::assign(&child, "bounded probe process") {
        Ok(job) => job,
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other(err));
        }
    };

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || drain_bounded(stdout_pipe, stdout_limit));
    let stderr_reader = std::thread::spawn(move || drain_bounded(stderr_pipe, 0));

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
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("进程超过 {}s 未结束，已终止", timeout.as_secs()),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    };

    #[cfg(target_os = "windows")]
    drop(job);
    #[cfg(unix)]
    terminate_process_group(child.id());

    let (stdout, stdout_truncated) = stdout_reader.join().unwrap_or_default();
    let _ = stderr_reader.join();
    Ok(BoundedOutput {
        status,
        stdout,
        stdout_truncated,
    })
}

#[cfg(unix)]
// 向以 pid 为组号的进程组发送 SIGKILL；用于回收探测进程后代，忽略终止失败。
fn terminate_process_group(pid: u32) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;

    let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
}

#[cfg(all(test, unix))]
mod process_tree_tests {
    use super::*;

    #[test]
    // 验证启动器先退出时，继承输出管道的后台子进程不会让探测长时间等待 EOF。
    fn launcher_exit_does_not_leave_a_descendant_holding_output_pipes() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 &"]);
        let started = std::time::Instant::now();

        let output = output_with_timeout(command, std::time::Duration::from_secs(2)).unwrap();

        assert!(output.status.success());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}

#[cfg(test)]
mod process_timeout_tests {
    use super::*;

    #[test]
    // 用长耗时本地命令验证短超时返回 TimedOut，且不会等待命令原定运行时长。
    fn long_running_process_is_terminated_at_timeout() {
        let command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping 127.0.0.1 -n 6 > nul"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 5"]);
            command
        };
        let started = std::time::Instant::now();
        let error = output_with_timeout(command, std::time::Duration::from_millis(100))
            .expect_err("long-running process should time out");

        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
    }

    #[test]
    // 验证大量输出仍可正常退出，但只保留指定字节数并报告截断。
    fn bounded_output_discards_bytes_over_the_limit() {
        let command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "for /L %i in (1,1,200) do @echo 1234567890"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                "i=0; while [ $i -lt 200 ]; do echo 1234567890; i=$((i+1)); done",
            ]);
            command
        };

        let output =
            output_with_timeout_bounded(command, std::time::Duration::from_secs(2), 32).unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 32);
        assert!(output.stdout_truncated);
    }
}

// 依次尝试固定安装位置、PATH 中的 Git 目录和注册表，返回首个候选；不执行 Bash 验证可用性。
pub fn resolve_git_bash_exe() -> Option<PathBuf> {
    fixed_path_candidate()
        .or_else(path_git_candidate)
        .or_else(registry_git_candidate)
}

// 按预设顺序选择存在的常见安装路径，仅检查 exists，不验证文件类型或版本。
fn fixed_path_candidate() -> Option<PathBuf> {
    GIT_BASH_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.exists())
}

// 仅在 PATH 中形如 Git/bin 或 Git/usr/bin 的目录寻找 bash.exe，避免任意同名 Shell 被选中。
fn path_git_candidate() -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .filter(is_git_path_dir)
            .map(|dir| dir.join("bash.exe"))
            .find(|candidate| candidate.exists())
    })
}

// 统一分隔符和大小写后按目录后缀识别 Git 路径，不做文件系统规范化。
fn is_git_path_dir(dir: &PathBuf) -> bool {
    let normalized = dir.to_string_lossy().replace('\\', "/").to_lowercase();
    normalized.ends_with("/git/bin") || normalized.ends_with("/git/usr/bin")
}

#[cfg(windows)]
// 优先查询 App Paths 的 Bash 注册，再从卸载项的安装位置推导候选路径。
fn registry_git_candidate() -> Option<PathBuf> {
    app_paths_candidate().or_else(uninstall_key_candidate)
}

#[cfg(not(windows))]
// 非 Windows 没有注册表回退来源，返回未找到。
fn registry_git_candidate() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
// 按机器/用户及注册表视图顺序读取 bash.exe 默认值，只接受存在且后缀符合 Git Bash 的路径。
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
// 同步调用 reg 搜索含 Git 的卸载记录，从 InstallLocation 推导 Bash；查询失败跳到下一注册表根。
// 当前使用普通 output 等待，不经过带超时的探测 helper。
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
// 同步查询注册表指定值或默认值，执行失败/非零退出返回 None；成功后解析首个可用值文本。
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
// 从 reg 文本中提取首个 REG_ 类型后面的非空值并清理路径装饰，不展开环境变量。
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
// 仅收集 InstallLocation 开头的行，复用值解析并保留输出顺序，不验证目录是否存在。
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
// 去除外层引号及约定的 ,0/,-0 图标索引后缀，不执行路径解析或变量替换。
fn clean_registry_path(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"');
    let without_icon_index = trimmed
        .strip_suffix(",0")
        .or_else(|| trimmed.strip_suffix(",-0"))
        .unwrap_or(trimmed);
    without_icon_index.trim_matches('"').to_string()
}

#[cfg(windows)]
// 从安装根生成 bin 与 usr/bin 两个候选，存在性由调用方检查。
fn git_bash_candidates_from_install_dir(dir: PathBuf) -> Vec<PathBuf> {
    vec![
        dir.join("bin").join("bash.exe"),
        dir.join("usr").join("bin").join("bash.exe"),
    ]
}

#[cfg(windows)]
// 按忽略大小写的 Git Bash 路径后缀并结合 exists 判断候选，不检查可执行权限或签名。
fn is_git_bash_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    (normalized.ends_with("/git/bin/bash.exe") || normalized.ends_with("/git/usr/bin/bash.exe"))
        && path.exists()
}
