//! 用户级共享 Hook：状态检查只读，写入只接收本机或一个明确的 WSL 发行版。
use base64::{engine::general_purpose::STANDARD, Engine};
use cli_manager_hook_schema::antigravity::EVENTS;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;

#[path = "antigravity_scope.rs"]
mod scope;
use scope::Scope;

#[path = "antigravity_document.rs"]
mod document;

const OWNER: &str = "cli-manager-antigravity";
const HOOK_TIMEOUT_SECS: u64 = 10;
const PS_ENCODED_FLAGS: &str = " -NoLogo -NoProfile -NonInteractive -EncodedCommand ";
const PS_PREAMBLE: &str = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';";
const PS_BODY_PREFIX: &str = "$s=[Diagnostics.ProcessStartInfo]::new();$s.UseShellExecute=$false;\
$s.FileName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('";
static MUTATION: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    NotInstalled,
    Installed,
    PartialInstalled,
    Conflict,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    status: Status,
    config_path: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Inspect,
    Install,
    Uninstall,
}

pub(super) fn strip_windows_verbatim(exe: &str) -> String {
    if let Some(rest) = exe.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = exe.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        exe.to_string()
    }
}

fn is_simple_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"\\:._-".contains(b))
}

fn is_windows_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || (path.starts_with(r"\\") && path.len() > 2 && !path[2..].starts_with('\\'))
}

fn is_cli_manager_binary_name(path: &str) -> bool {
    !path.split(['/', '\\']).any(|segment| segment == "..")
        && path.rsplit(['/', '\\']).next().is_some_and(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "cli-manager" | "cli-manager.exe"
            )
        })
}

fn unescape_posix_single_quoted(value: &str) -> Option<String> {
    let inner = value.strip_prefix('\'')?.strip_suffix('\'')?;
    let mut out = String::with_capacity(inner.len());
    let mut rest = inner;
    while let Some(idx) = rest.find('\'') {
        out.push_str(&rest[..idx]);
        rest = rest[idx..].strip_prefix("'\\''")?;
        out.push('\'');
    }
    out.push_str(rest);
    Some(out)
}

fn is_owned_windows_powershell_command(cmd: &str, expected_args: &str) -> bool {
    let Some((ps_exe, encoded)) = cmd.split_once(PS_ENCODED_FLAGS) else {
        return false;
    };
    if encoded.is_empty()
        || encoded.contains(char::is_whitespace)
        || !is_windows_absolute_path(ps_exe)
        || !ps_exe
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"\\/:._-".contains(&b))
        || !ps_exe
            .replace('/', "\\")
            .to_ascii_lowercase()
            .ends_with(r"\system32\windowspowershell\v1.0\powershell.exe")
    {
        return false;
    }
    let Ok(bytes) = STANDARD.decode(encoded) else {
        return false;
    };
    if bytes.is_empty() || bytes.len() % 2 != 0 {
        return false;
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let Ok(script) = String::from_utf16(&units) else {
        return false;
    };
    let body = script.strip_prefix(PS_PREAMBLE).unwrap_or(&script);
    let suffix = format!(
        "'));$s.Arguments='{expected_args}';$p=[Diagnostics.Process]::Start($s);$p.WaitForExit();exit $p.ExitCode"
    );
    let Some(b64_exe) = body
        .strip_prefix(PS_BODY_PREFIX)
        .and_then(|rest| rest.strip_suffix(&suffix))
    else {
        return false;
    };
    let Ok(exe_bytes) = STANDARD.decode(b64_exe) else {
        return false;
    };
    let Ok(exe_raw) = String::from_utf8(exe_bytes) else {
        return false;
    };
    let exe = strip_windows_verbatim(&exe_raw);
    !exe.is_empty()
        && !exe.chars().any(char::is_control)
        && is_windows_absolute_path(&exe)
        && is_cli_manager_binary_name(&exe)
}

fn is_owned_command(cmd: &str, event: &str, windows: bool, distro: Option<&str>) -> bool {
    let expected_args = format!("__hook --source antigravity --event {event}");
    if windows && distro.is_none() {
        let suffix = format!(" {expected_args}");
        if let Some(exe) = cmd.strip_suffix(&suffix) {
            let native = exe.replace('/', "\\");
            if is_simple_windows_drive_path(&native) && is_cli_manager_binary_name(&native) {
                return true;
            }
        }
        return is_owned_windows_powershell_command(cmd, &expected_args);
    }
    let suffix = match distro {
        Some(name) => format!(
            " {expected_args} --agy-wsl-distro {}",
            super::escape_posix_single_quoted(name)
        ),
        None => format!(" {expected_args}"),
    };
    let Some(quoted) = cmd.strip_suffix(&suffix) else {
        return false;
    };
    let Some(exe) = unescape_posix_single_quoted(quoted) else {
        return false;
    };
    exe.starts_with('/') && !exe.chars().any(char::is_control) && is_cli_manager_binary_name(&exe)
}

fn is_owned_event_handlers(
    event: &str,
    value: &Value,
    windows: bool,
    distro: Option<&str>,
) -> bool {
    let Some([handler]) = value.as_array().map(Vec::as_slice) else {
        return false;
    };
    let Some(map) = handler.as_object() else {
        return false;
    };
    if !map
        .keys()
        .all(|k| matches!(k.as_str(), "type" | "command" | "timeout"))
    {
        return false;
    }
    if map.get("type").and_then(Value::as_str) != Some("command") {
        return false;
    }
    if map
        .get("timeout")
        .is_some_and(|v| !v.as_u64().is_some_and(|n| n > 0))
    {
        return false;
    }
    map.get("command")
        .and_then(Value::as_str)
        .is_some_and(|cmd| is_owned_command(cmd, event, windows, distro))
}

// Windows 简单盘符路径保留原生反斜杠不加引号；含空格/UNC/特殊字符时转义为固定 PowerShell argv，兼容旧 agy 的双引号问题。
// 编码的只是安装时的可执行路径和固定事件，不含 stdin、token 或用户命令。
fn hook_command(exe: &str, event: &str, windows: bool) -> Result<String, String> {
    const BAD_PATH: &str = "antigravity_hook_path_unsupported";
    if !EVENTS.contains(&event) || exe.is_empty() || exe.chars().any(char::is_control) {
        return Err(BAD_PATH.into());
    }
    let args = format!("__hook --source antigravity --event {event}");
    if windows {
        let stripped = strip_windows_verbatim(exe);
        let native = stripped.replace('/', "\\");
        if is_simple_windows_drive_path(&native) {
            return Ok(format!("{native} {args}"));
        }
        // 只使用系统 PowerShell，不从项目 cwd/PATH 解析。路径是数据，不拼入脚本语法；子进程原样继承管道。
        let ps = std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or(BAD_PATH)?)
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let path = ps.to_str().ok_or(BAD_PATH)?;
        if !ps.is_absolute() || !ps.is_file() || !is_simple_windows_drive_path(path) {
            return Err(BAD_PATH.into());
        }
        let script = format!(
            "{PS_PREAMBLE}{PS_BODY_PREFIX}{}'));$s.Arguments='{args}';\
            $p=[Diagnostics.Process]::Start($s);$p.WaitForExit();exit $p.ExitCode",
            STANDARD.encode(stripped.as_bytes())
        );
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let line = format!("{path}{PS_ENCODED_FLAGS}{encoded}");
        return (line.len() <= 8191)
            .then_some(line)
            .ok_or_else(|| BAD_PATH.into());
    }
    Ok(format!("{} {args}", super::escape_posix_single_quoted(exe)))
}

// agy 非工具事件使用直接 handler 数组；没有审批、工具参数或注入步骤。
fn desired_definition(exe: &str, windows: bool, distro: Option<&str>) -> Result<Value, String> {
    let mut definition = json!({});
    for event in EVENTS {
        let mut command = hook_command(exe, event, windows)?;
        if let Some(name) = distro {
            command.push_str(" --agy-wsl-distro ");
            command.push_str(&super::escape_posix_single_quoted(name));
        }
        definition[event] =
            json!([{ "type":"command", "command":command, "timeout":HOOK_TIMEOUT_SECS }]);
    }
    Ok(definition)
}

// 所有现有字段均须是本应用托管的 handler；过时路径/超时/格式归为 PartialInstalled 以便修复或卸载，外部命令仍报 Conflict。
fn status(owned: Option<Value>, desired: &Value, windows: bool, distro: Option<&str>) -> Status {
    let Some(owned) = owned else {
        return Status::NotInstalled;
    };
    let Some(fields) = owned.as_object() else {
        return Status::Conflict;
    };
    let mut count = 0;
    let mut all_exact = true;
    for (key, value) in fields {
        if key == "enabled" && value.is_boolean() {
            continue;
        }
        if !EVENTS.contains(&key.as_str()) {
            return Status::Conflict;
        }
        if desired.get(key) == Some(value) {
            count += 1;
            continue;
        }
        if !is_owned_event_handlers(key, value, windows, distro) {
            return Status::Conflict;
        }
        all_exact = false;
        count += 1;
    }
    if count == 0 {
        Status::Conflict
    } else if all_exact
        && count == EVENTS.len()
        && owned.get("enabled").and_then(Value::as_bool) != Some(false)
    {
        Status::Installed
    } else {
        Status::PartialInstalled
    }
}

// 非法文档及同名外部项均只返回 conflict。重复安装/卸载不触碰文件，写入前再次比对原文。
fn apply(scope: &Scope, action: Action) -> Result<HookStatus, String> {
    let _guard = if action == Action::Inspect {
        None
    } else {
        Some(MUTATION.lock().map_err(|_| "antigravity_hook_busy")?)
    };
    let before = scope.read()?;
    let Some(doc) = document::Document::parse(before.as_deref().unwrap_or(b"{}\n")) else {
        return Ok(HookStatus {
            status: Status::Conflict,
            config_path: scope.config_display(),
        });
    };
    let desired = desired_definition(&scope.exe, scope.windows_native, scope.distro())?;
    let old = status(doc.owned(), &desired, scope.windows_native, scope.distro());
    let new = match (action, old) {
        (Action::Install, Status::NotInstalled | Status::PartialInstalled) => {
            scope.publish(before.as_deref(), &doc.replace(Some(&desired))?)?;
            Status::Installed
        }
        (Action::Uninstall, Status::Installed | Status::PartialInstalled) => {
            scope.publish(before.as_deref(), &doc.replace(None)?)?;
            Status::NotInstalled
        }
        _ => old,
    };
    Ok(HookStatus {
        status: new,
        config_path: scope.config_display(),
    })
}

// WSL 探测、文件访问可能阻塞，不能占据 IPC/UI 线程。
async fn command(distro: Option<String>, action: Action) -> Result<HookStatus, String> {
    tauri::async_runtime::spawn_blocking(move || apply(&Scope::resolve(distro.as_deref())?, action))
        .await
        .map_err(|_| "antigravity_hook_worker_failed".to_string())?
}

// 只读发现，不创建配置目录或自动修复。
#[tauri::command]
pub async fn hook_settings_get_status_antigravity(
    wsl_distro: Option<String>,
) -> Result<HookStatus, String> {
    command(wsl_distro, Action::Inspect).await
}

// 显式启用时只添加/补齐属于本安装的三个观测点。
#[tauri::command]
pub async fn hook_settings_install_antigravity(
    wsl_distro: Option<String>,
) -> Result<HookStatus, String> {
    command(wsl_distro, Action::Install).await
}

// 显式卸载时保留所有第三方定义，冲突只报告不清理。
#[tauri::command]
pub async fn hook_settings_uninstall_antigravity(
    wsl_distro: Option<String>,
) -> Result<HookStatus, String> {
    command(wsl_distro, Action::Uninstall).await
}

#[cfg(test)]
#[path = "antigravity_process_tests.rs"]
mod process_tests;
#[cfg(test)]
#[path = "antigravity_tests.rs"]
mod tests;
