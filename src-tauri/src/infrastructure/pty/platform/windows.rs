use super::{
    PlatformExitStatus, PlatformPtyChild, PlatformPtyController, PlatformPtyTraits,
    PtyLaunchOptions, SpawnedPty,
};
use std::collections::{BTreeMap, HashSet};
use std::ffi::c_void;
use std::fs::File;
use std::mem::{size_of, zeroed};
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, FreeLibrary, GetLastError, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
    HMODULE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::{SECURITY_ATTRIBUTES, TOKEN_DUPLICATE, TOKEN_QUERY};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

const PSEUDOCONSOLE_RESIZE_QUIRK: u32 = 0x2;
const PSEUDOCONSOLE_WIN32_INPUT_MODE: u32 = 0x4;
const CONPTY_KILL_SPAWN_THROTTLE: Duration = Duration::from_millis(250);
const CONPTY_KILL_SPAWN_SPACING: Duration = Duration::from_millis(50);
static LAST_NATIVE_CONPTY_KILL_OR_SPAWN: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

struct OwnedWindowsHandle(HANDLE);

impl OwnedWindowsHandle {
    // 将有效句柄所有权转交 File，跳过本包装析构以避免重复 CloseHandle。
    fn into_file(self) -> File {
        let handle = self.0;
        std::mem::forget(self);
        unsafe { File::from_raw_handle(handle as RawHandle) }
    }
}

struct OwnedEnvironmentBlock(*mut c_void);

impl Drop for OwnedEnvironmentBlock {
    // 释放 CreateEnvironmentBlock 返回的内存，不能用 CloseHandle 或 Rust 分配器释放。
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                DestroyEnvironmentBlock(self.0);
            }
        }
    }
}

impl Drop for OwnedWindowsHandle {
    // 析构时关闭持有的非空 Windows 句柄，忽略关闭错误。
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct WindowsPtyController {
    pseudo_console: HPCON,
    api: ConPtyApi,
}

unsafe impl Send for WindowsPtyController {}

impl Drop for WindowsPtyController {
    // 使用创建时对应的 ConPTY API 关闭伪控制台，随后字段析构再卸载可能持有的 DLL。
    fn drop(&mut self) {
        if self.pseudo_console != 0 {
            unsafe { (self.api.close)(self.pseudo_console) };
        }
    }
}

impl PlatformPtyController for WindowsPtyController {
    // 将字符尺寸转换为 COORD 并调用 ConPTY resize；忽略像素尺寸，负 HRESULT 转为错误。
    fn resize(
        &self,
        cols: u16,
        rows: u16,
        _pixel_width: Option<u32>,
        _pixel_height: Option<u32>,
    ) -> Result<(), String> {
        let result = unsafe {
            (self.api.resize)(
                self.pseudo_console,
                COORD {
                    X: cols as i16,
                    Y: rows as i16,
                },
            )
        };
        if result < 0 {
            return Err(format!(
                "ResizePseudoConsole failed: HRESULT 0x{result:08x}"
            ));
        }
        Ok(())
    }
}

type CreatePseudoConsoleFn =
    unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> i32;
type ResizePseudoConsoleFn = unsafe extern "system" fn(HPCON, COORD) -> i32;
type ClosePseudoConsoleFn = unsafe extern "system" fn(HPCON);

struct ConPtyApi {
    create: CreatePseudoConsoleFn,
    resize: ResizePseudoConsoleFn,
    close: ClosePseudoConsoleFn,
    module: Option<HMODULE>,
}

impl ConPtyApi {
    // 优先加载环境指定 DLL 并要求三个导出齐全，否则释放已加载模块并回退系统 ConPTY API。
    // 路径来源须由启动层控制；此函数不检查路径绝对性、签名或版本。
    fn load() -> Self {
        if let Some(dll_path) = std::env::var_os("CLI_MANAGER_CONPTY_DLL_PATH") {
            let module = unsafe { LoadLibraryW(wide_null(&dll_path.to_string_lossy()).as_ptr()) };
            if !module.is_null() {
                let create =
                    unsafe { GetProcAddress(module, c"CreatePseudoConsole".as_ptr().cast()) };
                let resize =
                    unsafe { GetProcAddress(module, c"ResizePseudoConsole".as_ptr().cast()) };
                let close =
                    unsafe { GetProcAddress(module, c"ClosePseudoConsole".as_ptr().cast()) };
                if let (Some(create), Some(resize), Some(close)) = (create, resize, close) {
                    return Self {
                        create: unsafe { std::mem::transmute(create) },
                        resize: unsafe { std::mem::transmute(resize) },
                        close: unsafe { std::mem::transmute(close) },
                        module: Some(module),
                    };
                }
                unsafe {
                    FreeLibrary(module);
                }
            }
        }
        Self {
            create: CreatePseudoConsole,
            resize: ResizePseudoConsole,
            close: ClosePseudoConsole,
            module: None,
        }
    }

    // 返回是否持有动态加载的 ConPTY 模块，用于选择原生实现的启动/终止节流策略。
    fn uses_dll(&self) -> bool {
        self.module.is_some()
    }
}

impl Drop for ConPtyApi {
    // 释放本实例持有的 DLL 引用；系统内置函数没有模块句柄，不执行卸载。
    fn drop(&mut self) {
        if let Some(module) = self.module.take() {
            unsafe { FreeLibrary(module) };
        }
    }
}

struct WindowsPtyChild {
    process: HANDLE,
    pid: u32,
    uses_conpty_dll: bool,
}

unsafe impl Send for WindowsPtyChild {}
unsafe impl Sync for WindowsPtyChild {}

impl Drop for WindowsPtyChild {
    // 仅释放进程句柄，不主动终止子进程，也不等待退出。
    fn drop(&mut self) {
        if !self.process.is_null() {
            unsafe {
                CloseHandle(self.process);
            }
        }
    }
}

impl PlatformPtyChild for WindowsPtyChild {
    // 返回创建时记录的 PID，不探测进程存活状态。
    fn process_id(&self) -> u32 {
        self.pid
    }

    // 零超时检查进程句柄，只有已触发才读取退出码；其余等待结果（包括失败）当前均返回 None。
    fn try_wait(&self) -> Result<Option<PlatformExitStatus>, String> {
        let wait = unsafe { WaitForSingleObject(self.process, 0) };
        if wait != WAIT_OBJECT_0 {
            return Ok(None);
        }
        let mut exit_code = 0u32;
        if unsafe { GetExitCodeProcess(self.process, &mut exit_code) } == 0 {
            return Err(last_error("GetExitCodeProcess"));
        }
        Ok(Some(PlatformExitStatus {
            code: Some(exit_code as i32),
            description: format!("windows exit code {exit_code}"),
        }))
    }

    // 对原生 ConPTY 先节流，再以退出码 1 终止直接进程；不在此遍历进程树或等待退出。
    fn kill(&self) -> Result<(), String> {
        throttle_native_conpty(self.uses_conpty_dll);
        if unsafe { TerminateProcess(self.process, 1) } == 0 {
            return Err(last_error("TerminateProcess"));
        }
        Ok(())
    }
}

// 创建双管道、ConPTY 和伪控制台启动属性，按合并环境及转义命令行启动进程，再转交各资源所有权。
// 创建失败按阶段关闭已取得资源；成功关闭初始线程句柄，上层负责读取循环及会话生命周期。
pub fn spawn(options: PtyLaunchOptions) -> Result<SpawnedPty, String> {
    let mut input_read: HANDLE = null_mut();
    let mut input_write: HANDLE = null_mut();
    let mut output_read: HANDLE = null_mut();
    let mut output_write: HANDLE = null_mut();
    let mut security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    if unsafe { CreatePipe(&mut input_read, &mut input_write, &mut security, 0) } == 0 {
        return Err(last_error("CreatePipe(input)"));
    }
    let input_read = OwnedWindowsHandle(input_read);
    let input_write = OwnedWindowsHandle(input_write);
    if unsafe { CreatePipe(&mut output_read, &mut output_write, &mut security, 0) } == 0 {
        return Err(last_error("CreatePipe(output)"));
    }
    let output_read = OwnedWindowsHandle(output_read);
    let output_write = OwnedWindowsHandle(output_write);
    unsafe {
        SetHandleInformation(input_write.0, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(output_read.0, HANDLE_FLAG_INHERIT, 0);
    }

    let api = ConPtyApi::load();
    let uses_conpty_dll = api.uses_dll();
    throttle_native_conpty(uses_conpty_dll);
    let mut pseudo_console: HPCON = 0;
    let create_result = unsafe {
        (api.create)(
            COORD {
                X: options.cols as i16,
                Y: options.rows as i16,
            },
            input_read.0,
            output_write.0,
            conpty_creation_flags(),
            &mut pseudo_console,
        )
    };
    if create_result < 0 {
        return Err(format!(
            "CreatePseudoConsole failed: HRESULT 0x{create_result:08x}"
        ));
    }
    drop(input_read);
    drop(output_write);

    let mut attribute_size = 0usize;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
    }
    let word_count = attribute_size.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0usize; word_count];
    let attribute_list = attribute_storage.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0
    {
        unsafe { (api.close)(pseudo_console) };
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    if unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            pseudo_console as *const c_void,
            size_of::<HPCON>(),
            null_mut(),
            null(),
        )
    } == 0
    {
        unsafe {
            DeleteProcThreadAttributeList(attribute_list);
            (api.close)(pseudo_console);
        }
        return Err(last_error("UpdateProcThreadAttribute"));
    }

    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    startup.lpAttributeList = attribute_list;
    let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
    let mut command_line = wide_null(&build_command_line(&options.exe, &options.args));
    let cwd_wide = options.cwd.as_deref().map(wide_null);
    let environment = build_environment_block(&options.env);
    let created = unsafe {
        CreateProcessW(
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            0,
            conpty_process_creation_flags(),
            environment.as_ptr().cast(),
            cwd_wide.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
            &startup.StartupInfo,
            &mut process_info,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    if created == 0 {
        unsafe { (api.close)(pseudo_console) };
        return Err(last_error("CreateProcessW"));
    }
    unsafe { CloseHandle(process_info.hThread) };

    Ok(SpawnedPty {
        writer: Box::new(input_write.into_file()),
        reader: Box::new(output_read.into_file()),
        controller: Box::new(WindowsPtyController {
            pseudo_console,
            api,
        }),
        child: Arc::new(WindowsPtyChild {
            process: process_info.hProcess,
            pid: process_info.dwProcessId,
            uses_conpty_dll,
        }),
        traits: PlatformPtyTraits { uses_conpty_dll },
    })
}

// 仅原生 ConPTY 共用互斥时钟：距前次不足 250ms 时等待剩余时间再加 50ms；DLL 模式直接跳过。
// 持锁等待以串行化并发调用，锁中毒时跳过节流，不阻止创建/终止操作。
fn throttle_native_conpty(uses_conpty_dll: bool) {
    if uses_conpty_dll {
        return;
    }
    let throttle = LAST_NATIVE_CONPTY_KILL_OR_SPAWN.get_or_init(|| Mutex::new(None));
    let Ok(mut last) = throttle.lock() else {
        return;
    };
    if let Some(previous) = *last {
        let elapsed = previous.elapsed();
        if elapsed < CONPTY_KILL_SPAWN_THROTTLE {
            std::thread::sleep(CONPTY_KILL_SPAWN_THROTTLE - elapsed + CONPTY_KILL_SPAWN_SPACING);
        }
    }
    *last = Some(Instant::now());
}

// 保留 ConPTY resize 兼容和 Win32 输入模式标志。
fn conpty_creation_flags() -> u32 {
    PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE
}

// 使用扩展启动属性与 Unicode 环境，刻意不设新进程组以保持 Ctrl+C 控制事件兼容。
fn conpty_process_creation_flags() -> u32 {
    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT
}

// 立即读取当前线程 Win32 错误码并附操作名，调用方需避免中间 API 覆盖错误状态。
fn last_error(operation: &str) -> String {
    let code = unsafe { GetLastError() };
    format!("{operation} failed with Win32 error {code}")
}

// 编码 UTF-16 并追加 NUL 终止符，不拒绝输入内的 NUL，也不做命令行转义。
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

// 刷新用户环境后与宿主及显式覆盖合并，生成排序的 UTF-16 环境块；刷新失败告警并回退宿主环境。
fn build_environment_block(overrides: &std::collections::HashMap<String, String>) -> Vec<u16> {
    let refreshed = match current_user_environment() {
        Ok(environment) => environment,
        Err(err) => {
            log::warn!("refresh Windows environment failed, using daemon environment: {err}");
            Vec::new()
        }
    };
    let environment = merge_environment(std::env::vars(), refreshed, overrides.clone());
    let mut block = Vec::new();
    for (_, (key, value)) in environment {
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

// 用当前进程用户 token 创建非继承环境块并解析；token 和系统分配内存由包装器按作用域释放。
fn current_user_environment() -> Result<Vec<(String, String)>, String> {
    let mut token: HANDLE = null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE,
            &mut token,
        )
    } == 0
    {
        return Err(last_error("OpenProcessToken"));
    }
    let token = OwnedWindowsHandle(token);

    let mut block: *mut c_void = null_mut();
    if unsafe { CreateEnvironmentBlock(&mut block, token.0, 0) } == 0 {
        return Err(last_error("CreateEnvironmentBlock"));
    }
    if block.is_null() {
        return Err("CreateEnvironmentBlock returned an empty environment".to_string());
    }
    let block = OwnedEnvironmentBlock(block);
    Ok(unsafe { parse_environment_block(block.0.cast()) })
}

// 解析双 NUL 终结的 UTF-16 环境块，忽略无法拆键值的条目；调用方保证指针非空且终止前内存可读。
unsafe fn parse_environment_block(mut cursor: *const u16) -> Vec<(String, String)> {
    let mut environment = Vec::new();
    while unsafe { *cursor } != 0 {
        let start = cursor;
        while unsafe { *cursor } != 0 {
            cursor = unsafe { cursor.add(1) };
        }
        let len = unsafe { cursor.offset_from(start) } as usize;
        let entry = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(start, len) });
        if let Some((key, value)) = split_environment_entry(&entry) {
            environment.push((key.to_string(), value.to_string()));
        }
        cursor = unsafe { cursor.add(1) };
    }
    environment
}

// 拆分首个有效等号，兼容 =C: 这类盘符当前目录键；缺分隔符或空键返回 None，值可为空。
fn split_environment_entry(entry: &str) -> Option<(&str, &str)> {
    let separator = if let Some(rest) = entry.strip_prefix('=') {
        rest.find('=').map(|index| index + 1)?
    } else {
        entry.find('=')?
    };
    let key = &entry[..separator];
    (!key.is_empty()).then_some((key, &entry[separator + 1..]))
}

// 按忽略 ASCII 大小写的键合并宿主→刷新→显式覆盖；PATH 刷新值优先补宿主独有项，显式值仍整项替换。
fn merge_environment(
    base: impl IntoIterator<Item = (String, String)>,
    refreshed: impl IntoIterator<Item = (String, String)>,
    overrides: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, (String, String)> {
    let mut environment = BTreeMap::<String, (String, String)>::new();
    for (key, value) in base {
        environment.insert(key.to_ascii_uppercase(), (key, value));
    }

    let base_path = environment.get("PATH").cloned();
    for (key, value) in refreshed {
        environment.insert(key.to_ascii_uppercase(), (key, value));
    }
    if let (Some((_, base_value)), Some((refreshed_key, refreshed_value))) =
        (base_path, environment.get("PATH").cloned())
    {
        environment.insert(
            "PATH".to_string(),
            (
                refreshed_key,
                merge_windows_path(&refreshed_value, &base_value),
            ),
        );
    }

    // Project/provider/hook values are explicit launch overrides and remain authoritative.
    for (key, value) in overrides {
        environment.insert(key.to_ascii_uppercase(), (key, value));
    }
    environment
}

// 新路径项在前，按裁剪空白并转小写的键去重，但输出保留首个原始文本；不规范化路径或过滤空项。
fn merge_windows_path(refreshed: &str, base: &str) -> String {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for entry in refreshed.split(';').chain(base.split(';')) {
        let normalized = entry.trim().to_lowercase();
        if seen.insert(normalized) {
            entries.push(entry);
        }
    }
    entries.join(";")
}

// 逐项转义程序名和参数后以空格连接，供 CreateProcessW 使用，不额外加入 Shell 解析层。
fn build_command_line(exe: &str, args: &[String]) -> String {
    std::iter::once(exe)
        .chain(args.iter().map(String::as_str))
        .map(quote_windows_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

// 对空串、空白或引号参数加双引号，按引号前及尾部位置倍增反斜杠；不是 CMD/PowerShell 脚本转义器。
fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.bytes().any(|byte| matches!(byte, b' ' | b'\t' | b'"')) {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut slashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            quoted.push_str(&"\\".repeat(slashes * 2 + 1));
            quoted.push('"');
            slashes = 0;
            continue;
        }
        quoted.push_str(&"\\".repeat(slashes));
        slashes = 0;
        quoted.push(ch);
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 验证普通参数、含空格参数以及反斜杠加引号参数的 Windows 命令行编码。
    fn quotes_windows_command_line_arguments() {
        assert_eq!(quote_windows_arg("plain"), "plain");
        assert_eq!(quote_windows_arg("two words"), "\"two words\"");
        assert_eq!(quote_windows_arg(r#"a\"b"#), r#""a\\\"b""#);
    }

    #[test]
    // 锁定启动标志不含 CREATE_NEW_PROCESS_GROUP，避免破坏 ConPTY Ctrl+C 行为。
    fn conpty_child_keeps_ctrl_c_process_group_compatible() {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

        assert_eq!(
            conpty_process_creation_flags() & CREATE_NEW_PROCESS_GROUP,
            0
        );
    }

    #[test]
    // 验证创建伪控制台时同时保留尺寸与 Win32 输入两项兼容标志。
    fn conpty_preserves_resize_and_win32_input_compatibility_flags() {
        assert_eq!(
            conpty_creation_flags(),
            PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE
        );
    }

    #[test]
    // 验证不同大小写的同名变量只有一个最终条目，显式启动值优先。
    fn environment_overrides_are_case_insensitive() {
        let environment = merge_environment(
            [("Path".to_string(), "base".to_string())],
            [("path".to_string(), "refreshed".to_string())],
            [("PATH".to_string(), "override".to_string())],
        );
        assert_eq!(environment.len(), 1);
        assert_eq!(
            environment.get("PATH"),
            Some(&("PATH".to_string(), "override".to_string()))
        );
    }

    #[test]
    // 验证刷新 PATH 保持优先顺序，并补回 daemon 独有目录而不重复大小写等价项。
    fn refreshed_path_keeps_daemon_only_entries() {
        let environment = merge_environment(
            [("Path".to_string(), r"C:\daemon-temp;C:\Windows".to_string())],
            [("PATH".to_string(), r"c:\windows;C:\fresh-cli".to_string())],
            [],
        );

        assert_eq!(
            environment.get("PATH"),
            Some(&(
                "PATH".to_string(),
                r"c:\windows;C:\fresh-cli;C:\daemon-temp".to_string()
            ))
        );
    }

    #[test]
    // 验证项目显式 PATH 整体替换刷新与宿主合并结果，不再次自动追加目录。
    fn explicit_path_override_replaces_merged_path() {
        let environment = merge_environment(
            [("Path".to_string(), r"C:\daemon-temp".to_string())],
            [("PATH".to_string(), r"C:\fresh-cli".to_string())],
            [("path".to_string(), r"C:\project-only".to_string())],
        );

        assert_eq!(
            environment.get("PATH"),
            Some(&("path".to_string(), r"C:\project-only".to_string()))
        );
    }

    #[test]
    // 验证普通变量、盘符伪变量及缺等号的无效条目拆分行为。
    fn splits_regular_and_drive_environment_entries() {
        assert_eq!(
            split_environment_entry("Path=C:\\bin"),
            Some(("Path", "C:\\bin"))
        );
        assert_eq!(
            split_environment_entry("=C:=C:\\workspace"),
            Some(("=C:", "C:\\workspace"))
        );
        assert_eq!(split_environment_entry("invalid"), None);
    }

    #[test]
    // 用本地构造的双 NUL 环境块验证多条目及中文值解析，不读取真实环境。
    fn parses_utf16_environment_block() {
        let block: Vec<u16> = "Path=C:\\bin\0UNICODE=\u{503c}\0\0"
            .encode_utf16()
            .collect();

        assert_eq!(
            unsafe { parse_environment_block(block.as_ptr()) },
            vec![
                ("Path".to_string(), "C:\\bin".to_string()),
                ("UNICODE".to_string(), "\u{503c}".to_string()),
            ]
        );
    }
}
