//! PTY 守护进程（Issue #123 Phase 2）。
//!
//! 契约见 `.trellis/spec/backend/pty-daemon-contracts.md`：
//! - UI 进程是客户端，daemon 持有 PTY 会话与 scrollback，应用退出后任务续跑；
//! - 仅监听 127.0.0.1，首帧 token 鉴权，NDJSON 帧；
//! - 无会话且无客户端 10 分钟自灭，物理防孤儿（Job Object / 进程组）。

pub mod client;
pub mod discovery;
pub mod protocol;
pub mod server;
mod ssh_agent_bridge;

/// 进程治理兜底（契约★）：Windows 上把 daemon 自身挂进
/// `KILL_ON_JOB_CLOSE` 的 Job Object——之后 daemon 创建的全部 PTY 子进程
/// 自动进入同一 Job，daemon 无论正常退出还是被强杀，系统都会回收整棵
/// 子进程树，物理杜绝 PTY 孤儿。非 Windows 平台为 no-op（PTY 子进程随
/// 会话关闭由平台 PTY 控制器回收；daemon 自身 detach 由拉起方处理）。
pub fn setup_process_governance() {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            log::warn!("daemon job object create failed, orphan protection disabled");
            return;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            log::warn!("daemon job object configure failed, orphan protection disabled");
            return;
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            log::warn!("daemon job object assign failed, orphan protection disabled");
            return;
        }
        // 故意不 CloseHandle：Job 句柄与 daemon 进程同生共死，
        // 进程终止时句柄关闭触发 KILL_ON_JOB_CLOSE 清理全部子进程。
        log::debug!("daemon job object active (kill-on-close)");
    }
}
