use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

#[cfg(unix)]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

pub struct PtyLaunchOptions {
    pub exe: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

pub struct PlatformExitStatus {
    pub code: Option<i32>,
    pub description: String,
}

pub trait PlatformPtyController: Send {
    // 请求平台调整字符网格和可选像素尺寸，实际像素支持及范围由平台实现处理。
    fn resize(
        &self,
        cols: u16,
        rows: u16,
        pixel_width: Option<u32>,
        pixel_height: Option<u32>,
    ) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy)]
pub struct PlatformPtyTraits {
    pub uses_conpty_dll: bool,
}

pub trait PlatformPtyChild: Send + Sync {
    // 返回已创建子进程的 PID，不以此方法判断进程仍然存活。
    fn process_id(&self) -> u32;
    // 非阻塞查询退出状态；未退出返回 None，信号终止等情形可能没有数值退出码。
    fn try_wait(&self) -> Result<Option<PlatformExitStatus>, String>;
    // 请求平台终止子进程，不承担等待回收职责；后代清理范围取决于平台实现。
    fn kill(&self) -> Result<(), String>;
}

pub struct SpawnedPty {
    pub writer: Box<dyn Write + Send>,
    pub reader: Box<dyn Read + Send>,
    pub controller: Box<dyn PlatformPtyController>,
    pub child: Arc<dyn PlatformPtyChild>,
    pub traits: PlatformPtyTraits,
}

// 按编译平台创建 PTY，返回分别拥有读写、尺寸控制及子进程管理职责的句柄，不启动上层读取循环。
pub fn spawn(options: PtyLaunchOptions) -> Result<SpawnedPty, String> {
    #[cfg(target_os = "windows")]
    {
        windows::spawn(options)
    }
    #[cfg(unix)]
    {
        unix::spawn(options)
    }
}
