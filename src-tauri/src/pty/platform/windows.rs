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
    fn into_file(self) -> File {
        let handle = self.0;
        std::mem::forget(self);
        unsafe { File::from_raw_handle(handle as RawHandle) }
    }
}

struct OwnedEnvironmentBlock(*mut c_void);

impl Drop for OwnedEnvironmentBlock {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                DestroyEnvironmentBlock(self.0);
            }
        }
    }
}

impl Drop for OwnedWindowsHandle {
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
    fn drop(&mut self) {
        if self.pseudo_console != 0 {
            unsafe { (self.api.close)(self.pseudo_console) };
        }
    }
}

impl PlatformPtyController for WindowsPtyController {
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

    fn uses_dll(&self) -> bool {
        self.module.is_some()
    }
}

impl Drop for ConPtyApi {
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
    fn drop(&mut self) {
        if !self.process.is_null() {
            unsafe {
                CloseHandle(self.process);
            }
        }
    }
}

impl PlatformPtyChild for WindowsPtyChild {
    fn process_id(&self) -> u32 {
        self.pid
    }

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

    fn kill(&self) -> Result<(), String> {
        throttle_native_conpty(self.uses_conpty_dll);
        if unsafe { TerminateProcess(self.process, 1) } == 0 {
            return Err(last_error("TerminateProcess"));
        }
        Ok(())
    }
}

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

fn conpty_creation_flags() -> u32 {
    PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE
}

fn conpty_process_creation_flags() -> u32 {
    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT
}

fn last_error(operation: &str) -> String {
    let code = unsafe { GetLastError() };
    format!("{operation} failed with Win32 error {code}")
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

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

fn split_environment_entry(entry: &str) -> Option<(&str, &str)> {
    let separator = if let Some(rest) = entry.strip_prefix('=') {
        rest.find('=').map(|index| index + 1)?
    } else {
        entry.find('=')?
    };
    let key = &entry[..separator];
    (!key.is_empty()).then_some((key, &entry[separator + 1..]))
}

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

fn build_command_line(exe: &str, args: &[String]) -> String {
    std::iter::once(exe)
        .chain(args.iter().map(String::as_str))
        .map(quote_windows_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

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
    fn quotes_windows_command_line_arguments() {
        assert_eq!(quote_windows_arg("plain"), "plain");
        assert_eq!(quote_windows_arg("two words"), "\"two words\"");
        assert_eq!(quote_windows_arg(r#"a\"b"#), r#""a\\\"b""#);
    }

    #[test]
    fn conpty_child_keeps_ctrl_c_process_group_compatible() {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

        assert_eq!(
            conpty_process_creation_flags() & CREATE_NEW_PROCESS_GROUP,
            0
        );
    }

    #[test]
    fn conpty_preserves_resize_and_win32_input_compatibility_flags() {
        assert_eq!(
            conpty_creation_flags(),
            PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE
        );
    }

    #[test]
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
