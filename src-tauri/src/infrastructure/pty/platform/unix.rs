use super::{
    PlatformExitStatus, PlatformPtyChild, PlatformPtyController, PlatformPtyTraits,
    PtyLaunchOptions, SpawnedPty,
};
use nix::pty::{openpty, Winsize};
use nix::sys::signal::{killpg, Signal};
use nix::unistd::{dup, Pid};
use std::fs::File;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

struct UnixPtyController {
    master: OwnedFd,
}

impl PlatformPtyController for UnixPtyController {
    // 通过主端 TIOCSWINSZ 更新网格，像素尺寸缺失用零、超出 u16 时截上限，ioctl 失败向上传播。
    fn resize(
        &self,
        cols: u16,
        rows: u16,
        pixel_width: Option<u32>,
        pixel_height: Option<u32>,
    ) -> Result<(), String> {
        let size = nix::libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: pixel_width.unwrap_or(0).min(u16::MAX.into()) as u16,
            ws_ypixel: pixel_height.unwrap_or(0).min(u16::MAX.into()) as u16,
        };
        let result =
            unsafe { nix::libc::ioctl(self.master.as_raw_fd(), nix::libc::TIOCSWINSZ, &size) };
        if result == -1 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
}

struct UnixPtyChild {
    child: Mutex<Child>,
    pid: u32,
}

impl PlatformPtyChild for UnixPtyChild {
    // 返回启动时记录的 PID，不额外读取系统进程状态。
    fn process_id(&self) -> u32 {
        self.pid
    }

    // 持锁非阻塞检查子进程退出，将原生状态转换为共享结构，信号退出保留空 code 和描述。
    fn try_wait(&self) -> Result<Option<PlatformExitStatus>, String> {
        self.child
            .lock()
            .map_err(|_| "pty child lock poisoned".to_string())?
            .try_wait()
            .map(|status| {
                status.map(|status| PlatformExitStatus {
                    code: status.code(),
                    description: format!("{status:?}"),
                })
            })
            .map_err(|err| err.to_string())
    }

    // 先尽力 SIGKILL 整个进程组，再持锁终止直接子进程；组终止错误忽略，不在此等待回收。
    fn kill(&self) -> Result<(), String> {
        let _ = killpg(Pid::from_raw(self.pid as i32), Signal::SIGKILL);
        self.child
            .lock()
            .map_err(|_| "pty child lock poisoned".to_string())?
            .kill()
            .map_err(|err| err.to_string())
    }
}

// 创建 PTY 对并为读/写/控制复制独立主端句柄；子进程执行前恢复信号、建立会话与控制终端、连接标准流。
// 父进程关闭原始两端并返回独立句柄，环境覆盖继承自宿主环境；不在此启动 IO 线程或等待退出。
pub fn spawn(options: PtyLaunchOptions) -> Result<SpawnedPty, String> {
    let size = Winsize {
        ws_row: options.rows,
        ws_col: options.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pair = openpty(Some(&size), None).map_err(|err| err.to_string())?;
    set_close_on_exec(pair.master.as_raw_fd())?;
    set_close_on_exec(pair.slave.as_raw_fd())?;
    let reader_fd = dup(&pair.master).map_err(|err| err.to_string())?;
    let writer_fd = dup(&pair.master).map_err(|err| err.to_string())?;
    let controller_fd = dup(&pair.master).map_err(|err| err.to_string())?;
    set_close_on_exec(reader_fd.as_raw_fd())?;
    set_close_on_exec(writer_fd.as_raw_fd())?;
    set_close_on_exec(controller_fd.as_raw_fd())?;
    let slave_fd = pair.slave.as_raw_fd();

    let mut command = Command::new(&options.exe);
    command.args(&options.args);
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    command.envs(&options.env);
    unsafe {
        command.pre_exec(move || {
            for signal in [
                nix::libc::SIGCHLD,
                nix::libc::SIGHUP,
                nix::libc::SIGINT,
                nix::libc::SIGQUIT,
                nix::libc::SIGTERM,
                nix::libc::SIGALRM,
            ] {
                nix::libc::signal(signal, nix::libc::SIG_DFL);
            }
            let mut empty_set: nix::libc::sigset_t = std::mem::zeroed();
            if nix::libc::sigemptyset(&mut empty_set) == -1
                || nix::libc::sigprocmask(nix::libc::SIG_SETMASK, &empty_set, std::ptr::null_mut())
                    == -1
            {
                return Err(std::io::Error::last_os_error());
            }
            if nix::libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if nix::libc::ioctl(slave_fd, nix::libc::TIOCSCTTY.into(), 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            for target in [
                nix::libc::STDIN_FILENO,
                nix::libc::STDOUT_FILENO,
                nix::libc::STDERR_FILENO,
            ] {
                if nix::libc::dup2(slave_fd, target) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            if slave_fd > nix::libc::STDERR_FILENO {
                nix::libc::close(slave_fd);
            }
            Ok(())
        });
    }
    let child = command.spawn().map_err(|err| err.to_string())?;
    let pid = child.id();
    drop(pair.slave);
    drop(pair.master);

    Ok(SpawnedPty {
        writer: Box::new(File::from(writer_fd)),
        reader: Box::new(File::from(reader_fd)),
        controller: Box::new(UnixPtyController {
            master: controller_fd,
        }),
        child: Arc::new(UnixPtyChild {
            child: Mutex::new(child),
            pid,
        }),
        traits: PlatformPtyTraits {
            uses_conpty_dll: false,
        },
    })
}

// 在保留原描述符标志的基础上设置 FD_CLOEXEC，防止无关 exec 继承 PTY 句柄；不取得 fd 所有权。
fn set_close_on_exec(fd: RawFd) -> Result<(), String> {
    let flags = unsafe { nix::libc::fcntl(fd, nix::libc::F_GETFD) };
    if flags == -1 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if unsafe { nix::libc::fcntl(fd, nix::libc::F_SETFD, flags | nix::libc::FD_CLOEXEC) } == -1 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
