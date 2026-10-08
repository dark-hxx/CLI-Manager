use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, Row};
use uuid::Uuid;

use super::adapters;
use super::model::{ExtensionCli, McpResource, McpResourceRedacted, McpTransport};
use super::project_skill;
use super::repository;
use super::skill_deployment::{self, SkillInstallationView, SkillPackageView};
use super::skill_repository::{self, SkillPackageRecord};

const DB_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_POLICY_IDS: usize = 512;
const MAX_ID_LENGTH: usize = 256;
const MAX_PROVIDER_SETTINGS_BYTES: u64 = 4 * 1024 * 1024;
const SNAPSHOT_DIR: &str = "project-snapshots";
const SNAPSHOT_MANIFEST: &str = "manifest.json";
const LOCAL_ENVIRONMENT_ID: &str = "host";
const CODEX_PROJECT_PROFILE_PREFIX: &str = "cli-manager-project-";
const CODEX_PROJECT_PROFILE_MARKER: &str = "# cli-manager-project-profile:";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExtensionScopeKind {
    Project,
    Worktree,
}

impl ExtensionScopeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Worktree => "worktree",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExtensionPolicyKind {
    Mcp,
    Skill,
}

impl ExtensionPolicyKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mcp => "mcp",
            Self::Skill => "skill",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExtensionPolicyMode {
    Inherit,
    Custom,
}

impl ExtensionPolicyMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Inherit => "inherit",
            Self::Custom => "custom",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectExtensionPolicyGetRequest {
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub environment_kind: Option<String>,
    pub environment_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectExtensionPolicyInput {
    pub cli: ExtensionCli,
    pub kind: ExtensionPolicyKind,
    pub mode: ExtensionPolicyMode,
    pub selected_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectExtensionPolicySaveRequest {
    pub scope_kind: ExtensionScopeKind,
    pub scope_id: String,
    pub project_id: String,
    pub policies: Vec<ProjectExtensionPolicyInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectExtensionPolicyView {
    pub scope_kind: ExtensionScopeKind,
    pub scope_id: String,
    pub project_id: String,
    pub cli: ExtensionCli,
    pub kind: ExtensionPolicyKind,
    pub mode: ExtensionPolicyMode,
    pub selected_ids: Vec<String>,
    pub effective_ids: Vec<String>,
    pub applied_ids: Vec<String>,
    pub inherited_from: String,
    pub revision: i64,
    pub capability_status: String,
    pub application_status: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectExtensionPolicyResponse {
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub scope_kind: ExtensionScopeKind,
    pub scope_id: String,
    pub resources: Vec<McpResourceRedacted>,
    pub packages: Vec<SkillPackageView>,
    pub policies: Vec<ProjectExtensionPolicyView>,
    pub global_mcp_ids: BTreeMap<String, Vec<String>>,
    pub global_skill_ids: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectExtensionLaunchRequest {
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub cli: ExtensionCli,
    pub environment_kind: String,
    pub environment_id: String,
    pub provider_snapshot_id: Option<String>,
    pub provider_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectExtensionLaunchPlan {
    pub snapshot_id: Option<String>,
    pub policy_revision: i64,
    pub mcp_status: String,
    pub skill_status: String,
    pub mcp_config_path: Option<String>,
    pub claude_settings_path: Option<String>,
    pub codex_config_overrides: Vec<String>,
    pub codex_profile_name: Option<String>,
    pub applied_mcp_ids: Vec<String>,
    pub applied_skill_ids: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    version: u32,
    snapshot_id: String,
    project_id: String,
    worktree_id: Option<String>,
    cli: ExtensionCli,
    environment_kind: String,
    environment_id: String,
    #[serde(default)]
    home_path: Option<String>,
    policy_revision: i64,
    mcp_ids: Vec<String>,
    skill_ids: Vec<String>,
    #[serde(default)]
    codex_profile_name: Option<String>,
    #[serde(default)]
    codex_profile_path: Option<String>,
    #[serde(default)]
    project_skill_targets: Vec<project_skill::ProjectSkillTarget>,
}

#[derive(Clone, Debug)]
struct StoredPolicy {
    scope_kind: ExtensionScopeKind,
    scope_id: String,
    cli: ExtensionCli,
    kind: ExtensionPolicyKind,
    mode: ExtensionPolicyMode,
    selected_ids: Vec<String>,
    revision: i64,
}

#[derive(Clone, Debug)]
struct PolicyResolution {
    scope_kind: ExtensionScopeKind,
    scope_id: String,
    cli: ExtensionCli,
    kind: ExtensionPolicyKind,
    mode: ExtensionPolicyMode,
    selected_ids: Vec<String>,
    effective_ids: Vec<String>,
    applied_ids: Vec<String>,
    inherited_from: String,
    revision: i64,
    capability_status: String,
    application_status: String,
    reason: Option<String>,
}

struct PolicyContext {
    request: ProjectExtensionPolicyGetRequest,
    scope_kind: ExtensionScopeKind,
    scope_id: String,
    records: Vec<repository::McpResourceRecord>,
    packages: Vec<SkillPackageRecord>,
    stored: Vec<StoredPolicy>,
    global_mcp_ids: BTreeMap<String, Vec<String>>,
    global_skill_ids: BTreeMap<String, Vec<String>>,
    project_path: PathBuf,
}

// 读取主库；策略与 canonical MCP/Skill 记录必须在同一个应用数据根下解析。
async fn open_database() -> Result<SqliteConnection, String> {
    let path = crate::app_paths::db_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "extensions_scope_db_parent_create_failed".to_string())?;
    }
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(DB_BUSY_TIMEOUT),
    )
    .await
    .map_err(|_| "extensions_scope_db_open_failed".to_string())?;
    super::database::ensure_schema(&mut connection).await?;
    Ok(connection)
}

// 校验项目与 Worktree 归属，防止同一路径下不同项目或 Worktree 互相读取策略。
async fn validate_scope(
    project_id: &str,
    worktree_id: Option<&str>,
    scope_kind: ExtensionScopeKind,
    scope_id: &str,
) -> Result<(), String> {
    let project_id = validate_id(project_id, "extensions_scope_project_invalid")?;
    let scope_id = validate_id(scope_id, "extensions_scope_id_invalid")?;
    let mut connection = open_database().await?;
    let project_exists = sqlx::query("SELECT id FROM projects WHERE id = ?1")
        .bind(project_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "extensions_scope_project_read_failed".to_string())?
        .is_some();
    if !project_exists {
        return Err("extensions_scope_project_not_found".to_string());
    }
    match scope_kind {
        ExtensionScopeKind::Project => {
            if scope_id != project_id || worktree_id.is_some() {
                return Err("extensions_scope_identity_mismatch".to_string());
            }
        }
        ExtensionScopeKind::Worktree => {
            let worktree_project = sqlx::query("SELECT project_id FROM worktrees WHERE id = ?1")
                .bind(scope_id)
                .fetch_optional(&mut connection)
                .await
                .map_err(|_| "extensions_scope_worktree_read_failed".to_string())?
                .ok_or_else(|| "extensions_scope_worktree_not_found".to_string())?
                .try_get::<String, _>("project_id")
                .map_err(|_| "extensions_scope_worktree_corrupt".to_string())?;
            if worktree_project != project_id || worktree_id != Some(scope_id) {
                return Err("extensions_scope_identity_mismatch".to_string());
            }
        }
    }
    Ok(())
}

// 加载同一项目的项目/Worktree策略；缺失行代表 inherit，不复制全局列表到项目表。
async fn load_stored_policies(project_id: &str) -> Result<Vec<StoredPolicy>, String> {
    let mut connection = open_database().await?;
    let rows = sqlx::query(
        "SELECT scope_kind, scope_id, project_id, cli, extension_kind, mode,
                selected_ids_json, revision
         FROM extension_scope_policies
         WHERE project_id = ?1
         ORDER BY scope_kind ASC, scope_id ASC, cli ASC, extension_kind ASC",
    )
    .bind(project_id)
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "extensions_scope_policy_read_failed".to_string())?;
    rows.into_iter().map(decode_policy).collect()
}

fn decode_policy(row: sqlx::sqlite::SqliteRow) -> Result<StoredPolicy, String> {
    let scope_kind = parse_scope_kind(
        &row.try_get::<String, _>("scope_kind")
            .map_err(|_| "extensions_scope_policy_corrupt".to_string())?,
    )?;
    let cli = parse_cli(
        &row.try_get::<String, _>("cli")
            .map_err(|_| "extensions_scope_policy_corrupt".to_string())?,
    )?;
    let kind = parse_policy_kind(
        &row.try_get::<String, _>("extension_kind")
            .map_err(|_| "extensions_scope_policy_corrupt".to_string())?,
    )?;
    let mode = parse_policy_mode(
        &row.try_get::<String, _>("mode")
            .map_err(|_| "extensions_scope_policy_corrupt".to_string())?,
    )?;
    let selected_json: String = row
        .try_get("selected_ids_json")
        .map_err(|_| "extensions_scope_policy_corrupt".to_string())?;
    let selected_ids: Vec<String> = serde_json::from_str(&selected_json)
        .map_err(|_| "extensions_scope_policy_corrupt".to_string())?;
    let selected_ids = normalize_ids(selected_ids)?;
    let revision: i64 = row
        .try_get("revision")
        .map_err(|_| "extensions_scope_policy_corrupt".to_string())?;
    if revision < 1 {
        return Err("extensions_scope_policy_corrupt".to_string());
    }
    Ok(StoredPolicy {
        scope_kind,
        scope_id: row
            .try_get("scope_id")
            .map_err(|_| "extensions_scope_policy_corrupt".to_string())?,
        cli,
        kind,
        mode,
        selected_ids,
        revision,
    })
}

// 枚举当前目标的实际全局 Skill 安装；外部修改或丢失的实例不能伪装成有效全局状态。
fn global_skill_ids(
    packages: &[SkillPackageRecord],
    installations: &[SkillInstallationView],
) -> BTreeMap<String, Vec<String>> {
    let package_ids = packages
        .iter()
        .map(|package| package.package_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for cli in ExtensionCli::all() {
        let mut ids = installations
            .iter()
            .filter(|installation| {
                installation.cli == cli
                    && installation.owned
                    && !installation.external_modified
                    && installation.status == "active"
                    && package_ids.contains(installation.package_id.as_str())
            })
            .map(|installation| installation.package_id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        result.insert(cli.key().to_string(), ids);
    }
    result
}

async fn build_context(request: ProjectExtensionPolicyGetRequest) -> Result<PolicyContext, String> {
    let project_id =
        validate_id(&request.project_id, "extensions_scope_project_invalid")?.to_string();
    let worktree_id = request
        .worktree_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let scope_kind = if worktree_id.is_some() {
        ExtensionScopeKind::Worktree
    } else {
        ExtensionScopeKind::Project
    };
    let scope_id = worktree_id.unwrap_or(&project_id).to_string();
    validate_scope(&project_id, worktree_id, scope_kind, &scope_id).await?;
    let project_path = super::scope_path::load(&project_id, worktree_id).await?;

    let records = repository::list_mcp_resource_records().await?;
    let packages = skill_repository::list_packages().await?;
    let stored = load_stored_policies(&project_id).await?;
    let environment_kind = request
        .environment_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let environment_id = request
        .environment_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let installations =
        skill_deployment::list_installation_views_for_environment(environment_kind, environment_id)
            .await?;
    let mut global_mcp_ids = BTreeMap::new();
    for cli in ExtensionCli::all() {
        global_mcp_ids.insert(cli.key().to_string(), {
            let mut ids = records
                .iter()
                .filter(|record| record.resource.enabled_for(cli))
                .map(|record| record.resource.resource_id.clone())
                .collect::<Vec<_>>();
            ids.sort();
            ids.dedup();
            ids
        });
    }
    let global_skill_ids = global_skill_ids(&packages, &installations);
    Ok(PolicyContext {
        request: ProjectExtensionPolicyGetRequest {
            project_id,
            worktree_id: worktree_id.map(str::to_string),
            environment_kind: environment_kind.map(str::to_string),
            environment_id: environment_id.map(str::to_string),
        },
        scope_kind,
        scope_id,
        records,
        packages,
        stored,
        global_mcp_ids,
        global_skill_ids,
        project_path,
    })
}

fn resolve_policy(
    context: &PolicyContext,
    cli: ExtensionCli,
    kind: ExtensionPolicyKind,
) -> PolicyResolution {
    let local = context.stored.iter().find(|policy| {
        policy.scope_kind == context.scope_kind
            && policy.scope_id == context.scope_id
            && policy.cli == cli
            && policy.kind == kind
    });
    let project = context.stored.iter().find(|policy| {
        policy.scope_kind == ExtensionScopeKind::Project
            && policy.scope_id == context.request.project_id
            && policy.cli == cli
            && policy.kind == kind
    });
    let (mode, selected_ids, inherited_from, revision) = if let Some(policy) =
        local.filter(|policy| policy.mode == ExtensionPolicyMode::Custom)
    {
        (
            policy.mode,
            policy.selected_ids.clone(),
            context.scope_kind.as_str().to_string(),
            policy.revision,
        )
    } else if context.scope_kind == ExtensionScopeKind::Worktree {
        if let Some(policy) = project.filter(|policy| policy.mode == ExtensionPolicyMode::Custom) {
            (
                ExtensionPolicyMode::Inherit,
                policy.selected_ids.clone(),
                "project".to_string(),
                policy.revision,
            )
        } else {
            (
                ExtensionPolicyMode::Inherit,
                Vec::new(),
                "global".to_string(),
                0,
            )
        }
    } else {
        (
            ExtensionPolicyMode::Inherit,
            Vec::new(),
            "global".to_string(),
            0,
        )
    };
    let global_ids = match kind {
        ExtensionPolicyKind::Mcp => context
            .global_mcp_ids
            .get(cli.key())
            .cloned()
            .unwrap_or_default(),
        ExtensionPolicyKind::Skill => context
            .global_skill_ids
            .get(cli.key())
            .cloned()
            .unwrap_or_default(),
    };
    let available_ids = match kind {
        ExtensionPolicyKind::Mcp => context
            .records
            .iter()
            .map(|record| record.resource.resource_id.clone())
            .collect::<BTreeSet<_>>(),
        ExtensionPolicyKind::Skill => context
            .packages
            .iter()
            .map(|package| package.package_id.clone())
            .collect::<BTreeSet<_>>(),
    };
    let effective_ids = if mode == ExtensionPolicyMode::Custom {
        selected_ids.clone()
    } else if inherited_from == "project" {
        project
            .map(|policy| policy.selected_ids.clone())
            .unwrap_or(global_ids.clone())
    } else {
        global_ids.clone()
    };
    let invalid_ids = invalid_ids(&effective_ids, &available_ids);
    let capability_status = if cli == ExtensionCli::Grok {
        "globalOnly"
    } else {
        "supported"
    };
    let mut application_status = "applied".to_string();
    let mut reason = None;
    if capability_status == "globalOnly" {
        application_status = "globalOnly".to_string();
        reason = Some("extensions_project_grok_global_only".to_string());
    } else if mode == ExtensionPolicyMode::Custom && !invalid_ids.is_empty() {
        application_status = "error".to_string();
        reason = Some(format!(
            "extensions_project_policy_invalid_ids:{}",
            invalid_ids.join(",")
        ));
    }
    let applied_ids = if application_status == "applied" {
        effective_ids.clone()
    } else {
        global_ids
    };
    PolicyResolution {
        scope_kind: context.scope_kind,
        scope_id: context.scope_id.clone(),
        cli,
        kind,
        mode,
        selected_ids,
        effective_ids,
        applied_ids,
        inherited_from,
        revision,
        capability_status: capability_status.to_string(),
        application_status,
        reason,
    }
}

fn build_policy_views(context: &PolicyContext) -> Vec<ProjectExtensionPolicyView> {
    let mut views = Vec::with_capacity(6);
    for cli in ExtensionCli::all() {
        for kind in [ExtensionPolicyKind::Mcp, ExtensionPolicyKind::Skill] {
            let resolved = resolve_policy(context, cli, kind);
            views.push(ProjectExtensionPolicyView {
                scope_kind: resolved.scope_kind,
                scope_id: resolved.scope_id,
                project_id: context.request.project_id.clone(),
                cli: resolved.cli,
                kind: resolved.kind,
                mode: resolved.mode,
                selected_ids: resolved.selected_ids,
                effective_ids: resolved.effective_ids,
                applied_ids: resolved.applied_ids,
                inherited_from: resolved.inherited_from,
                revision: resolved.revision,
                capability_status: resolved.capability_status,
                application_status: resolved.application_status,
                reason: resolved.reason,
            });
        }
    }
    views
}

// 返回项目编辑器所需的脱敏资源、包列表和六个独立策略，不把全局列表副本写入项目表。
pub(crate) async fn get_policy(
    request: ProjectExtensionPolicyGetRequest,
) -> Result<ProjectExtensionPolicyResponse, String> {
    let context = build_context(request).await?;
    let resources = context
        .records
        .iter()
        .map(|record| super::model::redact_resource(&record.resource))
        .collect();
    let packages = context
        .packages
        .iter()
        .map(package_view)
        .collect::<Result<Vec<_>, _>>()?;
    let policies = build_policy_views(&context);
    Ok(ProjectExtensionPolicyResponse {
        project_id: context.request.project_id.clone(),
        worktree_id: context.request.worktree_id.clone(),
        scope_kind: context.scope_kind,
        scope_id: context.scope_id.clone(),
        resources,
        packages,
        policies,
        global_mcp_ids: context.global_mcp_ids.clone(),
        global_skill_ids: context.global_skill_ids.clone(),
    })
}

// 仅写入显式 custom 行；inherit 删除覆盖行，后续自然跟随项目或全局最新状态。
pub(crate) async fn save_policy(request: ProjectExtensionPolicySaveRequest) -> Result<(), String> {
    let project_id = validate_id(&request.project_id, "extensions_scope_project_invalid")?;
    let worktree_id =
        (request.scope_kind == ExtensionScopeKind::Worktree).then_some(request.scope_id.as_str());
    validate_scope(
        project_id,
        worktree_id,
        request.scope_kind,
        &request.scope_id,
    )
    .await?;
    let mut values = BTreeMap::new();
    for policy in request.policies {
        let selected_ids = normalize_ids(policy.selected_ids)?;
        if values
            .insert((policy.cli, policy.kind), (policy.mode, selected_ids))
            .is_some()
        {
            return Err("extensions_scope_policy_duplicate".to_string());
        }
    }
    let mut connection = open_database().await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|_| "extensions_scope_db_busy".to_string())?;
    let result = save_policy_rows(
        &mut connection,
        request.scope_kind,
        &request.scope_id,
        project_id,
        &values,
    )
    .await;
    match result {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut connection)
            .await
            .map(|_| ())
            .map_err(|_| "extensions_scope_policy_commit_failed".to_string()),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
            Err(error)
        }
    }
}

async fn save_policy_rows(
    connection: &mut SqliteConnection,
    scope_kind: ExtensionScopeKind,
    scope_id: &str,
    project_id: &str,
    values: &BTreeMap<(ExtensionCli, ExtensionPolicyKind), (ExtensionPolicyMode, Vec<String>)>,
) -> Result<(), String> {
    let now = skill_repository::now_ms();
    for cli in ExtensionCli::all() {
        for kind in [ExtensionPolicyKind::Mcp, ExtensionPolicyKind::Skill] {
            // A project dialog edits its configured CLI only; omission must preserve other CLI policies.
            let Some((mode, selected_ids)) = values.get(&(cli, kind)).cloned() else {
                continue;
            };
            if mode == ExtensionPolicyMode::Inherit {
                sqlx::query(
                    "DELETE FROM extension_scope_policies
                     WHERE scope_kind = ?1 AND scope_id = ?2 AND cli = ?3 AND extension_kind = ?4",
                )
                .bind(scope_kind.as_str())
                .bind(scope_id)
                .bind(cli.key())
                .bind(kind.as_str())
                .execute(&mut *connection)
                .await
                .map_err(|_| "extensions_scope_policy_delete_failed".to_string())?;
                continue;
            }
            let current_revision = sqlx::query(
                "SELECT revision FROM extension_scope_policies
                 WHERE scope_kind = ?1 AND scope_id = ?2 AND cli = ?3 AND extension_kind = ?4",
            )
            .bind(scope_kind.as_str())
            .bind(scope_id)
            .bind(cli.key())
            .bind(kind.as_str())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| "extensions_scope_policy_read_failed".to_string())?
            .map(|row| row.try_get::<i64, _>("revision"))
            .transpose()
            .map_err(|_| "extensions_scope_policy_corrupt".to_string())?
            .unwrap_or(0);
            let revision = current_revision.checked_add(1).unwrap_or(1).max(1);
            let selected_json = serde_json::to_string(&selected_ids)
                .map_err(|_| "extensions_scope_policy_serialize_failed".to_string())?;
            sqlx::query(
                "INSERT INTO extension_scope_policies
                 (scope_kind, scope_id, project_id, cli, extension_kind, mode,
                  selected_ids_json, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT(scope_kind, scope_id, cli, extension_kind)
                 DO UPDATE SET project_id = excluded.project_id, mode = excluded.mode,
                   selected_ids_json = excluded.selected_ids_json, revision = excluded.revision,
                   updated_at = excluded.updated_at",
            )
            .bind(scope_kind.as_str())
            .bind(scope_id)
            .bind(project_id)
            .bind(cli.key())
            .bind(kind.as_str())
            .bind(mode.as_str())
            .bind(selected_json)
            .bind(revision)
            .bind(now)
            .execute(&mut *connection)
            .await
            .map_err(|_| "extensions_scope_policy_write_failed".to_string())?;
        }
    }
    Ok(())
}

// 生成当前 CLI 的启动快照；Grok 只返回 globalOnly，不接管 Home 或伪造项目隔离。
pub(crate) async fn prepare_launch(
    request: ProjectExtensionLaunchRequest,
) -> Result<ProjectExtensionLaunchPlan, String> {
    let environment_kind = request.environment_kind.trim().to_ascii_lowercase();
    let environment_id = request.environment_id.trim();
    if !matches!(environment_kind.as_str(), "local" | "wsl") || environment_id.is_empty() {
        return Err("extensions_project_environment_invalid".to_string());
    }
    if environment_kind == "local" && environment_id != LOCAL_ENVIRONMENT_ID {
        return Err("extensions_project_environment_invalid".to_string());
    }
    let context = build_context(ProjectExtensionPolicyGetRequest {
        project_id: request.project_id.clone(),
        worktree_id: request.worktree_id.clone(),
        environment_kind: Some(environment_kind.clone()),
        environment_id: Some(environment_id.to_string()),
    })
    .await?;
    let mcp = resolve_policy(&context, request.cli, ExtensionPolicyKind::Mcp);
    let skill = resolve_policy(&context, request.cli, ExtensionPolicyKind::Skill);
    let mut plan = ProjectExtensionLaunchPlan {
        snapshot_id: None,
        policy_revision: mcp.revision.max(skill.revision),
        mcp_status: mcp.application_status.clone(),
        skill_status: skill.application_status.clone(),
        mcp_config_path: None,
        claude_settings_path: None,
        codex_config_overrides: Vec::new(),
        codex_profile_name: None,
        applied_mcp_ids: mcp.applied_ids.clone(),
        applied_skill_ids: skill.applied_ids.clone(),
        warnings: [mcp.reason.clone(), skill.reason.clone()]
            .into_iter()
            .flatten()
            .collect(),
    };
    if request.cli == ExtensionCli::Grok {
        return Ok(plan);
    }

    let mcp_resources = resources_for_resolution(&context, &mcp);
    let mcp_needs_snapshot = needs_project_snapshot(&mcp);
    let skill_needs_snapshot = needs_project_snapshot(&skill);
    if request.cli == ExtensionCli::Claude {
        if mcp_needs_snapshot {
            match adapters::project_native_config_for_launch(request.cli, &mcp_resources) {
                Ok(content) => {
                    let (snapshot_id, root) =
                        create_snapshot_root(&request, &context, &mcp, &skill, &[])?;
                    let path = root.join("claude").join("mcp.json");
                    let environment_path = match path_for_environment(&path, &environment_kind) {
                        Ok(value) => value,
                        Err(error) => {
                            let _ = fs::remove_dir_all(&root);
                            return Err(error);
                        }
                    };
                    if let Err(error) = write_snapshot_file(&path, content.as_bytes()) {
                        let _ = fs::remove_dir_all(&root);
                        return Err(error);
                    }
                    plan.snapshot_id = Some(snapshot_id);
                    plan.mcp_config_path = Some(environment_path);
                }
                Err(error) => {
                    plan.mcp_status = "error".to_string();
                    plan.warnings.push(error);
                    plan.applied_mcp_ids = context
                        .global_mcp_ids
                        .get(request.cli.key())
                        .cloned()
                        .unwrap_or_default();
                }
            }
        }
        if skill_needs_snapshot && plan.skill_status == "applied" {
            match write_claude_skill_settings(
                &request,
                &context,
                &mcp,
                &skill,
                plan.snapshot_id.clone(),
            ) {
                Ok((snapshot_id, path)) => {
                    let environment_path = match path_for_environment(&path, &environment_kind) {
                        Ok(value) => value,
                        Err(error) => {
                            let _ = release_snapshot(snapshot_id);
                            return Err(error);
                        }
                    };
                    plan.snapshot_id = Some(snapshot_id);
                    plan.claude_settings_path = Some(environment_path);
                }
                Err(error) => {
                    plan.skill_status = "error".to_string();
                    plan.warnings.push(error);
                    plan.applied_skill_ids = context
                        .global_skill_ids
                        .get(request.cli.key())
                        .cloned()
                        .unwrap_or_default();
                }
            }
        }
    } else if request.cli == ExtensionCli::Codex {
        let mut project_skill_targets = Vec::new();
        if mcp_needs_snapshot {
            match codex_mcp_overrides(&context, &mcp) {
                Ok(overrides) => plan.codex_config_overrides.extend(overrides),
                Err(error) => {
                    plan.mcp_status = "error".to_string();
                    plan.warnings.push(error);
                    plan.applied_mcp_ids = context
                        .global_mcp_ids
                        .get(request.cli.key())
                        .cloned()
                        .unwrap_or_default();
                }
            }
        }
        if skill_needs_snapshot && plan.skill_status == "applied" {
            match project_skill::reject_non_local(&environment_kind).and_then(|_| {
                project_skill::materialize_local(
                    &context.project_path,
                    &context.packages,
                    &skill.applied_ids,
                    &project_skill::managed_target_paths(),
                )
            }) {
                Ok(targets) => match codex_skill_override(&context, &targets) {
                    Ok(override_value) => {
                        project_skill_targets = targets;
                        // A custom project set is a whitelist: disable Codex's bundled
                        // skills as well as every discovered file before enabling the target.
                        plan.codex_config_overrides
                            .push("skills.bundled.enabled=false".to_string());
                        plan.codex_config_overrides.push(override_value);
                    }
                    Err(error) => {
                        project_skill::cleanup_uncommitted(&targets);
                        plan.skill_status = "error".to_string();
                        plan.warnings.push(error);
                        plan.applied_skill_ids = context
                            .global_skill_ids
                            .get(request.cli.key())
                            .cloned()
                            .unwrap_or_default();
                    }
                },
                Err(error) => {
                    plan.skill_status = "error".to_string();
                    plan.warnings.push(error);
                    plan.applied_skill_ids = context
                        .global_skill_ids
                        .get(request.cli.key())
                        .cloned()
                        .unwrap_or_default();
                }
            }
        }
        if !plan.codex_config_overrides.is_empty() {
            let (snapshot_id, _root) = match create_snapshot_root(
                &request,
                &context,
                &mcp,
                &skill,
                &project_skill_targets,
            ) {
                Ok(value) => value,
                Err(error) => {
                    project_skill::cleanup_uncommitted(&project_skill_targets);
                    return Err(error);
                }
            };
            plan.snapshot_id = Some(snapshot_id);
            if environment_kind == "local" {
                let provider_config = match (
                    request.provider_snapshot_id.as_deref(),
                    request.provider_id.as_deref(),
                ) {
                    (Some(snapshot_id), Some(provider_id)) => {
                        crate::provider::scope::codex_profile_config_for_snapshot(
                            snapshot_id,
                            provider_id,
                        )
                        .ok()
                        .filter(|config| !config.trim().is_empty())
                    }
                    (None, None) => Some(String::new()),
                    _ => None,
                };
                if let Some(provider_config) = provider_config {
                    if let Some(snapshot_id) = plan.snapshot_id.as_deref() {
                        if let Ok((profile_name, profile_path)) = write_codex_project_profile(
                            snapshot_id,
                            &provider_config,
                            &plan.codex_config_overrides,
                        ) {
                            if mark_codex_project_profile(snapshot_id, &profile_name, &profile_path)
                                .is_ok()
                            {
                                plan.codex_profile_name = Some(profile_name);
                            } else {
                                let profile_path = profile_path.to_string_lossy().into_owned();
                                let _ = remove_codex_project_profile(
                                    snapshot_id,
                                    &profile_name,
                                    Some(&profile_path),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(plan)
}

// Inherited project custom sets (including empty sets) still require isolation; global inheritance does not.
fn needs_project_snapshot(resolution: &PolicyResolution) -> bool {
    resolution.application_status == "applied" && resolution.inherited_from != "global"
}

fn resources_for_resolution(
    context: &PolicyContext,
    resolution: &PolicyResolution,
) -> Vec<McpResource> {
    let selected = resolution.applied_ids.iter().collect::<BTreeSet<_>>();
    context
        .records
        .iter()
        .filter(|record| selected.contains(&record.resource.resource_id))
        .map(|record| {
            let mut resource = record.resource.clone();
            if needs_project_snapshot(resolution) {
                resource
                    .enabled_by_cli
                    .insert(resolution.cli.key().to_string(), true);
            }
            resource
        })
        .collect()
}

fn codex_mcp_overrides(
    context: &PolicyContext,
    resolution: &PolicyResolution,
) -> Result<Vec<String>, String> {
    let selected = resolution.applied_ids.iter().collect::<BTreeSet<_>>();
    let mut overrides = Vec::new();
    for record in &context.records {
        let resource = &record.resource;
        if !safe_codex_key(&resource.server_key) {
            return Err(format!(
                "extensions_project_codex_server_key_unsupported:{}",
                resource.resource_id
            ));
        }
        let enabled = selected.contains(&resource.resource_id);
        // Codex only supports stdio and Streamable HTTP. Never create an
        // enable-only SSE entry: Codex validates every table at startup,
        // including disabled entries, and reports "invalid transport".
        if resource.transport == McpTransport::Sse {
            if enabled {
                return Err("extensions_project_codex_transport_unsupported".to_string());
            }
            continue;
        }
        overrides.extend(codex_mcp_resource_overrides(resource, enabled)?);
    }
    Ok(overrides)
}

// 生成可直接交给 `codex -c` 的完整 MCP 基础字段；仅选中资源携带环境/请求头，避免把禁用项的秘密带入命令行。
fn codex_mcp_resource_overrides(
    resource: &McpResource,
    enabled: bool,
) -> Result<Vec<String>, String> {
    if enabled && !resource.secret_refs.is_empty() {
        return Err("extensions_secret_reference_unresolved".to_string());
    }
    let prefix = format!("mcp_servers.{}", resource.server_key);
    let mut overrides = Vec::new();
    match resource.transport {
        McpTransport::Stdio => {
            let command = resource
                .command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "extensions_project_codex_mcp_definition_invalid".to_string())?;
            overrides.push(format!(
                "{prefix}.command={}",
                codex_override_literal(command, "command")?
            ));
            let args = resource
                .args
                .iter()
                .enumerate()
                .map(|(index, value)| codex_override_literal(value, &format!("args[{index}]")))
                .collect::<Result<Vec<_>, _>>()?;
            overrides.push(format!("{prefix}.args=[{}]", args.join(",")));
            if let Some(cwd) = resource.cwd.as_deref() {
                overrides.push(format!(
                    "{prefix}.cwd={}",
                    codex_override_literal(cwd, "cwd")?
                ));
            }
            if enabled {
                append_codex_map_overrides(&mut overrides, &prefix, "env", &resource.env)?;
            }
        }
        McpTransport::StreamableHttp => {
            let url = resource
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "extensions_project_codex_mcp_definition_invalid".to_string())?;
            overrides.push(format!(
                "{prefix}.url={}",
                codex_override_literal(url, "url")?
            ));
            if enabled {
                append_codex_map_overrides(
                    &mut overrides,
                    &prefix,
                    "http_headers",
                    &resource.headers,
                )?;
            }
        }
        McpTransport::Sse => {
            return Err("extensions_project_codex_transport_unsupported".to_string());
        }
    }
    if enabled {
        if let Some(timeout) = resource.timeout.as_ref() {
            append_codex_timeout_override(
                &mut overrides,
                &prefix,
                "startup_timeout_sec",
                timeout.startup_ms,
            )?;
            append_codex_timeout_override(
                &mut overrides,
                &prefix,
                "tool_timeout_sec",
                timeout.request_ms,
            )?;
        }
    }
    overrides.push(format!("{prefix}.enabled={enabled}"));
    Ok(overrides)
}

// `-c` 的嵌套 map 只能通过逐项 dotted override 写入；键名限制避免把用户值解释成另一层 TOML 路径。
fn append_codex_map_overrides(
    overrides: &mut Vec<String>,
    prefix: &str,
    field: &str,
    values: &BTreeMap<String, String>,
) -> Result<(), String> {
    for (key, value) in values {
        if !safe_codex_key(key) {
            return Err(format!(
                "extensions_project_codex_map_key_unsupported:{field}"
            ));
        }
        overrides.push(format!(
            "{prefix}.{field}.{key}={}",
            codex_override_literal(value, &format!("{field}.{key}"))?
        ));
    }
    Ok(())
}

// Codex CLI 的配置覆盖由终端层包在双引号中；与前端命令校验保持同一组 shell 特殊字符禁区。
fn codex_override_literal(value: &str, field: &str) -> Result<String, String> {
    if value.chars().any(|ch| {
        ch.is_control()
            || matches!(
                ch,
                '"' | '%' | '!' | '^' | '&' | '|' | '<' | '>' | '$' | '`'
            )
    }) || value.contains("'''")
    {
        return Err(format!(
            "extensions_project_codex_value_unsupported:{field}"
        ));
    }
    Ok(format!("'''{value}'''"))
}

// Codex timeout 只接受正整数秒；项目启动失败应回退到全局，不发送截断后的错误配置。
fn append_codex_timeout_override(
    overrides: &mut Vec<String>,
    prefix: &str,
    field: &str,
    milliseconds: Option<u64>,
) -> Result<(), String> {
    let Some(milliseconds) = milliseconds else {
        return Ok(());
    };
    if milliseconds == 0 || milliseconds % 1000 != 0 {
        return Err("extensions_project_codex_timeout_not_representable".to_string());
    }
    overrides.push(format!("{prefix}.{field}={}", milliseconds / 1000));
    Ok(())
}

fn codex_skill_override(
    context: &PolicyContext,
    targets: &[project_skill::ProjectSkillTarget],
) -> Result<String, String> {
    let mut entries = Vec::new();
    for path in project_skill::discovered_codex_skill_paths(&context.project_path)? {
        entries.push(format!(
            "{{path={},enabled=false}}",
            codex_override_literal(&path.to_string_lossy(), "skill.path")?
        ));
    }
    for target in targets {
        let path = PathBuf::from(&target.path).join("SKILL.md");
        entries.push(format!(
            "{{path={},enabled=true}}",
            codex_override_literal(&path.to_string_lossy(), "skill.project_path",)?
        ));
    }
    Ok(format!("skills.config=[{}]", entries.join(",")))
}

// 为本机 Codex 项目策略生成唯一 profile 名称；快照 ID 已经过路径校验，可安全进入文件名。
fn codex_project_profile_name(snapshot_id: &str) -> String {
    format!("{CODEX_PROJECT_PROFILE_PREFIX}{snapshot_id}")
}

// 根据受管 profile 名称解析当前默认 Codex 配置文件路径，不接受目录穿越或外部名称。
fn codex_project_profile_path(profile_name: &str) -> Result<PathBuf, String> {
    let snapshot_id = profile_name
        .strip_prefix(CODEX_PROJECT_PROFILE_PREFIX)
        .filter(|value| valid_snapshot_id(value))
        .ok_or_else(|| "extensions_project_codex_profile_invalid".to_string())?;
    let config_dir = crate::provider::home::default_config_root("codex")
        .ok_or_else(|| "extensions_project_codex_profile_unavailable".to_string())?;
    Ok(config_dir.join(format!(
        "{}.config.toml",
        codex_project_profile_name(snapshot_id)
    )))
}

// 项目 profile 只接收 dotted key；值沿用已生成的 TOML 文本，并拒绝换行与控制字符。
fn validate_codex_profile_override(value: &str) -> Result<&str, String> {
    let value = value.trim();
    let (key, toml_value) = value
        .split_once('=')
        .ok_or_else(|| "extensions_project_codex_profile_invalid".to_string())?;
    let key = key.trim();
    if key.is_empty() || key.split('.').any(|segment| !safe_codex_key(segment)) {
        return Err("extensions_project_codex_profile_invalid".to_string());
    }
    let toml_value = toml_value.trim();
    if toml_value.is_empty() || toml_value.chars().any(char::is_control) {
        return Err("extensions_project_codex_profile_invalid".to_string());
    }
    Ok(value)
}

// -c 为了穿过 Windows shell 使用三单引号；写入 TOML 文件时改成正确转义的普通字符串。
fn normalize_codex_profile_override(value: &str) -> Result<String, String> {
    let value = validate_codex_profile_override(value)?;
    let (key, toml_value) = value
        .split_once('=')
        .ok_or_else(|| "extensions_project_codex_profile_invalid".to_string())?;
    let mut normalized = String::new();
    let mut remaining = toml_value.trim();
    while let Some(start) = remaining.find("'''") {
        normalized.push_str(&remaining[..start]);
        let content_start = start + 3;
        let end = remaining[content_start..]
            .find("'''")
            .ok_or_else(|| "extensions_project_codex_profile_invalid".to_string())?;
        let content = &remaining[content_start..content_start + end];
        normalized.push_str(toml_edit::value(content).to_string().trim());
        remaining = &remaining[content_start + end + 3..];
    }
    normalized.push_str(remaining);
    Ok(format!("{}={normalized}", key.trim()))
}

// 保留供应商完整配置，再按顺序覆盖项目扩展字段，避免重复 TOML 键或丢失无关配置。
fn codex_profile_content(
    snapshot_id: &str,
    base_config: &str,
    overrides: &[String],
) -> Result<Vec<u8>, String> {
    if !valid_snapshot_id(snapshot_id) || overrides.is_empty() {
        return Err("extensions_project_codex_profile_invalid".to_string());
    }
    let mut document = base_config
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| "extensions_project_codex_profile_invalid".to_string())?;
    for override_value in overrides {
        let override_document = normalize_codex_profile_override(override_value)?
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "extensions_project_codex_profile_invalid".to_string())?;
        crate::provider::repository::merge_toml_items(
            document.as_item_mut(),
            override_document.into_item(),
        );
    }
    let content = format!("{CODEX_PROJECT_PROFILE_MARKER}{snapshot_id}\n{document}");
    toml::from_str::<toml::Value>(&content)
        .map_err(|_| "extensions_project_codex_profile_invalid".to_string())?;
    Ok(content.into_bytes())
}

// 在 Codex 默认配置根创建 CLI-Manager 独占文件，不覆盖用户已有的同名 profile。
fn write_codex_project_profile(
    snapshot_id: &str,
    base_config: &str,
    overrides: &[String],
) -> Result<(String, PathBuf), String> {
    let profile_name = codex_project_profile_name(snapshot_id);
    let path = codex_project_profile_path(&profile_name)?;
    let content = codex_profile_content(snapshot_id, base_config, overrides)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "extensions_project_codex_profile_unavailable".to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "extensions_project_codex_profile_unavailable".to_string())?;
    if file.write_all(&content).is_err() {
        let _ = fs::remove_file(&path);
        return Err("extensions_project_codex_profile_unavailable".to_string());
    }
    Ok((profile_name, path))
}

// 仅接受由本次快照生成的 profile，避免清理时误删用户手工创建的 Codex 配置。
fn remove_codex_project_profile(
    snapshot_id: &str,
    profile_name: &str,
    profile_path: Option<&str>,
) -> Result<(), String> {
    if profile_name != codex_project_profile_name(snapshot_id) {
        return Err("extensions_project_snapshot_invalid".to_string());
    }
    let path = if let Some(profile_path) = profile_path {
        let path = PathBuf::from(profile_path);
        let expected_name = format!("{profile_name}.config.toml");
        if !path.is_absolute()
            || path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str())
        {
            return Err("extensions_project_snapshot_invalid".to_string());
        }
        path
    } else {
        codex_project_profile_path(profile_name)
            .map_err(|_| "extensions_project_codex_profile_release_failed".to_string())?
    };
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("extensions_project_codex_profile_release_failed".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("extensions_project_codex_profile_release_failed".to_string());
    }
    let marker = format!("{CODEX_PROJECT_PROFILE_MARKER}{snapshot_id}\n");
    let bytes = fs::read(&path)
        .map_err(|_| "extensions_project_codex_profile_release_failed".to_string())?;
    if !bytes.starts_with(marker.as_bytes()) {
        return Err("extensions_project_codex_profile_release_conflict".to_string());
    }
    fs::remove_file(path).map_err(|_| "extensions_project_codex_profile_release_failed".to_string())
}

// profile 文件写入后再登记到快照清单，释放与 GC 才会拥有明确的删除边界。
fn mark_codex_project_profile(
    snapshot_id: &str,
    profile_name: &str,
    profile_path: &Path,
) -> Result<(), String> {
    if profile_name != codex_project_profile_name(snapshot_id) {
        return Err("extensions_project_snapshot_invalid".to_string());
    }
    let expected_name = format!("{profile_name}.config.toml");
    if !profile_path.is_absolute()
        || profile_path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str())
    {
        return Err("extensions_project_snapshot_invalid".to_string());
    }
    let root = snapshot_root(snapshot_id)?;
    let bytes = fs::read(root.join(SNAPSHOT_MANIFEST))
        .map_err(|_| "extensions_project_snapshot_invalid".to_string())?;
    let mut manifest: SnapshotManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "extensions_project_snapshot_invalid".to_string())?;
    if manifest.snapshot_id != snapshot_id {
        return Err("extensions_project_snapshot_invalid".to_string());
    }
    manifest.codex_profile_name = Some(profile_name.to_string());
    manifest.codex_profile_path = Some(profile_path.to_string_lossy().into_owned());
    write_manifest(&root, &manifest)
}

// 没有供应商快照时读取所选环境的原始 Claude settings；不存在时使用空对象，避免项目快照丢失用户设置。
fn read_claude_home_settings(context: &PolicyContext) -> Result<Map<String, Value>, String> {
    let environment_kind = context
        .request
        .environment_kind
        .as_deref()
        .unwrap_or("local");
    let environment_id = context
        .request
        .environment_id
        .as_deref()
        .unwrap_or(LOCAL_ENVIRONMENT_ID);
    let home = crate::provider::home::cached(
        environment_kind.to_string(),
        Some(environment_id.to_string()),
    )
    .ok_or_else(|| "extensions_project_home_unavailable".to_string())?;
    let path = PathBuf::from(home.targets.claude_config_dir).join("settings.json");
    match fs::symlink_metadata(&path) {
        Ok(_) => read_json_object(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(_) => Err("extensions_project_provider_settings_read_failed".to_string()),
    }
}

// Same-name unselected source variants are harmless; only multiple selected versions are ambiguous.
fn claude_skill_overrides<'a>(
    packages: impl IntoIterator<Item = (&'a str, &'a str)>,
    selected_ids: &[String],
) -> Result<Map<String, Value>, String> {
    let selected = selected_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut overrides = Map::new();
    let mut selected_names = BTreeMap::new();
    for (id, name) in packages {
        if selected.contains(id) {
            if let Some(previous) = selected_names.insert(name, id) {
                if previous != id {
                    return Err("extensions_project_skill_name_conflict".to_string());
                }
            }
            overrides.insert(name.to_string(), Value::String("on".to_string()));
        } else {
            overrides
                .entry(name.to_string())
                .or_insert_with(|| Value::String("off".to_string()));
        }
    }
    Ok(overrides)
}

fn write_claude_skill_settings(
    request: &ProjectExtensionLaunchRequest,
    context: &PolicyContext,
    mcp: &PolicyResolution,
    resolution: &PolicyResolution,
    snapshot_id: Option<String>,
) -> Result<(String, PathBuf), String> {
    let (snapshot_id, root, owns_snapshot) = if let Some(snapshot_id) = snapshot_id {
        (snapshot_id.clone(), snapshot_root(&snapshot_id)?, false)
    } else {
        let (snapshot_id, root) = create_snapshot_root(request, context, mcp, resolution, &[])?;
        (snapshot_id, root, true)
    };
    let result = (|| {
        let mut settings = if let (Some(snapshot_id), Some(provider_id)) = (
            request.provider_snapshot_id.as_deref(),
            request.provider_id.as_deref(),
        ) {
            let path =
                crate::provider::scope::resolve_claude_settings_path(snapshot_id, provider_id)?;
            read_json_object(&path)?
        } else {
            read_claude_home_settings(context)?
        };
        let overrides = claude_skill_overrides(
            context
                .packages
                .iter()
                .map(|package| (package.package_id.as_str(), package.name.as_str())),
            &resolution.applied_ids,
        )?;
        settings.insert("skillOverrides".to_string(), Value::Object(overrides));
        let path = root.join("claude").join("settings.json");
        let bytes = serde_json::to_vec_pretty(&Value::Object(settings))
            .map_err(|_| "extensions_project_settings_serialize_failed".to_string())?;
        write_snapshot_file(&path, &bytes)?;
        Ok((snapshot_id.clone(), path))
    })();
    if result.is_err() && owns_snapshot {
        let _ = fs::remove_dir_all(&root);
    }
    result
}

fn create_snapshot_root(
    request: &ProjectExtensionLaunchRequest,
    context: &PolicyContext,
    mcp: &PolicyResolution,
    skill: &PolicyResolution,
    project_skill_targets: &[project_skill::ProjectSkillTarget],
) -> Result<(String, PathBuf), String> {
    let snapshot_id = Uuid::new_v4().to_string();
    let root = snapshot_root(&snapshot_id)?;
    fs::create_dir_all(&root)
        .map_err(|_| "extensions_project_snapshot_create_failed".to_string())?;
    let environment_kind = context
        .request
        .environment_kind
        .clone()
        .unwrap_or_else(|| "local".to_string());
    let environment_id = context
        .request
        .environment_id
        .clone()
        .unwrap_or_else(|| LOCAL_ENVIRONMENT_ID.to_string());
    let home_path =
        crate::provider::home::cached(environment_kind.clone(), Some(environment_id.clone()))
            .map(|state| state.home_path);
    let manifest_result = write_manifest(
        &root,
        &SnapshotManifest {
            version: 1,
            snapshot_id: snapshot_id.clone(),
            project_id: request.project_id.clone(),
            worktree_id: request.worktree_id.clone(),
            cli: request.cli,
            environment_kind,
            environment_id,
            home_path,
            policy_revision: mcp.revision.max(skill.revision),
            mcp_ids: mcp.applied_ids.clone(),
            skill_ids: skill.applied_ids.clone(),
            codex_profile_name: None,
            codex_profile_path: None,
            project_skill_targets: project_skill_targets.to_vec(),
        },
    );
    if let Err(error) = manifest_result {
        let _ = fs::remove_dir_all(&root);
        return Err(error);
    }
    Ok((snapshot_id, root))
}

fn write_manifest(root: &Path, manifest: &SnapshotManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec(manifest)
        .map_err(|_| "extensions_project_snapshot_manifest_failed".to_string())?;
    write_snapshot_file(&root.join(SNAPSHOT_MANIFEST), &bytes)
}

fn snapshot_root(snapshot_id: &str) -> Result<PathBuf, String> {
    if !valid_snapshot_id(snapshot_id) {
        return Err("extensions_project_snapshot_invalid".to_string());
    }
    Ok(crate::app_paths::cli_manager_data_dir()?
        .join("extensions")
        .join(SNAPSHOT_DIR)
        .join(snapshot_id))
}

fn write_snapshot_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "extensions_project_snapshot_create_failed".to_string())?;
    }
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    if fs::write(&temporary, bytes)
        .and_then(|_| fs::rename(&temporary, path))
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("extensions_project_snapshot_write_failed".to_string());
    }
    Ok(())
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "extensions_project_provider_settings_missing".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PROVIDER_SETTINGS_BYTES
    {
        return Err("extensions_project_provider_settings_invalid".to_string());
    }
    let bytes = fs::read(path)
        .map_err(|_| "extensions_project_provider_settings_read_failed".to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "extensions_project_provider_settings_invalid".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "extensions_project_provider_settings_invalid".to_string())
}

fn path_for_environment(path: &Path, environment_kind: &str) -> Result<String, String> {
    let value = path.to_string_lossy();
    if environment_kind == "local" {
        return Ok(value.into_owned());
    }
    windows_path_to_wsl(&value)
        .ok_or_else(|| "extensions_project_wsl_snapshot_path_unavailable".to_string())
}

fn windows_path_to_wsl(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' || !matches!(bytes[2], b'\\' | b'/') {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let tail = trimmed[3..]
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if tail.is_empty() {
        Some(format!("/mnt/{drive}"))
    } else {
        Some(format!("/mnt/{drive}/{tail}"))
    }
}

fn invalid_ids(ids: &[String], available: &BTreeSet<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut invalid = BTreeSet::new();
    for id in ids {
        if !seen.insert(id) || !available.contains(id) {
            invalid.insert(id.clone());
        }
    }
    invalid.into_iter().collect()
}

fn normalize_ids(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.len() > MAX_POLICY_IDS {
        return Err("extensions_scope_policy_too_many_ids".to_string());
    }
    ids.into_iter()
        .map(|id| {
            let id = id.trim().to_string();
            if id.is_empty() || id.len() > MAX_ID_LENGTH || id.chars().any(char::is_control) {
                return Err("extensions_scope_policy_id_invalid".to_string());
            }
            Ok(id)
        })
        .collect()
}

fn validate_id<'a>(value: &'a str, error: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_ID_LENGTH || trimmed.chars().any(char::is_control)
    {
        return Err(error.to_string());
    }
    Ok(trimmed)
}

fn safe_codex_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_snapshot_id(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, ch)| {
            matches!(index, 8 | 13 | 18 | 23) && ch == '-'
                || !matches!(index, 8 | 13 | 18 | 23) && ch.is_ascii_hexdigit()
        })
}

fn parse_scope_kind(value: &str) -> Result<ExtensionScopeKind, String> {
    match value {
        "project" => Ok(ExtensionScopeKind::Project),
        "worktree" => Ok(ExtensionScopeKind::Worktree),
        _ => Err("extensions_scope_policy_corrupt".to_string()),
    }
}

fn parse_cli(value: &str) -> Result<ExtensionCli, String> {
    ExtensionCli::parse(value).ok_or_else(|| "extensions_scope_policy_corrupt".to_string())
}

fn parse_policy_kind(value: &str) -> Result<ExtensionPolicyKind, String> {
    match value {
        "mcp" => Ok(ExtensionPolicyKind::Mcp),
        "skill" => Ok(ExtensionPolicyKind::Skill),
        _ => Err("extensions_scope_policy_corrupt".to_string()),
    }
}

fn parse_policy_mode(value: &str) -> Result<ExtensionPolicyMode, String> {
    match value {
        "inherit" => Ok(ExtensionPolicyMode::Inherit),
        "custom" => Ok(ExtensionPolicyMode::Custom),
        _ => Err("extensions_scope_policy_corrupt".to_string()),
    }
}

fn package_view(record: &SkillPackageRecord) -> Result<SkillPackageView, String> {
    Ok(SkillPackageView {
        package_id: record.package_id.clone(),
        name: record.name.clone(),
        description: record.description.clone(),
        source_kind: record.source_kind.clone(),
        source_identity: record.source_identity.clone(),
        source_ref: record.source_ref.clone(),
        resolved_commit: record.resolved_commit.clone(),
        subdirectory: record.subdirectory.clone(),
        content_hash: record.content_hash.clone(),
        version: record.version.clone(),
        package_path: record.package_path.to_string_lossy().into_owned(),
        updated_at_ms: record.updated_at_ms,
    })
}

// 释放单个启动快照；只删除带有合法清单且位于固定受管目录的产物。
pub(crate) fn release_snapshot(snapshot_id: String) -> Result<(), String> {
    let snapshot_id = snapshot_id.trim();
    let root = snapshot_root(snapshot_id)?;
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("extensions_project_snapshot_release_failed".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("extensions_project_snapshot_invalid".to_string());
    }
    let manifest_bytes = fs::read(root.join(SNAPSHOT_MANIFEST))
        .map_err(|_| "extensions_project_snapshot_invalid".to_string())?;
    let manifest: SnapshotManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "extensions_project_snapshot_invalid".to_string())?;
    if manifest.version != 1 || manifest.snapshot_id != snapshot_id {
        return Err("extensions_project_snapshot_invalid".to_string());
    }
    if manifest.cli == ExtensionCli::Codex {
        if let Some(profile_name) = manifest.codex_profile_name.as_deref() {
            remove_codex_project_profile(
                snapshot_id,
                profile_name,
                manifest.codex_profile_path.as_deref(),
            )?;
        }
    }
    project_skill::release_targets(snapshot_id, &manifest.project_skill_targets)?;
    fs::remove_dir_all(root).map_err(|_| "extensions_project_snapshot_release_failed".to_string())
}

// 应用启动/恢复时清理不再被会话引用的项目快照；损坏清单只跳过，不扩大删除范围。
pub(crate) fn garbage_collect_snapshots(active_snapshot_ids: Vec<String>) -> Result<(), String> {
    let active = active_snapshot_ids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>();
    if active.iter().any(|value| !valid_snapshot_id(value)) {
        return Err("extensions_project_snapshot_invalid".to_string());
    }
    let root = crate::app_paths::cli_manager_data_dir()?
        .join("extensions")
        .join(SNAPSHOT_DIR);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("extensions_project_snapshot_gc_failed".to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(snapshot_id) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if active.contains(snapshot_id) || !valid_snapshot_id(snapshot_id) {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let _ = release_snapshot(snapshot_id.to_string());
    }
    Ok(())
}

#[cfg(test)]
#[path = "project_policy_tests.rs"]
mod tests;
