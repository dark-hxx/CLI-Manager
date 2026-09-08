use crate::{app_paths, shell_resolver, wsl};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LOCAL_ENVIRONMENT_ID: &str = "host";
const WSL_HOME_DETECT_TIMEOUT: Duration = Duration::from_secs(30);
const WSL_HOME_VALIDATION_TIMEOUT: Duration = Duration::from_secs(5);
const WSL_DISTRO_LIST_TIMEOUT: Duration = Duration::from_secs(5);
const ACTIVE_HOME_IDENTITY_SETTING: &str = "active_provider_home_identity";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeSelectInput {
    pub environment_kind: String,
    pub environment_id: Option<String>,
    pub mode: String,
    pub home_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeIdentity {
    pub environment_kind: String,
    pub environment_id: String,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DerivedCliTargets {
    pub home_path: String,
    pub claude_config_dir: String,
    pub claude_history_root: String,
    pub codex_config_dir: String,
    pub codex_history_root: String,
    pub grok_config_dir: String,
    pub grok_history_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHomeState {
    pub identity: HomeIdentity,
    pub mode: String,
    pub home_path: String,
    pub source: String,
    pub targets: DerivedCliTargets,
}

#[derive(Debug, Clone)]
struct NormalizedHomeInput {
    environment_kind: String,
    environment_id: String,
    mode: String,
    home_path: Option<String>,
}

static HOME_CACHE: OnceLock<RwLock<HashMap<String, ProviderHomeState>>> = OnceLock::new();
static ACTIVE_HOME_IDENTITY: OnceLock<RwLock<Option<String>>> = OnceLock::new();

// 惰性初始化全局 Home 状态映射及读写锁，不主动加载数据库。
fn cache() -> &'static RwLock<HashMap<String, ProviderHomeState>> {
    HOME_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

// 惰性初始化活动 Home 身份的独立读写锁，初始为空。
fn active_home_identity() -> &'static RwLock<Option<String>> {
    ACTIVE_HOME_IDENTITY.get_or_init(|| RwLock::new(None))
}

// 返回饱和到 i64 上限的 Unix 毫秒时间，早于纪元时回退零。
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

// 从探测输出前两行提取发行版与 Linux Home，拒绝空发行版或不合法路径，忽略后续行。
fn parse_default_wsl_context(stdout: &[u8]) -> Result<(String, String), String> {
    let stdout = String::from_utf8_lossy(stdout);
    let mut lines = stdout.lines();
    let distro = lines.next().map(str::trim).unwrap_or_default();
    let home = lines.next().map(str::trim).unwrap_or_default();
    if distro.is_empty() || !is_valid_linux_home_path(home) {
        return Err("provider_wsl_probe_failed".to_string());
    }
    Ok((distro.to_string(), home.to_string()))
}

// 在默认 WSL 发行版登录 shell 探测发行版名与 HOME，使用三十秒超时并解析结果。
fn default_wsl_context() -> Result<(String, String), String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command.args([
        "--exec",
        "sh",
        "-lc",
        r#"printf '%s\n%s' "$WSL_DISTRO_NAME" "$HOME""#,
    ]);
    let output = shell_resolver::output_with_timeout(command, WSL_HOME_DETECT_TIMEOUT)
        .map_err(|_| "provider_wsl_probe_failed".to_string())?;
    if !output.status.success() {
        return Err("provider_wsl_probe_failed".to_string());
    }
    parse_default_wsl_context(&output.stdout)
}

// 依据 BOM 或双字节高位全零启发式解码 UTF-16LE，否则容错解码 UTF-8；UTF-16 分支忽略尾部不完整字节。
fn decode_wsl_output(stdout: &[u8]) -> String {
    let is_utf16le = stdout.starts_with(&[0xff, 0xfe])
        || (stdout.len() >= 4 && stdout.chunks_exact(2).all(|chunk| chunk[1] == 0));
    if !is_utf16le {
        return String::from_utf8_lossy(stdout).into_owned();
    }

    let bytes = stdout.strip_prefix(&[0xff, 0xfe]).unwrap_or(stdout);
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
    String::from_utf16_lossy(&units.collect::<Vec<_>>())
}

// 解码列表后去空白、BOM 和默认项标记，跳过固定英文表头，保留重复发行版名。
fn parse_wsl_distros(stdout: &[u8]) -> Vec<String> {
    decode_wsl_output(stdout)
        .lines()
        .filter_map(|line| {
            let distro = line
                .trim()
                .trim_start_matches('\u{feff}')
                .trim_start_matches("* ")
                .trim();
            if distro.is_empty()
                || distro.eq_ignore_ascii_case("windows subsystem for linux distributions:")
            {
                None
            } else {
                Some(distro.to_string())
            }
        })
        .collect()
}

// 以五秒超时执行 wsl -l -q 并解析列表，不附加 Home 探测。
pub(crate) fn list_wsl_distros() -> Result<Vec<String>, String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command.args(["-l", "-q"]);
    let output = shell_resolver::output_with_timeout(command, WSL_DISTRO_LIST_TIMEOUT)
        .map_err(|_| "provider_wsl_list_failed".to_string())?;
    if !output.status.success() {
        return Err("provider_wsl_list_failed".to_string());
    }
    Ok(parse_wsl_distros(&output.stdout))
}

// 优先非 host 的显式发行版，其次手动 UNC 中的发行版，否则探测默认 WSL 上下文。
fn resolve_wsl_environment_id(input: &HomeSelectInput) -> Result<String, String> {
    let requested = input.environment_id.as_deref().unwrap_or_default().trim();
    if !requested.is_empty() && !requested.eq_ignore_ascii_case(LOCAL_ENVIRONMENT_ID) {
        return Ok(requested.to_string());
    }
    if let Some((distro, _)) = input.home_path.as_deref().and_then(wsl::parse_wsl_unc_path) {
        return Ok(distro);
    }
    default_wsl_context().map(|(distro, _)| distro)
}

// 规范化环境与模式，本机固定 host；WSL 身份解析可能触发探测，手动模式要求非空路径但不在此验证目录。
fn normalize_input(input: HomeSelectInput) -> Result<NormalizedHomeInput, String> {
    let environment_kind = input.environment_kind.trim().to_ascii_lowercase();
    if environment_kind != "local" && environment_kind != "wsl" {
        return Err("provider_environment_invalid".to_string());
    }
    let environment_id = if environment_kind == "local" {
        LOCAL_ENVIRONMENT_ID.to_string()
    } else {
        resolve_wsl_environment_id(&input)?
    };
    if environment_id.is_empty() {
        return Err("provider_environment_id_required".to_string());
    }
    let mode = input.mode.trim().to_ascii_lowercase();
    if mode != "auto" && mode != "manual" {
        return Err("provider_home_mode_invalid".to_string());
    }
    let home_path = input
        .home_path
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string());
    if mode == "manual" && home_path.is_none() {
        return Err("provider_home_path_required".to_string());
    }
    Ok(NormalizedHomeInput {
        environment_kind,
        environment_id,
        mode,
        home_path,
    })
}

// 按环境种类与 ID 构建身份字段及冒号拼接的缓存键。
fn identity(kind: &str, id: &str) -> HomeIdentity {
    HomeIdentity {
        environment_kind: kind.to_string(),
        environment_id: id.to_string(),
        identity: format!("{kind}:{id}"),
    }
}

// 拒绝末级名称为 .claude/.codex/.grok 的路径，要求选择其父 Home。
fn reject_cli_subdirectory(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(name.as_str(), ".claude" | ".codex" | ".grok") {
        return Err("provider_home_must_be_parent_directory".to_string());
    }
    Ok(())
}

// 拒绝 WSL UNC、相对路径、CLI 子目录和非目录，再创建并删除独占探测文件验证可写性；删除失败也返回不可写。
fn validate_local_home(raw: &str) -> Result<PathBuf, String> {
    if wsl::parse_wsl_unc_path(raw).is_some() {
        return Err("provider_home_environment_mismatch".to_string());
    }
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err("provider_home_invalid".to_string());
    }
    reject_cli_subdirectory(&path)?;
    if !path.is_dir() {
        return Err("provider_home_invalid".to_string());
    }
    let probe = path.join(format!(".cli-manager-home-probe-{}", now_millis()));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| "provider_home_not_writable".to_string())?;
    fs::remove_file(probe).map_err(|_| "provider_home_not_writable".to_string())?;
    Ok(path)
}

// 构造指定发行版的直接程序调用，逐项传递参数，不立即执行。
fn wsl_command(
    distro: &str,
    program: &str,
    args: &[&str],
) -> Result<std::process::Command, String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg(program)
        .args(args);
    Ok(command)
}

// 以五秒超时执行 WSL 校验命令，执行错误映射为探测失败，退出状态由调用方检查。
fn run_wsl(distro: &str, program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let command = wsl_command(distro, program, args)?;
    shell_resolver::output_with_timeout(command, WSL_HOME_VALIDATION_TIMEOUT)
        .map_err(|_| "provider_wsl_probe_failed".to_string())
}

// 在指定发行版登录 shell 读取 HOME，使用较长的三十秒检测超时。
fn probe_wsl_home(distro: &str) -> Result<std::process::Output, String> {
    let command = wsl_command(distro, "sh", &["-lc", "printf '%s' \"$HOME\""])?;
    shell_resolver::output_with_timeout(command, WSL_HOME_DETECT_TIMEOUT)
        .map_err(|_| "provider_wsl_probe_failed".to_string())
}

// 仅做 Linux 路径文本校验，要求非根绝对路径且无 NUL/换行及点路径段，不访问文件系统。
fn is_valid_linux_home_path(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() || path == "/" || !path.starts_with('/') {
        return false;
    }
    if path.contains('\0') || path.contains('\r') || path.contains('\n') {
        return false;
    }
    !path
        .split('/')
        .filter(|component| !component.is_empty())
        .any(|component| matches!(component, "." | ".."))
}

// 验证 UNC 与发行版一致及 Linux 路径合法，再在 WSL 检查目录、可读和可写状态，返回规范化 UNC。
fn validate_wsl_home(raw: &str, distro: &str) -> Result<String, String> {
    if raw.contains('\0') || raw.contains('\r') || raw.contains('\n') {
        return Err("provider_home_invalid".to_string());
    }
    let (parsed_distro, linux_path) =
        wsl::parse_wsl_unc_path(raw).ok_or_else(|| "provider_home_invalid".to_string())?;
    if !parsed_distro.eq_ignore_ascii_case(distro) {
        return Err("provider_home_environment_mismatch".to_string());
    }
    if !is_valid_linux_home_path(&linux_path) {
        return Err("provider_home_invalid".to_string());
    }
    let file_name = linux_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(file_name.as_str(), ".claude" | ".codex" | ".grok") {
        return Err("provider_home_must_be_parent_directory".to_string());
    }
    let validation = run_wsl(
        distro,
        "sh",
        &[
            "-lc",
            "if [ ! -d \"$1\" ]; then exit 1; elif [ ! -r \"$1\" ]; then exit 2; elif [ ! -w \"$1\" ]; then exit 3; fi",
            "--",
            &linux_path,
        ],
    )
    .map_err(|_| "provider_wsl_probe_failed".to_string())?;
    match validation.status.code() {
        Some(0) => {}
        Some(1) => return Err("provider_home_invalid".to_string()),
        Some(2) => return Err("provider_home_not_readable".to_string()),
        Some(3) => return Err("provider_home_not_writable".to_string()),
        _ => return Err("provider_home_invalid".to_string()),
    }
    Ok(wsl::normalize_wsl_unc_path(raw))
}

// 委托共享应用路径服务读取本机环境中的 Home 路径。
fn auto_local_home() -> Result<PathBuf, String> {
    app_paths::home_dir_from_env()
}

// 探测指定发行版 HOME，要求非空绝对形式后转 UNC；更完整路径与权限验证由后续流程执行。
fn auto_wsl_home(distro: &str) -> Result<String, String> {
    let output = probe_wsl_home(distro)?;
    if !output.status.success() {
        return Err("provider_home_invalid".to_string());
    }
    let linux_home = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if linux_home.is_empty() || !linux_home.starts_with('/') {
        return Err("provider_home_invalid".to_string());
    }
    Ok(wsl::linux_to_unc_wsl_path(&linux_home, distro))
}

// 从同一 Home 拼接三种 CLI 配置与历史目录，不创建或校验这些目录。
fn build_targets(home_path: &str) -> DerivedCliTargets {
    let home = PathBuf::from(home_path);
    let claude = home.join(".claude");
    let codex = home.join(".codex");
    let grok = home.join(".grok");
    DerivedCliTargets {
        home_path: home_path.to_string(),
        claude_config_dir: claude.to_string_lossy().into_owned(),
        claude_history_root: claude.join("projects").to_string_lossy().into_owned(),
        codex_config_dir: codex.to_string_lossy().into_owned(),
        codex_history_root: codex.join("sessions").to_string_lossy().into_owned(),
        grok_config_dir: grok.to_string_lossy().into_owned(),
        grok_history_root: grok.join("sessions").to_string_lossy().into_owned(),
    }
}

// 按环境及自动/手动模式确定路径后执行平台验证，返回已验证路径与模式。
fn resolve_home(input: &NormalizedHomeInput) -> Result<(String, String), String> {
    if input.environment_kind == "local" {
        let path = match input.mode.as_str() {
            "auto" => auto_local_home()?.to_string_lossy().into_owned(),
            _ => input.home_path.clone().unwrap_or_default(),
        };
        let validated = validate_local_home(&path)?;
        return Ok((validated.to_string_lossy().into_owned(), input.mode.clone()));
    }

    let path = match input.mode.as_str() {
        "auto" => auto_wsl_home(&input.environment_id)?,
        _ => input.home_path.clone().unwrap_or_default(),
    };
    Ok((
        validate_wsl_home(&path, &input.environment_id)?,
        input.mode.clone(),
    ))
}

// 解析并验证 Home，再构造身份、来源与派生 CLI 路径；可能执行探测，不写偏好。
fn state_from_input(input: &NormalizedHomeInput) -> Result<ProviderHomeState, String> {
    let (home_path, mode) = resolve_home(input)?;
    Ok(ProviderHomeState {
        identity: identity(&input.environment_kind, &input.environment_id),
        mode,
        source: if input.mode == "auto" {
            "auto".to_string()
        } else {
            "manual".to_string()
        },
        targets: build_targets(&home_path),
        home_path,
    })
}

// 从供应商数据库读取环境偏好，缺失返回 None；列转换失败分别回退自动模式和空路径。
async fn load_preference(
    environment_kind: &str,
    environment_id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT mode, home_path FROM provider_home_preferences
         WHERE environment_kind = ?1 AND environment_id = ?2",
    )
    .bind(environment_kind)
    .bind(environment_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_home_preference_read_failed".to_string())?;
    Ok(row.map(|row| {
        (
            row.try_get::<String, _>("mode")
                .unwrap_or_else(|_| "auto".to_string()),
            row.try_get::<Option<String>, _>("home_path")
                .unwrap_or(None),
        )
    }))
}

// 在同一数据库事务中更新环境偏好及活动身份，自动模式不持久化路径；不同时更新内存缓存。
async fn persist_preference(input: &NormalizedHomeInput) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_home_preference_write_failed".to_string())?;
    sqlx::query(
        "INSERT INTO provider_home_preferences
         (environment_kind, environment_id, mode, home_path, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(environment_kind, environment_id) DO UPDATE SET
           mode = excluded.mode, home_path = excluded.home_path,
           updated_at = excluded.updated_at",
    )
    .bind(&input.environment_kind)
    .bind(&input.environment_id)
    .bind(&input.mode)
    .bind(if input.mode == "manual" {
        input.home_path.as_deref()
    } else {
        None
    })
    .bind(now_millis())
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_home_preference_write_failed".to_string())?;

    let identity = format!("{}:{}", input.environment_kind, input.environment_id);
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(ACTIVE_HOME_IDENTITY_SETTING)
    .bind(identity)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_home_preference_write_failed".to_string())?;

    transaction
        .commit()
        .await
        .map_err(|_| "provider_home_preference_write_failed".to_string())?;
    Ok(())
}

// 读取持久化活动身份文本，缺失返回 None，不校验身份格式。
async fn load_active_identity() -> Result<Option<String>, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(ACTIVE_HOME_IDENTITY_SETTING)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_home_preference_read_failed".to_string())
}

// 按首个冒号解析 local/wsl 身份，本机只允许精确 host，WSL 要求非空 ID。
fn parse_identity(value: &str) -> Option<(String, String)> {
    let (kind, id) = value.split_once(':')?;
    let kind = kind.trim().to_ascii_lowercase();
    let id = id.trim().to_string();
    if id.is_empty() || (kind != "local" && kind != "wsl") {
        return None;
    }
    if kind == "local" && id != LOCAL_ENVIRONMENT_ID {
        return None;
    }
    Some((kind, id))
}

// 先写 Home 映射再更新独立活动身份锁；两步不是原子操作，后一步失败不撤销前一步。
fn set_active_state(state: &ProviderHomeState) -> Result<(), String> {
    cache()
        .write()
        .map_err(|_| "provider_home_cache_unavailable".to_string())?
        .insert(state.identity.identity.clone(), state.clone());
    *active_home_identity()
        .write()
        .map_err(|_| "provider_home_cache_unavailable".to_string())? =
        Some(state.identity.identity.clone());
    Ok(())
}

// 优先使用已保存的模式与路径，否则按自动模式解析并验证指定环境的 Home。
async fn state_for(
    environment_kind: String,
    environment_id: String,
) -> Result<ProviderHomeState, String> {
    if let Some((mode, home_path)) = load_preference(&environment_kind, &environment_id).await? {
        return state_from_input(&NormalizedHomeInput {
            environment_kind,
            environment_id,
            mode,
            home_path,
        });
    }
    state_from_input(&NormalizedHomeInput {
        environment_kind,
        environment_id,
        mode: "auto".to_string(),
        home_path: None,
    })
}

// 先解析本机 Home，再尝试恢复持久化活动环境；活动环境解析失败回退本机，写缓存但不重写持久化身份。
pub(crate) async fn initialize_cache() -> Result<(), String> {
    let local = state_for("local".to_string(), LOCAL_ENVIRONMENT_ID.to_string()).await?;
    let active = match load_active_identity()
        .await?
        .as_deref()
        .and_then(parse_identity)
    {
        Some((kind, id)) if kind == "local" && id == LOCAL_ENVIRONMENT_ID => Some(local.clone()),
        Some((kind, id)) => state_for(kind, id).await.ok(),
        None => None,
    }
    .unwrap_or_else(|| local.clone());
    cache()
        .write()
        .map_err(|_| "provider_home_cache_unavailable".to_string())?
        .insert(local.identity.identity.clone(), local);
    set_active_state(&active)
}

// 规范化输入后优先返回缓存，未命中时按已保存偏好解析并缓存；不以输入中的草稿路径覆盖保存选择，也不切换活动身份。
pub(crate) async fn get(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    let normalized = normalize_input(input)?;
    if let Some(state) = cached_state(&normalized.environment_kind, &normalized.environment_id) {
        return Ok(state);
    }
    let state = state_for(
        normalized.environment_kind.clone(),
        normalized.environment_id.clone(),
    )
    .await?;
    cache()
        .write()
        .map_err(|_| "provider_home_cache_unavailable".to_string())?
        .insert(state.identity.identity.clone(), state.clone());
    Ok(state)
}

// 规范化并验证候选 Home，返回状态但不保存偏好或更新缓存；路径验证仍可能创建探测文件或执行 WSL。
pub(crate) async fn preview(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    let normalized = normalize_input(input)?;
    state_from_input(&normalized)
}

// 先验证 Home，再事务保存偏好及活动身份，最后更新内存缓存；缓存失败不会回滚已提交偏好。
pub(crate) async fn select(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    let normalized = normalize_input(input)?;
    let state = state_from_input(&normalized)?;
    persist_preference(&normalized).await?;
    set_active_state(&state)?;
    Ok(state)
}

// 以自动模式和无显式路径委托选择流程，重新解析并保存指定环境 Home。
pub(crate) async fn reset(
    environment_kind: String,
    environment_id: Option<String>,
) -> Result<ProviderHomeState, String> {
    select(HomeSelectInput {
        environment_kind,
        environment_id,
        mode: "auto".to_string(),
        home_path: None,
    })
    .await
}

// 按精确 kind:id 从缓存克隆状态，锁失败或未命中返回 None，不重新验证路径。
pub(crate) fn cached_state(kind: &str, id: &str) -> Option<ProviderHomeState> {
    cache()
        .read()
        .ok()
        .and_then(|values| values.get(&format!("{kind}:{id}")).cloned())
}

// 规范化缓存查询身份并拒绝非法种类及本机非 host 身份；不探测 WSL，缺失 ID 默认 host。
pub(crate) fn cached(
    environment_kind: String,
    environment_id: Option<String>,
) -> Option<ProviderHomeState> {
    let kind = environment_kind.trim().to_ascii_lowercase();
    let id = environment_id
        .unwrap_or_else(|| LOCAL_ENVIRONMENT_ID.to_string())
        .trim()
        .to_string();
    if (kind != "local" && kind != "wsl") || id.is_empty() {
        return None;
    }
    if kind == "local" && id != LOCAL_ENVIRONMENT_ID {
        return None;
    }
    cached_state(&kind, &id)
}

// 返回可取得的活动缓存状态，否则返回活动 Home 不可用错误。
pub(crate) fn active() -> Result<ProviderHomeState, String> {
    active_state().ok_or_else(|| "provider_home_active_unavailable".to_string())
}

// 从本机默认 Home 直接构建自动状态，不执行目录或可写性验证。
fn fallback_local_state() -> Option<ProviderHomeState> {
    let home = auto_local_home().ok()?.to_string_lossy().into_owned();
    Some(ProviderHomeState {
        identity: identity("local", LOCAL_ENVIRONMENT_ID),
        mode: "auto".to_string(),
        home_path: home.clone(),
        source: "auto".to_string(),
        targets: build_targets(&home),
    })
}

// 依次使用活动缓存、本机缓存和本机环境回退，返回所选 CLI 配置目录；不启动 WSL 探测。
pub(crate) fn default_config_root(app_type: &str) -> Option<PathBuf> {
    let state = active_state()
        .or_else(|| cached_state("local", LOCAL_ENVIRONMENT_ID).or_else(fallback_local_state))?;
    match app_type.trim().to_ascii_lowercase().as_str() {
        "claude" => Some(PathBuf::from(state.targets.claude_config_dir)),
        "codex" => Some(PathBuf::from(state.targets.codex_config_dir)),
        "grok" | "grokbuild" => Some(PathBuf::from(state.targets.grok_config_dir)),
        _ => None,
    }
}

// 依次使用活动缓存、本机缓存和本机环境回退，返回所选 CLI 历史目录，不创建目录。
pub(crate) fn default_history_root(app_type: &str) -> Option<PathBuf> {
    let state = active_state()
        .or_else(|| cached_state("local", LOCAL_ENVIRONMENT_ID).or_else(fallback_local_state))?;
    match app_type.trim().to_ascii_lowercase().as_str() {
        "claude" => Some(PathBuf::from(state.targets.claude_history_root)),
        "codex" => Some(PathBuf::from(state.targets.codex_history_root)),
        "grok" | "grokbuild" => Some(PathBuf::from(state.targets.grok_history_root)),
        _ => None,
    }
}

// 读取活动身份、解析后查询对应缓存，锁失败、身份无效或未命中均返回 None。
fn active_state() -> Option<ProviderHomeState> {
    let identity = active_home_identity().read().ok()?.clone()?;
    let (kind, id) = parse_identity(&identity)?;
    cached_state(&kind, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    // Windows 纯路径测试：验证单一本机 Home 派生 Claude、Codex 和 Grok 目录。
    fn derives_cli_targets_from_one_home() {
        let targets = build_targets(r"C:\Users\tester");
        assert_eq!(targets.claude_config_dir, r"C:\Users\tester\.claude");
        assert_eq!(
            targets.codex_history_root,
            r"C:\Users\tester\.codex\sessions"
        );
        assert_eq!(targets.grok_config_dir, r"C:\Users\tester\.grok");
        assert_eq!(targets.grok_history_root, r"C:\Users\tester\.grok\sessions");
    }

    #[cfg(windows)]
    #[test]
    // Windows 纯路径测试：验证 WSL UNC Home 派生配置与历史目录，不访问发行版。
    fn derives_cli_targets_from_wsl_unc_home() {
        let targets = build_targets(r"\\wsl.localhost\Ubuntu\home\tester");
        assert_eq!(
            targets.claude_config_dir,
            r"\\wsl.localhost\Ubuntu\home\tester\.claude"
        );
        assert_eq!(
            targets.codex_history_root,
            r"\\wsl.localhost\Ubuntu\home\tester\.codex\sessions"
        );
        assert_eq!(
            targets.grok_history_root,
            r"\\wsl.localhost\Ubuntu\home\tester\.grok\sessions"
        );
    }

    #[cfg(windows)]
    #[test]
    // 验证 Windows 路径中的 .claude 子目录不能直接作为 Home。
    fn rejects_cli_subdirectories() {
        assert_eq!(
            reject_cli_subdirectory(Path::new(r"C:\Users\tester\.claude")),
            Err("provider_home_must_be_parent_directory".to_string())
        );
    }

    #[test]
    // 验证本机自动输入补齐 host 身份并保留自动模式。
    fn normalizes_local_auto_input() {
        let value = normalize_input(HomeSelectInput {
            environment_kind: "local".to_string(),
            environment_id: None,
            mode: "auto".to_string(),
            home_path: None,
        })
        .unwrap();
        assert_eq!(value.environment_id, LOCAL_ENVIRONMENT_ID);
        assert_eq!(value.mode, "auto");
    }

    #[test]
    // 验证本机环境忽略传入的发行版名，固定使用 host。
    fn local_environment_always_uses_host_identity() {
        let value = normalize_input(HomeSelectInput {
            environment_kind: "local".to_string(),
            environment_id: Some("Ubuntu".to_string()),
            mode: "auto".to_string(),
            home_path: None,
        })
        .unwrap();
        assert_eq!(value.environment_id, LOCAL_ENVIRONMENT_ID);
    }

    #[test]
    // 验证默认 WSL 输出解析发行版和 Home，并拒绝根目录作为 Home。
    fn parses_default_wsl_context_from_probe_output() {
        let (distro, home) = parse_default_wsl_context(b"Ubuntu-22.04\n/home/tester").unwrap();
        assert_eq!(distro, "Ubuntu-22.04");
        assert_eq!(home, "/home/tester");
        assert_eq!(
            parse_default_wsl_context(b"Ubuntu-22.04\n/"),
            Err("provider_wsl_probe_failed".to_string())
        );
    }

    #[test]
    // 验证 UTF-8 发行版列表解析保留顺序与重复项。
    fn parses_wsl_distro_list_output() {
        assert_eq!(
            parse_wsl_distros(b"Ubuntu\r\nDebian\r\nUbuntu\r\n"),
            vec!["Ubuntu", "Debian", "Ubuntu"]
        );
    }

    #[test]
    // 验证带 BOM 的 UTF-16LE 发行版列表正确解码。
    fn parses_utf16_wsl_distro_list_output() {
        let mut output = vec![0xff, 0xfe];
        output.extend(
            "Ubuntu\r\nDebian\r\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        );
        assert_eq!(parse_wsl_distros(&output), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    // 验证检测超时至少十五秒且长于快速校验超时，不执行真实超时流程。
    fn keeps_cold_start_detection_separate_from_fast_validation() {
        assert!(WSL_HOME_DETECT_TIMEOUT >= Duration::from_secs(15));
        assert!(WSL_HOME_VALIDATION_TIMEOUT < WSL_HOME_DETECT_TIMEOUT);
    }

    #[test]
    // 验证 WSL 输入身份为 host 时从手动 UNC 提取发行版，避免默认发行版探测。
    fn infers_wsl_environment_from_manual_unc_home() {
        let value = normalize_input(HomeSelectInput {
            environment_kind: "wsl".to_string(),
            environment_id: Some(LOCAL_ENVIRONMENT_ID.to_string()),
            mode: "manual".to_string(),
            home_path: Some(r"\\wsl.localhost\Ubuntu-22.04\home\tester".to_string()),
        })
        .unwrap();
        assert_eq!(value.environment_id, "Ubuntu-22.04");
    }

    #[test]
    // 验证相对本机路径和不匹配发行版的 UNC 在实际探测前被拒绝。
    fn rejects_invalid_manual_home_inputs() {
        assert_eq!(
            normalize_input(HomeSelectInput {
                environment_kind: "local".to_string(),
                environment_id: None,
                mode: "manual".to_string(),
                home_path: Some("relative".to_string()),
            })
            .and_then(|input| resolve_home(&input).map(|_| ())),
            Err("provider_home_invalid".to_string())
        );
        assert_eq!(
            normalize_input(HomeSelectInput {
                environment_kind: "wsl".to_string(),
                environment_id: Some("Ubuntu".to_string()),
                mode: "manual".to_string(),
                home_path: Some(r"\\wsl.localhost\OtherDistro\home\tester".to_string(),),
            })
            .and_then(|input| resolve_home(&input).map(|_| ())),
            Err("provider_home_environment_mismatch".to_string())
        );
    }

    #[test]
    // 在独立临时目录创建普通文件，验证其不能作为本机 Home。
    fn rejects_file_as_local_home() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("not-a-directory");
        fs::write(&file, b"x").unwrap();
        assert_eq!(
            validate_local_home(file.to_string_lossy().as_ref()),
            Err("provider_home_invalid".to_string())
        );
    }

    #[test]
    // 验证本机 Home 校验拒绝 WSL UNC，不访问目标路径。
    fn rejects_wsl_unc_path_as_local_home() {
        assert_eq!(
            validate_local_home(r"\\wsl.localhost\Ubuntu\home\tester"),
            Err("provider_home_environment_mismatch".to_string())
        );
    }

    #[test]
    // 验证 Linux Home 文本规则接受正常绝对路径，拒绝相对、点段及嵌入换行。
    fn validates_linux_home_paths_without_host_path_rules() {
        assert!(is_valid_linux_home_path("/home/tester"));
        assert!(!is_valid_linux_home_path("relative/home"));
        assert!(!is_valid_linux_home_path("/home/../root"));
        assert!(!is_valid_linux_home_path("/home/./tester"));
        assert!(!is_valid_linux_home_path("/home/te\nster"));
    }

    #[test]
    // 验证 local:host 与非空 WSL 身份可解析，其他本机身份、未知环境及空 ID 被拒绝。
    fn parses_only_supported_home_identities() {
        assert_eq!(
            parse_identity("local:host"),
            Some(("local".to_string(), "host".to_string()))
        );
        assert_eq!(
            parse_identity("wsl:Ubuntu"),
            Some(("wsl".to_string(), "Ubuntu".to_string()))
        );
        assert_eq!(parse_identity("local:other"), None);
        assert_eq!(parse_identity("unsupported:host"), None);
        assert_eq!(parse_identity("wsl:"), None);
    }
}
