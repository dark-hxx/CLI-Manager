use super::grok;
use crate::{
    app_paths,
    provider::{home, repository},
    wsl,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, Row};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const GENERATED_ROOT: &str = "generated";
const SNAPSHOT_KEY_FILE: &str = "provider.key";
const CODEX_PROVIDER_ENV_KEY: &str = "CLI_MANAGER_PROVIDER_KEY";
const CODEX_SCOPED_PROVIDER_NAME: &str = "cli_manager_scope";
const GROK_PROVIDER_ENV_KEY: &str = "XAI_API_KEY";
const GROK_BASE_URL_ENV_KEY: &str = "GROK_MODELS_BASE_URL";
const GROK_HISTORY_BACKUP_DIR: &str = "provider-grok-history";
const SNAPSHOT_APP_TYPES: [&str; 3] = ["claude", "codex", "grokbuild"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopePrepareInput {
    pub app_type: String,
    pub project_id: Option<String>,
    pub worktree_id: Option<String>,
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeResolveInput {
    pub app_type: String,
    pub project_id: Option<String>,
    pub worktree_id: Option<String>,
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderLaunchConfig {
    pub app_type: String,
    pub provider_id: String,
    pub snapshot_id: String,
    pub claude_settings_path: Option<String>,
    pub generated_home: Option<String>,
    pub grok_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedProvider {
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderLaunchSnapshot {
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    pub source: String,
    pub snapshot_id: String,
    pub claude_settings_path: Option<String>,
    pub generated_home: Option<String>,
    pub grok_model: Option<String>,
    pub codex_profile_name: Option<String>,
    pub config_overrides: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    app_type: String,
    provider_id: String,
    active_key_id: String,
    snapshot_id: String,
    grok_base_url: Option<String>,
    grok_model: Option<String>,
}

#[derive(Clone)]
struct NativeProvider {
    id: String,
    name: String,
    app_type: String,
    settings_config: String,
    meta: String,
    active_key_id: String,
    active_key: String,
}

struct ResolvedSelection {
    provider: NativeProvider,
    source: &'static str,
}

// 委托供应商仓储规范化应用类型，统一别名与不支持类型的错误。
fn normalize_type(value: &str) -> Result<String, String> {
    repository::normalize_app_type(value)
}

// 加载已启用供应商及可用密钥；指定密钥 ID 时检查归属和启用状态，否则选择启用的活动密钥，并拒绝空密钥。
async fn load_provider(
    app_type: String,
    provider_id: String,
    active_key_id: Option<String>,
) -> Result<NativeProvider, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, name, settings_config, meta
         FROM providers WHERE id = ?1 AND app_type = ?2",
    )
    .bind(&provider_id)
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .ok_or_else(|| "provider_not_found".to_string())?;

    let meta: String = row
        .try_get("meta")
        .map_err(|_| "provider_database_error".to_string())?;
    if !repository::meta_enabled(&repository::parse_meta(&meta)) {
        return Err("provider_not_ready".to_string());
    }
    let id: String = row
        .try_get("id")
        .map_err(|_| "provider_database_error".to_string())?;
    let name: String = row
        .try_get("name")
        .map_err(|_| "provider_database_error".to_string())?;
    let settings_config: String = row
        .try_get("settings_config")
        .map_err(|_| "provider_database_error".to_string())?;
    let key_row = if let Some(active_key_id) = active_key_id {
        sqlx::query(
            "SELECT id, api_key, enabled
             FROM provider_api_keys
             WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
        )
        .bind(active_key_id)
        .bind(&id)
        .bind(&app_type)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_database_error".to_string())?
    } else {
        sqlx::query(
            "SELECT id, api_key, enabled
             FROM provider_api_keys
             WHERE provider_id = ?1 AND app_type = ?2
               AND is_active = 1 AND enabled = 1
             LIMIT 1",
        )
        .bind(&id)
        .bind(&app_type)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_database_error".to_string())?
    };
    let key_row = key_row.ok_or_else(|| "provider_key_not_active".to_string())?;
    let enabled: i64 = key_row
        .try_get("enabled")
        .map_err(|_| "provider_database_error".to_string())?;
    if enabled != 1 {
        return Err("provider_key_not_active".to_string());
    }
    let active_key_id: String = key_row
        .try_get("id")
        .map_err(|_| "provider_database_error".to_string())?;
    let active_key: String = key_row
        .try_get("api_key")
        .map_err(|_| "provider_database_error".to_string())?;
    if active_key.trim().is_empty() {
        return Err("provider_key_not_active".to_string());
    }

    Ok(NativeProvider {
        id,
        name,
        app_type,
        settings_config,
        meta,
        active_key_id,
        active_key,
    })
}

// 按供应商元数据决定是否合并公共配置，再投影当前密钥并解析为 JSON 配置值。
async fn effective_settings(provider: NativeProvider) -> Result<Value, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let common = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(format!("common_config_{}", provider.app_type))
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_database_error".to_string())?
        .unwrap_or_default();
    let meta = repository::parse_meta(&provider.meta);
    let merged = if repository::meta_common_config_enabled(&meta) {
        repository::merge_common_into_settings(
            &provider.app_type,
            &common,
            &provider.settings_config,
        )?
    } else {
        provider.settings_config.clone()
    };
    let projected =
        repository::project_key_into_settings(&provider.app_type, &merged, &provider.active_key)?;
    serde_json::from_str(&projected).map_err(|_| "provider_config_invalid".to_string())
}

// 仅在主数据库文件存在时以只读方式打开，设置五秒忙等待；缺文件返回 None。
async fn open_app_database() -> Result<Option<SqliteConnection>, String> {
    let path = app_paths::db_path()?;
    if !path.is_file() {
        return Ok(None);
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(5));
    SqliteConnection::connect_with(&options)
        .await
        .map(Some)
        .map_err(|_| "provider_scope_database_error".to_string())
}

// 仅允许项目或 Worktree 两种固定查询，按 ID 读取供应商覆盖原文。
async fn read_scope_override(
    connection: &mut SqliteConnection,
    table: String,
    id: String,
) -> Result<Option<String>, String> {
    let query = match table.as_str() {
        "projects" => "SELECT provider_overrides FROM projects WHERE id = ?1",
        "worktrees" => "SELECT provider_overrides FROM worktrees WHERE id = ?1",
        _ => return Err("provider_scope_database_error".to_string()),
    };
    sqlx::query_scalar::<_, String>(query)
        .bind(id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| "provider_scope_database_error".to_string())
}

// 解析本机 v2 供应商引用，兼容 Grok 外层别名与直接引用；旧格式或身份字段不符时要求迁移。
pub(crate) fn parse_provider_reference(
    raw: Option<&str>,
    app_type: &str,
) -> Result<Option<String>, String> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|_| "provider_reference_migration_required".to_string())?;
    let Some(root) = parsed.as_object() else {
        return Err("provider_reference_migration_required".to_string());
    };
    let candidate = root
        .get(app_type)
        .or_else(|| {
            if app_type == "grokbuild" {
                root.get("grok")
            } else {
                None
            }
        })
        .or_else(|| (root.get("providerId").is_some()).then_some(&parsed));
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    let Some(reference) = candidate.as_object() else {
        return Err("provider_reference_migration_required".to_string());
    };
    if reference.is_empty() {
        return Ok(None);
    }
    let schema_version = reference
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let source = reference.get("source").and_then(Value::as_str);
    let reference_type = reference.get("appType").and_then(Value::as_str);
    if schema_version != 2 || source != Some("cli-manager") || reference_type != Some(app_type) {
        return Err("provider_reference_migration_required".to_string());
    }
    let provider_id = reference
        .get("providerId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider_reference_migration_required".to_string())?;
    Ok(Some(provider_id.to_string()))
}

// 查询应用标记为 current 的首条供应商 ID，未设置时返回专用错误。
async fn current_provider_id(app_type: String) -> Result<String, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1",
    )
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .ok_or_else(|| "provider_current_not_set".to_string())
}

/// 只解析显式 / Worktree / project 覆盖，不回落到全局 current。
/// 无覆盖时返回 `None`，调用方据此判定"跟随全局"——全局 apply 已把供应商物化到
/// 真实 Home，启动不需要任何隔离快照或命令参数。
// 按显式 ID、所属项目的活动 Worktree、项目覆盖依次选择；无覆盖返回 None，不查询全局供应商。
async fn scope_override(
    app_type: &str,
    input: &ScopeResolveInput,
) -> Result<Option<(String, &'static str)>, String> {
    if let Some(provider_id) = input
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(Some((provider_id.to_string(), "explicit")));
    }

    let Some(project_id) = input
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let Some(mut connection) = open_app_database().await? else {
        return Ok(None);
    };

    if let Some(worktree_id) = input
        .worktree_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let worktree = sqlx::query_scalar::<_, String>(
            "SELECT provider_overrides FROM worktrees
             WHERE id = ?1 AND project_id = ?2 AND status = 'active'",
        )
        .bind(worktree_id)
        .bind(project_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_scope_database_error".to_string())?;
        if let Some(provider_id) = parse_provider_reference(worktree.as_deref(), app_type)? {
            return Ok(Some((provider_id, "worktree")));
        }
    }

    let project = read_scope_override(
        &mut connection,
        "projects".to_string(),
        project_id.to_string(),
    )
    .await?;
    if let Some(provider_id) = parse_provider_reference(project.as_deref(), app_type)? {
        return Ok(Some((provider_id, "project")));
    }
    Ok(None)
}

// 解析作用域覆盖，缺省时回落到全局 current，并加载可用供应商与密钥。
async fn resolve_selection(input: ScopeResolveInput) -> Result<ResolvedSelection, String> {
    let app_type = normalize_type(&input.app_type)?;
    let (provider_id, source) = match scope_override(&app_type, &input).await? {
        Some(selection) => selection,
        None => (current_provider_id(app_type.clone()).await?, "global"),
    };
    Ok(ResolvedSelection {
        provider: load_provider(app_type, provider_id, None).await?,
        source,
    })
}

// 限制快照 ID 为一至八十字节的 ASCII 字母、数字、连字符或下划线。
fn snapshot_id_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

// 规范化应用类型并验证快照 ID，构造供应商 generated 目录下的快照路径。
fn generated_root(app_type: &str, snapshot_id: &str) -> Result<PathBuf, String> {
    let app_type = normalize_type(app_type)?;
    if !snapshot_id_valid(snapshot_id) {
        return Err("provider_snapshot_invalid".to_string());
    }
    Ok(app_paths::providers_dir()?
        .join(GENERATED_ROOT)
        .join(app_type)
        .join(snapshot_id))
}

// 创建父目录后直接写入快照文件，将目录或写入失败统一映射为快照错误。
fn write_snapshot_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "provider_snapshot_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "provider_snapshot_write_failed".to_string())?;
    fs::write(path, bytes).map_err(|_| "provider_snapshot_write_failed".to_string())
}

// 递归复制普通文件和目录；遇到符号链接或其他文件类型即报错，不在此层清理已复制内容。
fn copy_regular_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
    let entries = fs::read_dir(source)
        .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err("provider_snapshot_history_recovery_unsafe_entry".to_string());
        }
        if file_type.is_dir() {
            copy_regular_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)
                .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        } else {
            return Err("provider_snapshot_history_recovery_unsafe_entry".to_string());
        }
    }
    Ok(())
}

// 目标已是普通目录时直接保留；否则复制到唯一暂存目录再重命名发布，失败时尽力删除暂存目录。
fn stage_directory_copy(source: &Path, destination: &Path) -> Result<(), String> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            return Ok(())
        }
        Ok(_) => return Err("provider_snapshot_history_recovery_conflict".to_string()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err("provider_snapshot_history_recovery_failed".to_string())
        }
        Err(_) => {}
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "provider_snapshot_history_recovery_failed".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "provider_snapshot_history_recovery_failed".to_string())?;
    let staging = parent.join(format!(".{name}.recovery-{}", Uuid::new_v4()));
    let result = copy_regular_tree(source, &staging).and_then(|_| {
        fs::rename(&staging, destination)
            .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())
    });
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

// 检查项目目录下是否存在会话目录；会话根无法读取时返回 false，已开始遍历后的条目错误向上传播。
fn contains_grok_session_directories(sessions_root: &Path) -> Result<bool, String> {
    let Ok(projects) = fs::read_dir(sessions_root) else {
        return Ok(false);
    };
    for project in projects {
        let project =
            project.map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        if !project
            .file_type()
            .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?
            .is_dir()
        {
            continue;
        }
        let sessions = fs::read_dir(project.path())
            .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        for session in sessions {
            if session
                .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?
                .file_type()
                .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?
                .is_dir()
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

// 遍历备份中的项目和会话目录，拒绝链接并分会话暂存恢复，已有目标会话目录保持不变。
fn restore_grok_sessions_from_backup(
    backup_sessions: &Path,
    target_sessions: &Path,
) -> Result<(), String> {
    fs::create_dir_all(target_sessions)
        .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
    let projects = fs::read_dir(backup_sessions)
        .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
    for project in projects {
        let project =
            project.map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        let project_type = project
            .file_type()
            .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        if project_type.is_symlink() {
            return Err("provider_snapshot_history_recovery_unsafe_entry".to_string());
        }
        if !project_type.is_dir() {
            continue;
        }
        let target_project = target_sessions.join(project.file_name());
        fs::create_dir_all(&target_project)
            .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        let sessions = fs::read_dir(project.path())
            .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
        for session in sessions {
            let session =
                session.map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
            let session_type = session
                .file_type()
                .map_err(|_| "provider_snapshot_history_recovery_failed".to_string())?;
            if session_type.is_symlink() {
                return Err("provider_snapshot_history_recovery_unsafe_entry".to_string());
            }
            if !session_type.is_dir() {
                continue;
            }
            stage_directory_copy(&session.path(), &target_project.join(session.file_name()))?;
        }
    }
    Ok(())
}

// 仅在旧快照含会话目录时恢复历史，先拒绝 WSL 目标，再建立备份并将缺失会话恢复到目标。
fn recover_legacy_grok_history_to(
    snapshot_root: &Path,
    backup_root: &Path,
    target_sessions: &Path,
) -> Result<(), String> {
    let source_sessions = snapshot_root.join("grok").join("sessions");
    if !contains_grok_session_directories(&source_sessions)? {
        return Ok(());
    }
    if wsl::parse_wsl_unc_path(&target_sessions.to_string_lossy()).is_some() {
        return Err("provider_snapshot_history_recovery_wsl_unsupported".to_string());
    }
    let backup_sessions = backup_root.join("sessions");
    stage_directory_copy(&source_sessions, &backup_sessions)?;
    restore_grok_sessions_from_backup(&backup_sessions, target_sessions)
}

// 按快照 ID 定位历史备份目录，选取默认 Grok 历史根后执行旧快照历史恢复。
fn recover_legacy_grok_history(snapshot_root: &Path, snapshot_id: &str) -> Result<(), String> {
    let backup_root = app_paths::history_backups_dir()?
        .join(GROK_HISTORY_BACKUP_DIR)
        .join(snapshot_id);
    let target_sessions = home::default_history_root("grok")
        .ok_or_else(|| "provider_snapshot_history_recovery_target_missing".to_string())?;
    recover_legacy_grok_history_to(snapshot_root, &backup_root, &target_sessions)
}

// 将生效的 Claude JSON 配置完整格式化序列化，并在结尾追加换行。
fn claude_snapshot_bytes(effective: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(effective)
        .map_err(|_| "provider_snapshot_write_failed".to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

// 构造快照根目录下固定的 manifest.json 路径。
fn snapshot_manifest_path(root: &Path) -> PathBuf {
    root.join("manifest.json")
}

// 将清单序列化为紧凑 JSON 并交给快照文件写入器保存。
fn write_manifest(root: &Path, manifest: &SnapshotManifest) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(manifest).map_err(|_| "provider_snapshot_write_failed".to_string())?;
    write_snapshot_file(&snapshot_manifest_path(root), &bytes)
}

// 验证路径组成后读取并反序列化快照清单；应用、供应商和快照身份匹配由调用方另行检查。
fn read_manifest(app_type: &str, snapshot_id: &str) -> Result<(PathBuf, SnapshotManifest), String> {
    let root = generated_root(app_type, snapshot_id)?;
    let bytes = fs::read(snapshot_manifest_path(&root))
        .map_err(|_| "provider_snapshot_missing".to_string())?;
    let manifest =
        serde_json::from_slice(&bytes).map_err(|_| "provider_snapshot_invalid".to_string())?;
    Ok((root, manifest))
}

// 将可选路径字符串转为 PathBuf 后直接比较，不进行规范化或文件系统解析。
fn path_matches(expected: &Path, actual: Option<&str>) -> bool {
    actual
        .map(PathBuf::from)
        .is_some_and(|path| path == expected)
}

// 去除首尾空白并拒绝空值、控制字符及指定引号或 shell 特殊字符，再包裹为 TOML 单引号字面量。
fn codex_toml_literal(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().any(|ch| {
            ch.is_control()
                || matches!(
                    ch,
                    '\'' | '"' | '%' | '!' | '^' | '&' | '|' | '<' | '>' | '$' | '`'
                )
        })
    {
        return Err("provider_config_invalid".to_string());
    }
    Ok(format!("'{value}'"))
}

// 从生效配置解析 Codex 运行参数，生成引用专用密钥环境变量的提供商与可选模型覆盖项。
fn codex_config_overrides(provider_id: &str, effective: &Value) -> Result<Vec<String>, String> {
    let settings =
        serde_json::to_string(effective).map_err(|_| "provider_config_invalid".to_string())?;
    let runtime = crate::provider::runtime::parse_runtime_config(provider_id, &settings)
        .map_err(|_| "provider_config_invalid".to_string())?;
    let provider = CODEX_SCOPED_PROVIDER_NAME;
    let mut overrides = vec![
        format!("model_provider={}", codex_toml_literal(provider)?),
        format!(
            "model_providers.{provider}.name={}",
            codex_toml_literal("CLI-Manager")?
        ),
        format!(
            "model_providers.{provider}.base_url={}",
            codex_toml_literal(&runtime.base_url)?
        ),
        format!(
            "model_providers.{provider}.env_key={}",
            codex_toml_literal(CODEX_PROVIDER_ENV_KEY)?
        ),
        format!(
            "model_providers.{provider}.wire_api={}",
            codex_toml_literal(runtime.wire_api.as_deref().unwrap_or("responses"))?
        ),
    ];
    if let Some(model) = runtime.model.as_deref() {
        overrides.push(format!("model={}", codex_toml_literal(model)?));
    }
    Ok(overrides)
}

// 在默认 Codex 配置根写入使用专用密钥环境变量的供应商 profile 文件，并返回 profile 名称。
fn write_codex_profile(provider_id: &str, effective: &Value) -> Result<String, String> {
    let config_dir = home::default_config_root("codex")
        .ok_or_else(|| "provider_snapshot_write_failed".to_string())?;
    let settings = serde_json::to_string(effective)
        .map_err(|_| "provider_snapshot_write_failed".to_string())?;
    let runtime = crate::provider::runtime::parse_runtime_config(provider_id, &settings)
        .map_err(|_| "provider_snapshot_write_failed".to_string())?;
    let profile = runtime
        .profile
        .with_env_key(CODEX_PROVIDER_ENV_KEY)
        .map_err(|_| "provider_snapshot_write_failed".to_string())?;
    write_snapshot_file(
        &config_dir.join(format!("{}.config.toml", profile.profile_name)),
        profile.profile_text.as_bytes(),
    )?;
    Ok(profile.profile_name)
}

// 按应用生成 Claude 设置、Codex 覆盖项或 Grok 运行元数据，再写入密钥文件与清单；不生成替代 Home。
fn write_snapshot_bundle(
    root: &Path,
    provider: &NativeProvider,
    effective: &Value,
    snapshot_id: &str,
) -> Result<(Option<String>, Option<String>, Option<String>, Vec<String>), String> {
    let mut claude_settings_path = None;
    let generated_home = None;
    let mut grok_base_url = None;
    let mut grok_model = None;
    let mut config_overrides = Vec::new();

    match provider.app_type.as_str() {
        "claude" => {
            let bytes = claude_snapshot_bytes(effective)?;
            let path = root.join("claude").join("settings.json");
            write_snapshot_file(&path, &bytes)?;
            claude_settings_path = Some(path.to_string_lossy().into_owned());
        }
        "codex" => {
            config_overrides = codex_config_overrides(&provider.id, effective)?;
        }
        "grokbuild" => {
            let settings = serde_json::to_string(effective)
                .map_err(|_| "provider_config_invalid".to_string())?;
            let (base_url, model, _) = grok::summary(&settings);
            grok_base_url = base_url.filter(|value| !value.trim().is_empty());
            grok_model = model.filter(|value| !value.trim().is_empty());
            if grok_base_url.is_none() || grok_model.is_none() {
                return Err("provider_config_invalid".to_string());
            }
        }
        _ => return Err("provider_invalid_app_type".to_string()),
    }

    write_snapshot_file(
        &root.join(SNAPSHOT_KEY_FILE),
        provider.active_key.as_bytes(),
    )?;
    write_manifest(
        root,
        &SnapshotManifest {
            app_type: provider.app_type.clone(),
            provider_id: provider.id.clone(),
            active_key_id: provider.active_key_id.clone(),
            snapshot_id: snapshot_id.to_string(),
            grok_base_url,
            grok_model: grok_model.clone(),
        },
    )?;
    Ok((
        claude_settings_path,
        generated_home,
        grok_model,
        config_overrides,
    ))
}

// 创建快照包，失败时尽力删除整个传入快照根目录并保留原错误。
fn write_snapshot_bundle_or_cleanup(
    root: &Path,
    provider: &NativeProvider,
    effective: &Value,
    snapshot_id: &str,
) -> Result<(Option<String>, Option<String>, Option<String>, Vec<String>), String> {
    match write_snapshot_bundle(root, provider, effective, snapshot_id) {
        Ok(paths) => Ok(paths),
        Err(error) => {
            let _ = fs::remove_dir_all(root);
            Err(error)
        }
    }
}

// 解析可用供应商后只返回应用、供应商标识、名称和选择来源，不返回密钥。
pub(crate) async fn resolve(input: ScopeResolveInput) -> Result<ResolvedProvider, String> {
    let selection = resolve_selection(input).await?;
    Ok(ResolvedProvider {
        app_type: selection.provider.app_type,
        provider_id: selection.provider.id,
        provider_name: selection.provider.name,
        source: selection.source.to_string(),
    })
}

// 无显式或项目覆盖时直接返回 None；否则生成快照，Codex 另写默认配置根中的 profile，失败时尽力清理快照目录。
pub(crate) async fn prepare(
    input: ScopePrepareInput,
) -> Result<Option<ProviderLaunchSnapshot>, String> {
    let resolve_input = ScopeResolveInput {
        app_type: input.app_type,
        project_id: input.project_id,
        worktree_id: input.worktree_id,
        provider_id: input.provider_id,
    };
    let app_type = normalize_type(&resolve_input.app_type)?;
    // 跟随全局：全局 apply 已把供应商写入真实 Home 的 live 配置，启动不需要隔离快照。
    // 这里必须在解析全局 current 之前短路，否则从未 apply 过全局供应商的用户
    // （import 后 is_current 恒为 0）会被 `provider_current_not_set` 阻断启动。
    let Some((provider_id, source)) = scope_override(&app_type, &resolve_input).await? else {
        return Ok(None);
    };
    let provider = load_provider(app_type, provider_id, None).await?;
    let effective = effective_settings(provider.clone()).await?;
    let snapshot_id = Uuid::new_v4().to_string();
    let root = generated_root(&provider.app_type, &snapshot_id)?;
    fs::create_dir_all(&root).map_err(|_| "provider_snapshot_write_failed".to_string())?;
    let (claude_settings_path, generated_home, grok_model, config_overrides) =
        write_snapshot_bundle_or_cleanup(&root, &provider, &effective, &snapshot_id)?;
    let codex_profile_name = if provider.app_type == "codex" {
        match write_codex_profile(&provider.id, &effective) {
            Ok(name) => Some(name),
            Err(error) => {
                let _ = fs::remove_dir_all(&root);
                return Err(error);
            }
        }
    } else {
        None
    };

    Ok(Some(ProviderLaunchSnapshot {
        app_type: provider.app_type,
        provider_id: provider.id,
        provider_name: provider.name,
        source: source.to_string(),
        snapshot_id,
        claude_settings_path,
        generated_home,
        grok_model,
        codex_profile_name,
        config_overrides,
    }))
}

// 按有效 ID 检查各应用快照清单，只删除身份匹配的目录；Grok 旧历史须先成功恢复，缺失或无效清单跳过。
pub(crate) async fn release_snapshot(snapshot_id: String) -> Result<(), String> {
    let snapshot_id = snapshot_id.trim();
    if !snapshot_id_valid(snapshot_id) {
        return Err("provider_snapshot_invalid".to_string());
    }
    for app_type in SNAPSHOT_APP_TYPES {
        let root = generated_root(app_type, snapshot_id)?;
        if !root.is_dir() {
            continue;
        }
        let Ok((_, manifest)) = read_manifest(app_type, snapshot_id) else {
            continue;
        };
        if manifest.snapshot_id != snapshot_id || manifest.app_type != app_type {
            continue;
        }
        if app_type == "grokbuild" {
            recover_legacy_grok_history(&root, snapshot_id)?;
        }
        fs::remove_dir_all(root).map_err(|_| "provider_snapshot_release_failed".to_string())?;
    }
    Ok(())
}

// 验证 Claude 快照的应用、供应商与快照身份，并要求设置文件存在后返回路径。
pub(crate) fn resolve_claude_settings_path(
    snapshot_id: &str,
    provider_id: &str,
) -> Result<PathBuf, String> {
    let (root, manifest) = read_manifest("claude", snapshot_id)?;
    if manifest.app_type != "claude"
        || manifest.provider_id != provider_id.trim()
        || manifest.snapshot_id != snapshot_id
    {
        return Err("provider_snapshot_mismatch".to_string());
    }
    let path = root.join("claude").join("settings.json");
    if !path.is_file() {
        return Err("provider_snapshot_missing".to_string());
    }
    Ok(path)
}

// 校验活动 ID 后遍历已知应用快照，跳过活动项和无效清单；Grok 先恢复旧历史，再删除未使用快照。
pub(crate) async fn garbage_collect_snapshots(
    active_snapshot_ids: Vec<String>,
) -> Result<(), String> {
    let active_snapshot_ids = active_snapshot_ids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if active_snapshot_ids
        .iter()
        .any(|snapshot_id| !snapshot_id_valid(snapshot_id))
    {
        return Err("provider_snapshot_invalid".to_string());
    }
    let generated_root = app_paths::providers_dir()?.join(GENERATED_ROOT);
    if !generated_root.is_dir() {
        return Ok(());
    }
    for app_type in SNAPSHOT_APP_TYPES {
        let app_root = generated_root.join(app_type);
        let Ok(entries) = fs::read_dir(&app_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(snapshot_id) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !snapshot_id_valid(snapshot_id)
                || active_snapshot_ids
                    .iter()
                    .any(|active| active == snapshot_id)
            {
                continue;
            }
            let Ok((_, manifest)) = read_manifest(app_type, snapshot_id) else {
                continue;
            };
            if manifest.snapshot_id != snapshot_id || manifest.app_type != app_type {
                continue;
            }
            if app_type == "grokbuild" {
                recover_legacy_grok_history(&path, snapshot_id)?;
            }
            fs::remove_dir_all(path).map_err(|_| "provider_snapshot_release_failed".to_string())?;
        }
    }
    Ok(())
}

// 在阻塞任务中运行快照环境校验与注入，任务连接失败映射为快照应用错误。
pub(crate) async fn apply_launch_environment(
    config: ProviderLaunchConfig,
    shell: Option<String>,
    env_vars: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(apply_launch_environment_inner(config, shell, env_vars))
    })
    .await
    .map_err(|_| "provider_snapshot_apply_failed".to_string())?
}

// 校验快照身份；Claude 仅验证设置路径，Codex/Grok 从快照读取密钥并注入传入环境表，拒绝替代 Home 配置。
async fn apply_launch_environment_inner(
    config: ProviderLaunchConfig,
    _shell: Option<String>,
    mut env_vars: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let app_type = normalize_type(&config.app_type)?;
    let (root, manifest) = read_manifest(&app_type, &config.snapshot_id)?;
    if manifest.app_type != app_type
        || manifest.provider_id != config.provider_id.trim()
        || manifest.snapshot_id != config.snapshot_id
    {
        return Err("provider_snapshot_mismatch".to_string());
    }
    if app_type == "claude" {
        let expected = root.join("claude").join("settings.json");
        if !path_matches(&expected, config.claude_settings_path.as_deref()) || !expected.is_file() {
            return Err("provider_snapshot_missing".to_string());
        }
        return Ok(env_vars);
    }
    if app_type == "codex" {
        if config.generated_home.is_some() {
            return Err("provider_snapshot_mismatch".to_string());
        }
        let active_key = fs::read(root.join(SNAPSHOT_KEY_FILE))
            .map_err(|_| "provider_snapshot_missing".to_string())
            .and_then(|bytes| {
                String::from_utf8(bytes).map_err(|_| "provider_snapshot_invalid".to_string())
            })?;
        if active_key.trim().is_empty() {
            return Err("provider_snapshot_invalid".to_string());
        }
        env_vars.insert(
            "CLI_MANAGER_PROVIDER_KEY_SCOPE".to_string(),
            "snapshot".to_string(),
        );
        env_vars.insert(CODEX_PROVIDER_ENV_KEY.to_string(), active_key);
        return Ok(env_vars);
    }
    if config.generated_home.is_some() {
        return Err("provider_snapshot_mismatch".to_string());
    }
    let base_url = manifest
        .grok_base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "provider_snapshot_invalid".to_string())?;
    let model = manifest
        .grok_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "provider_snapshot_invalid".to_string())?;
    if config.grok_model.as_deref() != Some(model) {
        return Err("provider_snapshot_mismatch".to_string());
    }
    let active_key = fs::read(root.join(SNAPSHOT_KEY_FILE))
        .map_err(|_| "provider_snapshot_missing".to_string())
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| "provider_snapshot_invalid".to_string())
        })?;
    if active_key.trim().is_empty() {
        return Err("provider_snapshot_invalid".to_string());
    }
    env_vars.insert(
        "CLI_MANAGER_PROVIDER_KEY_SCOPE".to_string(),
        "snapshot".to_string(),
    );
    apply_grok_runtime_environment(&mut env_vars, base_url, active_key);
    Ok(env_vars)
}

// 只更新 Grok 密钥与模型服务地址环境变量，不修改已有 Home。
fn apply_grok_runtime_environment(
    env_vars: &mut HashMap<String, String>,
    base_url: &str,
    active_key: String,
) {
    env_vars.insert(GROK_PROVIDER_ENV_KEY.to_string(), active_key);
    env_vars.insert(GROK_BASE_URL_ENV_KEY.to_string(), base_url.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    // 验证原生 v2 引用可解析，旧 CC Switch 引用要求迁移。
    fn native_reference_is_required_for_runtime_scope() {
        let raw = r#"{"claude":{"schemaVersion":2,"source":"cli-manager","appType":"claude","providerId":"p1"}}"#;
        assert_eq!(
            parse_provider_reference(Some(raw), "claude").unwrap(),
            Some("p1".to_string())
        );
        let legacy = r#"{"claude":{"providerId":"ccs-p1","settingsPath":"old"}}"#;
        assert_eq!(
            parse_provider_reference(Some(legacy), "claude").unwrap_err(),
            "provider_reference_migration_required"
        );
    }

    #[test]
    // 验证外层 grok 别名可承载 appType 为 grokbuild 的原生引用。
    fn grok_legacy_reference_alias_is_accepted() {
        let raw = r#"{"grok":{"schemaVersion":2,"source":"cli-manager","appType":"grokbuild","providerId":"p1"}}"#;
        assert_eq!(
            parse_provider_reference(Some(raw), "grokbuild").unwrap(),
            Some("p1".to_string())
        );
    }

    #[test]
    // 验证正常快照 ID 被接受，含路径分隔符的越界写法与空 ID 被拒绝。
    fn snapshot_ids_cannot_escape_generated_root() {
        assert!(snapshot_id_valid("snapshot-1"));
        assert!(!snapshot_id_valid("..\\outside"));
        assert!(!snapshot_id_valid(""));
    }

    #[test]
    // 验证快照支持的应用集合固定为 Claude、Codex 与 GrokBuild。
    fn snapshot_app_types_are_native_only() {
        assert_eq!(SNAPSHOT_APP_TYPES, ["claude", "codex", "grokbuild"]);
    }

    // 无项目/Worktree/显式 ID 时必须在查全局 current 之前返回 None：
    // 跟随全局的启动不生成快照，也不会被 provider_current_not_set 阻断。
    #[test]
    // 验证所有支持应用在无有效作用域 ID 时返回 None，不触发全局 current 查询。
    fn missing_scope_ids_resolve_to_global_passthrough_for_every_app_type() {
        for app_type in SNAPSHOT_APP_TYPES {
            let input = ScopeResolveInput {
                app_type: app_type.to_string(),
                project_id: None,
                worktree_id: Some("   ".to_string()),
                provider_id: Some("".to_string()),
            };
            let selection =
                tauri::async_runtime::block_on(scope_override(app_type, &input)).unwrap();
            assert!(
                selection.is_none(),
                "{app_type} without any override must be global passthrough"
            );
        }
    }

    #[test]
    // 验证显式供应商 ID 去除空白后直接生效，来源标记为 explicit。
    fn explicit_provider_id_wins_over_global_for_every_app_type() {
        for app_type in SNAPSHOT_APP_TYPES {
            let input = ScopeResolveInput {
                app_type: app_type.to_string(),
                project_id: None,
                worktree_id: None,
                provider_id: Some("  provider-1  ".to_string()),
            };
            let selection =
                tauri::async_runtime::block_on(scope_override(app_type, &input)).unwrap();
            assert_eq!(
                selection,
                Some(("provider-1".to_string(), "explicit")),
                "{app_type} explicit provider id must not fall back to global"
            );
        }
    }

    #[test]
    // 验证 Codex 快照覆盖项不含测试密钥、不创建替代 Home，并将测试密钥单独写入快照文件。
    fn codex_scope_snapshot_contains_only_non_secret_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("snapshot");
        let provider = NativeProvider {
            id: "provider-1".to_string(),
            name: "Provider".to_string(),
            app_type: "codex".to_string(),
            settings_config: "{}".to_string(),
            meta: "{}".to_string(),
            active_key_id: "key-1".to_string(),
            active_key: "test-secret".to_string(),
        };
        let effective = json!({
            "base_url": "https://api.example.com/v1",
            "model": "gpt-test",
            "auth": {"OPENAI_API_KEY": "test-secret"}
        });

        let (_, generated_home, grok_model, overrides) =
            write_snapshot_bundle(&root, &provider, &effective, "snapshot-1").unwrap();

        assert!(generated_home.is_none());
        assert!(grok_model.is_none());
        assert!(!root.join("codex").exists());
        assert!(overrides
            .iter()
            .any(|value| value.contains("base_url='https://api.example.com/v1'")));
        assert!(overrides.iter().any(|value| value == "model='gpt-test'"));
        assert!(overrides.iter().all(|value| !value.contains("test-secret")));
        assert_eq!(
            fs::read_to_string(root.join(SNAPSHOT_KEY_FILE)).unwrap(),
            "test-secret"
        );
    }

    #[test]
    // 验证相同供应商 ID 生成稳定且仅含允许字符的 Codex profile 名称。
    fn codex_profile_name_is_stable_and_safe() {
        let first = crate::provider::runtime::codex_profile_name("Provider/One");
        assert_eq!(
            first,
            crate::provider::runtime::codex_profile_name("Provider/One")
        );
        assert!(first.starts_with("cli-manager-provider-one-"));
        assert!(first
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
    }

    #[test]
    // 验证 Grok 快照保留实际 Home 策略，仅在清单中记录模型与服务地址。
    fn grok_scope_snapshot_keeps_real_home_and_exposes_runtime_model() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("snapshot");
        let provider = NativeProvider {
            id: "provider-1".to_string(),
            name: "Provider".to_string(),
            app_type: "grokbuild".to_string(),
            settings_config: "{}".to_string(),
            meta: "{}".to_string(),
            active_key_id: "key-1".to_string(),
            active_key: "test-secret".to_string(),
        };
        let effective = json!({
            "config": "[models]\ndefault = \"proxy\"\n[model.proxy]\nmodel = \"grok-test\"\nbase_url = \"https://api.example.com/v1\"\n"
        });

        let (_, generated_home, grok_model, overrides) =
            write_snapshot_bundle(&root, &provider, &effective, "snapshot-1").unwrap();
        let manifest: SnapshotManifest =
            serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();

        assert!(generated_home.is_none());
        assert!(!root.join("grok").exists());
        assert_eq!(grok_model.as_deref(), Some("grok-test"));
        assert_eq!(manifest.grok_model.as_deref(), Some("grok-test"));
        assert_eq!(
            manifest.grok_base_url.as_deref(),
            Some("https://api.example.com/v1")
        );
        assert!(overrides.is_empty());
    }

    #[test]
    // 验证注入 Grok 密钥和地址时保留传入环境表中的 GROK_HOME。
    fn grok_runtime_environment_does_not_replace_home() {
        let mut env_vars = HashMap::from([(
            "GROK_HOME".to_string(),
            r"C:\Users\tester\.grok".to_string(),
        )]);

        apply_grok_runtime_environment(
            &mut env_vars,
            "https://api.example.com/v1",
            "test-secret".to_string(),
        );

        assert_eq!(
            env_vars.get("GROK_HOME").map(String::as_str),
            Some(r"C:\Users\tester\.grok")
        );
        assert_eq!(
            env_vars.get(GROK_BASE_URL_ENV_KEY).map(String::as_str),
            Some("https://api.example.com/v1")
        );
        assert_eq!(
            env_vars.get(GROK_PROVIDER_ENV_KEY).map(String::as_str),
            Some("test-secret")
        );
    }

    #[test]
    // 在临时目录验证旧 Grok 会话先备份后恢复，重复恢复保持内容不变。
    fn legacy_grok_history_is_backed_up_and_restored_idempotently() {
        let directory = tempfile::tempdir().unwrap();
        let snapshot = directory.path().join("snapshot");
        let source_session = snapshot
            .join("grok")
            .join("sessions")
            .join("project")
            .join("session-1");
        fs::create_dir_all(&source_session).unwrap();
        fs::write(source_session.join("updates.jsonl"), "original\n").unwrap();
        let backup = directory.path().join("backup");
        let target = directory.path().join("real-sessions");

        recover_legacy_grok_history_to(&snapshot, &backup, &target).unwrap();
        recover_legacy_grok_history_to(&snapshot, &backup, &target).unwrap();

        assert_eq!(
            fs::read_to_string(backup.join("sessions/project/session-1/updates.jsonl")).unwrap(),
            "original\n"
        );
        assert_eq!(
            fs::read_to_string(target.join("project/session-1/updates.jsonl")).unwrap(),
            "original\n"
        );
    }

    #[test]
    // 在临时目录验证已存在目标会话不被旧历史覆盖，旧内容仍保存到备份。
    fn legacy_grok_history_never_overwrites_existing_real_session() {
        let directory = tempfile::tempdir().unwrap();
        let snapshot = directory.path().join("snapshot");
        let source_session = snapshot
            .join("grok")
            .join("sessions")
            .join("project")
            .join("session-1");
        fs::create_dir_all(&source_session).unwrap();
        fs::write(source_session.join("updates.jsonl"), "legacy\n").unwrap();
        let backup = directory.path().join("backup");
        let target_session = directory
            .path()
            .join("real-sessions")
            .join("project")
            .join("session-1");
        fs::create_dir_all(&target_session).unwrap();
        fs::write(target_session.join("updates.jsonl"), "current\n").unwrap();

        recover_legacy_grok_history_to(&snapshot, &backup, &directory.path().join("real-sessions"))
            .unwrap();

        assert_eq!(
            fs::read_to_string(target_session.join("updates.jsonl")).unwrap(),
            "current\n"
        );
        assert_eq!(
            fs::read_to_string(backup.join("sessions/project/session-1/updates.jsonl")).unwrap(),
            "legacy\n"
        );
    }

    #[test]
    // 验证 WSL 目标路径在备份前被拒绝，原始测试会话保留且备份目录未创建。
    fn legacy_grok_history_wsl_target_fails_before_source_or_backup_changes() {
        let directory = tempfile::tempdir().unwrap();
        let snapshot = directory.path().join("snapshot");
        let source_session = snapshot
            .join("grok")
            .join("sessions")
            .join("project")
            .join("session-1");
        fs::create_dir_all(&source_session).unwrap();
        fs::write(source_session.join("updates.jsonl"), "legacy\n").unwrap();
        let backup = directory.path().join("backup");

        assert_eq!(
            recover_legacy_grok_history_to(
                &snapshot,
                &backup,
                Path::new(r"\\wsl.localhost\Ubuntu\home\tester\.grok\sessions"),
            ),
            Err("provider_snapshot_history_recovery_wsl_unsupported".to_string())
        );
        assert!(source_session.join("updates.jsonl").is_file());
        assert!(!backup.exists());
    }

    #[test]
    // 验证包含指定 shell 插值或连接字符的值无法生成 Codex TOML 字面量。
    fn codex_scope_overrides_reject_shell_interpolation() {
        for value in ["$(whoami)", "`whoami`", "100%", "a&b", "a|b"] {
            assert_eq!(
                codex_toml_literal(value),
                Err("provider_config_invalid".to_string())
            );
        }
    }

    #[test]
    // 验证无效 Codex 配置导致快照生成失败，并清理已建立的临时快照根。
    fn failed_snapshot_materialization_removes_partial_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("snapshot");
        fs::create_dir_all(&root).unwrap();
        let provider = NativeProvider {
            id: "provider-1".to_string(),
            name: "Provider".to_string(),
            app_type: "codex".to_string(),
            settings_config: "{}".to_string(),
            meta: "{}".to_string(),
            active_key_id: "key-1".to_string(),
            active_key: "secret".to_string(),
        };

        let result = write_snapshot_bundle_or_cleanup(
            &root,
            &provider,
            &json!({"config": "["}),
            "snapshot-1",
        );

        assert_eq!(result, Err("provider_config_invalid".to_string()));
        assert!(!root.exists());
    }

    #[test]
    // 验证 Claude 快照序列化同时保留权限字段与模型环境配置。
    fn claude_snapshot_keeps_common_fields() {
        let effective = serde_json::json!({
            "env": { "ANTHROPIC_MODEL": "provider-model" },
            "permissions": { "allow": ["Read"] },
        });
        let bytes = claude_snapshot_bytes(&effective).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["permissions"]["allow"][0], "Read");
        assert_eq!(parsed["env"]["ANTHROPIC_MODEL"], "provider-model");
    }
}
