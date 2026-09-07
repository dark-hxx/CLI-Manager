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
    fn process_id(&self) -> u32;
    fn try_wait(&self) -> Result<Option<PlatformExitStatus>, String>;
    fn kill(&self) -> Result<(), String>;
}

pub struct SpawnedPty {
    pub writer: Box<dyn Write + Send>,
    pub reader: Box<dyn Read + Send>,
    pub controller: Box<dyn PlatformPtyController>,
    pub child: Arc<dyn PlatformPtyChild>,
    pub traits: PlatformPtyTraits,
}

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
