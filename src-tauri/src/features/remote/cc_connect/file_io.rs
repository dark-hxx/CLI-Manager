use super::{
    build_managed_config_with_agent_launch, config_path, data_dir, load_registered_projects,
    now_millis, project_list_path, project_switch_script_path, remote_manager_dir,
    render_project_list, render_project_switch_script, sha256_file, CcConnectProfile, FileSnapshot,
    RemoteCodexLaunch, ResolvedAgentLauncher,
};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

// 将路径转为用户格式，并在 Windows 去除扩展长度前缀。
pub(super) fn user_path_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    let value = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value.into_owned()
    };
    #[cfg(not(target_os = "windows"))]
    let value = value.into_owned();
    value
}

// 去除空白和空值后规范化可执行路径显示形式。
pub(super) fn normalize_executable_path_value(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| user_path_string(Path::new(value)))
}

// 将用户路径转换为配置使用的正斜杠形式。
pub(super) fn config_path_value(path: &Path) -> String {
    user_path_string(path).replace('\\', "/")
}

// 写入并同步同目录临时文件后替换目标，失败时清理临时文件。
pub(super) fn write_file_atomically(
    path: &Path,
    payload: &[u8],
    label: &str,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} parent is missing"))?;
    fs::create_dir_all(parent).map_err(|err| format!("create {label} directory failed: {err}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("cc-connect");
    let temp = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let result = (|| {
        let mut file =
            File::create(&temp).map_err(|err| format!("create temporary {label} failed: {err}"))?;
        file.write_all(payload)
            .map_err(|err| format!("write temporary {label} failed: {err}"))?;
        file.sync_all()
            .map_err(|err| format!("sync temporary {label} failed: {err}"))?;
        replace_file(&temp, path).map_err(|err| format!("replace {label} failed: {err}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

// 已有字节相同时跳过写入，否则执行临时文件替换。
pub(super) fn write_file_atomically_if_changed(
    path: &Path,
    payload: &[u8],
    label: &str,
) -> Result<(), String> {
    if fs::read(path).is_ok_and(|current| current == payload) {
        return Ok(());
    }
    write_file_atomically(path, payload, label)
}

#[cfg(unix)]
// 写入变更后的脚本并确保 Unix 权限为 0755。
pub(super) fn write_executable_file_atomically_if_changed(
    path: &Path,
    payload: &[u8],
    label: &str,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    write_file_atomically_if_changed(path, payload, label)?;
    let metadata =
        fs::metadata(path).map_err(|err| format!("read {label} metadata failed: {err}"))?;
    let mut permissions = metadata.permissions();
    if permissions.mode() & 0o777 != 0o755 {
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)
            .map_err(|err| format!("set {label} executable permissions failed: {err}"))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
// 比较 SHA-256 后按需复制、同步并替换 Windows 目标文件。
pub(super) fn copy_file_atomically_if_changed(
    source: &Path,
    destination: &Path,
    label: &str,
) -> Result<(), String> {
    let source_digest = sha256_file(source)?;
    if destination.is_file()
        && sha256_file(destination)
            .ok()
            .is_some_and(|digest| digest == source_digest)
    {
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| format!("{label} parent is missing"))?;
    fs::create_dir_all(parent).map_err(|err| format!("create {label} directory failed: {err}"))?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("codex.exe");
    let temp = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let result = (|| {
        let mut input =
            File::open(source).map_err(|err| format!("open source {label} failed: {err}"))?;
        let mut output =
            File::create(&temp).map_err(|err| format!("create temporary {label} failed: {err}"))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|err| format!("copy temporary {label} failed: {err}"))?;
        output
            .sync_all()
            .map_err(|err| format!("sync temporary {label} failed: {err}"))?;
        drop(output);
        replace_file(&temp, destination).map_err(|err| format!("replace {label} failed: {err}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(target_os = "windows")]
// 调用 Windows MoveFileExW 替换目标并请求写穿透。
pub(super) fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
// 在非 Windows 平台通过 rename 替换目标文件。
pub(super) fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|err| err.to_string())
}

// 以无额外启动覆盖的配置生成路径写入托管配置。
pub(super) fn write_managed_config(profile: &CcConnectProfile) -> Result<PathBuf, String> {
    write_managed_config_with_codex(profile, None)
}

// 携带可选 Codex 启动配置转交完整托管写入入口。
pub(super) fn write_managed_config_with_codex(
    profile: &CcConnectProfile,
    codex_launch: Option<&RemoteCodexLaunch>,
) -> Result<PathBuf, String> {
    write_managed_config_with_agent_launch(profile, codex_launch, None, None, &BTreeMap::new())
}

// 生成配置、项目清单与切换脚本，任一写入失败时恢复三个快照。
pub(super) fn write_managed_config_with_agent_launch(
    profile: &CcConnectProfile,
    codex_launch: Option<&RemoteCodexLaunch>,
    agent_launcher: Option<&ResolvedAgentLauncher>,
    claude_settings_path: Option<&Path>,
    additional_agent_environment: &BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    let dir = remote_manager_dir()?;
    fs::create_dir_all(&dir).map_err(|err| format!("create remote manager dir failed: {err}"))?;
    fs::create_dir_all(data_dir()?)
        .map_err(|err| format!("create cc-connect data dir failed: {err}"))?;
    let path = config_path()?;
    let list_path = project_list_path()?;
    let switch_script_path = project_switch_script_path()?;
    let registered_projects = load_registered_projects(Some(profile))?;
    let cli_manager_executable = std::env::current_exe()
        .map_err(|err| format!("resolve CLI-Manager executable failed: {err}"))?;
    let payload = toml::to_string_pretty(&build_managed_config_with_agent_launch(
        profile,
        &list_path,
        &switch_script_path,
        codex_launch,
        agent_launcher,
        claude_settings_path,
        additional_agent_environment,
    )?)
    .map_err(|err| format!("serialize cc-connect config failed: {err}"))?;
    let list_payload = render_project_list(profile, &registered_projects);
    let switch_script_payload =
        render_project_switch_script(profile, &registered_projects, &cli_manager_executable)?;
    let config_snapshot = FileSnapshot::capture(path.clone(), "cc-connect config")?;
    let list_snapshot = FileSnapshot::capture(list_path.clone(), "CLI-Manager project list")?;
    let switch_script_snapshot = FileSnapshot::capture(
        switch_script_path.clone(),
        "CLI-Manager project switch script",
    )?;
    if let Err(write_error) = (|| {
        write_file_atomically(
            &list_path,
            list_payload.as_bytes(),
            "CLI-Manager project list",
        )?;
        write_file_atomically_if_changed(
            &switch_script_path,
            switch_script_payload.as_bytes(),
            "CLI-Manager project switch script",
        )?;
        write_file_atomically(&path, payload.as_bytes(), "cc-connect config")
    })() {
        let mut rollback_errors = Vec::new();
        if let Err(err) = config_snapshot.restore() {
            rollback_errors.push(err);
        }
        if let Err(err) = list_snapshot.restore() {
            rollback_errors.push(err);
        }
        if let Err(err) = switch_script_snapshot.restore() {
            rollback_errors.push(err);
        }
        return if rollback_errors.is_empty() {
            Err(write_error)
        } else {
            Err(format!(
                "{write_error}; rollback failed: {}",
                rollback_errors.join("; ")
            ))
        };
    }
    Ok(path)
}
