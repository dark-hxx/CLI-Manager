use crate::app_paths;
use crate::ssh_transport::{validate_remote_home_path, SshRemoteHomePathError};
use cli_manager_hook_schema::HookConfigReport;
use serde::Deserialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteRow};
use sqlx::{Connection, Row, SqliteConnection};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_HOOK_REPORT_BYTES: usize = 1024 * 1024;
const MAX_ROOT_BYTES: usize = 4096;
const MAX_IDENTITY_BYTES: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHookReportPersistenceRequest {
    host_id: String,
    ssh_user: String,
    configured_root: String,
    report: HookConfigReport,
    integration_id: Option<String>,
    scope_kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostPreferencesPersistenceRequest {
    host_id: String,
    claude_root: String,
    codex_root: String,
}

#[derive(Debug)]
struct ExistingIntegration {
    integration_id: String,
    source: String,
    canonical_root: String,
    hook_record_json: String,
    history_source_instance_id: String,
}

fn timestamp_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn is_sqlite_busy_code(code: &str) -> bool {
    matches!(code, "SQLITE_BUSY" | "SQLITE_LOCKED")
        || code
            .parse::<i32>()
            .is_ok_and(|value| matches!(value & 0xff, 5 | 6))
}

fn map_db_error(stage: &str, error: sqlx::Error) -> String {
    let busy = error
        .as_database_error()
        .and_then(|database_error| database_error.code())
        .is_some_and(|code| is_sqlite_busy_code(code.as_ref()));
    if busy {
        "ssh_agent_hook_metadata_busy".to_string()
    } else {
        format!("ssh_agent_hook_metadata_{stage}_failed:{error}")
    }
}

fn validate_request(request: &SshHookReportPersistenceRequest) -> Result<(), String> {
    Uuid::parse_str(request.host_id.trim()).map_err(|_| "ssh_host_id_invalid".to_string())?;
    if request
        .integration_id
        .as_deref()
        .is_some_and(|value| Uuid::parse_str(value.trim()).is_err())
    {
        return Err("ssh_hook_integration_id_invalid".to_string());
    }
    if !matches!(
        request.scope_kind.as_str(),
        "hostPrimary" | "projectOverride"
    ) {
        return Err("ssh_hook_scope_kind_invalid".to_string());
    }
    if !matches!(request.report.source.as_str(), "claude" | "codex") {
        return Err("hook_source_invalid".to_string());
    }
    Uuid::parse_str(request.report.installation_id.trim())
        .map_err(|_| "ssh_agent_identity_required".to_string())?;
    if request.ssh_user.trim().is_empty()
        || request.ssh_user.len() > MAX_IDENTITY_BYTES
        || request.ssh_user.contains(['\0', '\r', '\n'])
    {
        return Err("ssh_user_required".to_string());
    }
    if request.report.remote_machine_id.trim().is_empty()
        || request.report.remote_machine_id.len() > MAX_IDENTITY_BYTES
        || request
            .report
            .remote_machine_id
            .contains(['\0', '\r', '\n'])
    {
        return Err("ssh_agent_remote_machine_id_invalid".to_string());
    }
    let configured_root = request.configured_root.trim();
    if configured_root != request.report.configured_config_root
        || configured_root.len() > MAX_ROOT_BYTES
        || configured_root.contains(['\0', '\r', '\n'])
    {
        return Err("ssh_tool_config_root_invalid".to_string());
    }
    if !request.report.canonical_config_root.starts_with('/')
        || request.report.canonical_config_root.len() > MAX_ROOT_BYTES
        || request
            .report
            .canonical_config_root
            .contains(['\0', '\r', '\n'])
    {
        return Err("hook_config_root_invalid".to_string());
    }
    if request.report.config_root_hash.len() != 64
        || !request
            .report
            .config_root_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("hook_config_root_hash_invalid".to_string());
    }
    let serialized = serde_json::to_vec(&request.report)
        .map_err(|error| format!("ssh_agent_hook_metadata_serialize_failed:{error}"))?;
    if serialized.len() > MAX_HOOK_REPORT_BYTES {
        return Err("ssh_agent_hook_metadata_too_large".to_string());
    }
    Ok(())
}

fn validate_preference_root(root: &str) -> Result<(), String> {
    let root = root.trim();
    if root.is_empty() {
        return Ok(());
    }
    if root.len() > MAX_ROOT_BYTES {
        return Err("ssh_tool_config_root_invalid".to_string());
    }
    validate_remote_home_path(root).map_err(|error| match error {
        SshRemoteHomePathError::Invalid => "ssh_tool_config_root_invalid".to_string(),
        SshRemoteHomePathError::ParentTraversal => {
            "ssh_tool_config_root_parent_forbidden".to_string()
        }
    })
}

async fn persist_host_preferences(
    connection: &mut SqliteConnection,
    request: SshHostPreferencesPersistenceRequest,
) -> Result<(), String> {
    let host_id = request.host_id.trim();
    Uuid::parse_str(host_id).map_err(|_| "ssh_host_id_invalid".to_string())?;
    validate_preference_root(&request.claude_root)?;
    validate_preference_root(&request.codex_root)?;

    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_db_error("begin", error))?;
    let updated_at = timestamp_millis();
    for (source, root) in [
        ("claude", request.claude_root.trim()),
        ("codex", request.codex_root.trim()),
    ] {
        if root.is_empty() {
            sqlx::query("DELETE FROM ssh_host_tool_preferences WHERE host_id = ? AND source = ?")
                .bind(host_id)
                .bind(source)
                .execute(&mut *transaction)
                .await
                .map_err(|error| map_db_error("write", error))?;
        } else {
            sqlx::query(
                "INSERT INTO ssh_host_tool_preferences (host_id, source, configured_root, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(host_id, source) DO UPDATE SET
                   configured_root = excluded.configured_root,
                   updated_at = excluded.updated_at",
            )
            .bind(host_id)
            .bind(source)
            .bind(root)
            .bind(&updated_at)
            .execute(&mut *transaction)
            .await
            .map_err(|error| map_db_error("write", error))?;
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| map_db_error("commit", error))
}

fn existing_from_row(row: SqliteRow) -> ExistingIntegration {
    ExistingIntegration {
        integration_id: row.get("integration_id"),
        source: row.get("source"),
        canonical_root: row.get("canonical_root"),
        hook_record_json: row.get("hook_record_json"),
        history_source_instance_id: row.get("history_source_instance_id"),
    }
}

async fn persist_hook_report(
    connection: &mut SqliteConnection,
    request: SshHookReportPersistenceRequest,
) -> Result<(), String> {
    validate_request(&request)?;
    let host_id = request.host_id.trim();
    let ssh_user = request.ssh_user.trim();
    let configured_root = request.configured_root.trim();
    let source = request.report.source.clone();
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_db_error("begin", error))?;

    let existing_row = if let Some(integration_id) = request.integration_id.as_deref() {
        sqlx::query(
            "SELECT integration_id, source, canonical_root, hook_record_json, history_source_instance_id
             FROM ssh_agent_tool_integrations
             WHERE integration_id = ? AND host_id = ? LIMIT 1",
        )
        .bind(integration_id.trim())
        .bind(host_id)
        .fetch_optional(&mut *transaction)
        .await
    } else if request.scope_kind == "projectOverride" {
        sqlx::query(
            "SELECT integration_id, source, canonical_root, hook_record_json, history_source_instance_id
             FROM ssh_agent_tool_integrations
             WHERE host_id = ? AND source = ? AND scope_kind = 'projectOverride'
               AND configured_root = ? LIMIT 1",
        )
        .bind(host_id)
        .bind(source.as_str())
        .bind(configured_root)
        .fetch_optional(&mut *transaction)
        .await
    } else {
        sqlx::query(
            "SELECT integration_id, source, canonical_root, hook_record_json, history_source_instance_id
             FROM ssh_agent_tool_integrations
             WHERE host_id = ? AND source = ? AND scope_kind = 'hostPrimary' LIMIT 1",
        )
        .bind(host_id)
        .bind(source.as_str())
        .fetch_optional(&mut *transaction)
        .await
    }
    .map_err(|error| map_db_error("read", error))?;
    let existing = existing_row.map(existing_from_row);
    if request.integration_id.is_some() && existing.is_none() {
        return Err("ssh_hook_integration_not_found".to_string());
    }
    if existing
        .as_ref()
        .is_some_and(|integration| integration.source != source.as_str())
    {
        return Err("hook_source_invalid".to_string());
    }

    let mut persisted_report = request.report;
    let mut previous_hook_record_json = existing
        .as_ref()
        .filter(|integration| integration.canonical_root == persisted_report.canonical_config_root)
        .map(|integration| integration.hook_record_json.clone())
        .unwrap_or_default();
    if persisted_report.action == "inspect"
        && persisted_report.installation.is_none()
        && previous_hook_record_json.is_empty()
    {
        previous_hook_record_json = sqlx::query_scalar::<_, String>(
            "SELECT hook_record_json FROM ssh_agent_tool_integrations
             WHERE host_id = ? AND source = ? AND canonical_root = ? LIMIT 1",
        )
        .bind(host_id)
        .bind(source.as_str())
        .bind(&persisted_report.canonical_config_root)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| map_db_error("read", error))?
        .unwrap_or_default();
    }
    if persisted_report.action == "inspect"
        && persisted_report.installation.is_none()
        && !previous_hook_record_json.is_empty()
    {
        if let Ok(previous) = serde_json::from_str::<HookConfigReport>(&previous_hook_record_json) {
            if previous.installation.is_some()
                && previous.canonical_config_root == persisted_report.canonical_config_root
            {
                persisted_report.installation = previous.installation;
            }
        }
    }

    let checked_at = timestamp_millis();
    let report_json = serde_json::to_string(&persisted_report)
        .map_err(|error| format!("ssh_agent_hook_metadata_serialize_failed:{error}"))?;
    if let (Some(integration_id), Some(_)) = (request.integration_id.as_deref(), existing.as_ref())
    {
        let cleanup_state = if persisted_report.status == "notInstalled" {
            "retained"
        } else {
            "cleanupAvailable"
        };
        sqlx::query(
            "UPDATE ssh_agent_tool_integrations SET
               installation_id = ?, remote_machine_id = ?, ssh_user = ?,
               configured_root = ?, canonical_root = ?, config_root_hash = ?,
               hook_record_json = ?, validation_state = 'valid',
               cleanup_state = ?, checked_at = ?
             WHERE integration_id = ?",
        )
        .bind(&persisted_report.installation_id)
        .bind(&persisted_report.remote_machine_id)
        .bind(ssh_user)
        .bind(configured_root)
        .bind(&persisted_report.canonical_config_root)
        .bind(&persisted_report.config_root_hash)
        .bind(&report_json)
        .bind(cleanup_state)
        .bind(&checked_at)
        .bind(integration_id.trim())
        .execute(&mut *transaction)
        .await
        .map_err(|error| map_db_error("write", error))?;
    } else if let Some(existing) = existing.as_ref() {
        let managed_entries = serde_json::from_str::<HookConfigReport>(&existing.hook_record_json)
            .map(|report| report.managed_entries)
            .unwrap_or(0);
        let retain_existing = !existing.canonical_root.is_empty()
            && existing.canonical_root != persisted_report.canonical_config_root
            && (managed_entries > 0 || !existing.history_source_instance_id.is_empty());
        if retain_existing {
            sqlx::query(
                "UPDATE ssh_agent_tool_integrations
                 SET scope_kind = 'retainedRoot', cleanup_state = 'cleanupAvailable', checked_at = ?
                 WHERE integration_id = ?",
            )
            .bind(&checked_at)
            .bind(&existing.integration_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| map_db_error("write", error))?;
            sqlx::query(
                "INSERT INTO ssh_agent_tool_integrations (
                   integration_id, host_id, installation_id, remote_machine_id, ssh_user,
                   source, scope_kind, configured_root, canonical_root, config_root_hash,
                   hook_record_json, validation_state, cleanup_state, checked_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', 'active', ?)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(host_id)
            .bind(&persisted_report.installation_id)
            .bind(&persisted_report.remote_machine_id)
            .bind(ssh_user)
            .bind(source.as_str())
            .bind(&request.scope_kind)
            .bind(configured_root)
            .bind(&persisted_report.canonical_config_root)
            .bind(&persisted_report.config_root_hash)
            .bind(&report_json)
            .bind(&checked_at)
            .execute(&mut *transaction)
            .await
            .map_err(|error| map_db_error("write", error))?;
        } else {
            sqlx::query(
                "UPDATE ssh_agent_tool_integrations SET
                   installation_id = ?, remote_machine_id = ?, ssh_user = ?,
                   configured_root = ?, canonical_root = ?, config_root_hash = ?,
                   hook_record_json = ?, validation_state = 'valid',
                   cleanup_state = 'active', checked_at = ?
                 WHERE integration_id = ?",
            )
            .bind(&persisted_report.installation_id)
            .bind(&persisted_report.remote_machine_id)
            .bind(ssh_user)
            .bind(configured_root)
            .bind(&persisted_report.canonical_config_root)
            .bind(&persisted_report.config_root_hash)
            .bind(&report_json)
            .bind(&checked_at)
            .bind(&existing.integration_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| map_db_error("write", error))?;
        }
    } else {
        sqlx::query(
            "INSERT INTO ssh_agent_tool_integrations (
               integration_id, host_id, installation_id, remote_machine_id, ssh_user,
               source, scope_kind, configured_root, canonical_root, config_root_hash,
               hook_record_json, validation_state, cleanup_state, checked_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', 'active', ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(host_id)
        .bind(&persisted_report.installation_id)
        .bind(&persisted_report.remote_machine_id)
        .bind(ssh_user)
        .bind(source.as_str())
        .bind(&request.scope_kind)
        .bind(configured_root)
        .bind(&persisted_report.canonical_config_root)
        .bind(&persisted_report.config_root_hash)
        .bind(&report_json)
        .bind(&checked_at)
        .execute(&mut *transaction)
        .await
        .map_err(|error| map_db_error("write", error))?;
    }

    let mirrors = sqlx::query(
        "SELECT integration_id, configured_root FROM ssh_agent_tool_integrations
         WHERE host_id = ? AND source = ? AND canonical_root = ?",
    )
    .bind(host_id)
    .bind(source.as_str())
    .bind(&persisted_report.canonical_config_root)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| map_db_error("read", error))?;
    for mirror in mirrors {
        let integration_id: String = mirror.get("integration_id");
        let mut mirror_report = persisted_report.clone();
        mirror_report.configured_config_root = mirror.get("configured_root");
        let mirror_json = serde_json::to_string(&mirror_report)
            .map_err(|error| format!("ssh_agent_hook_metadata_serialize_failed:{error}"))?;
        sqlx::query(
            "UPDATE ssh_agent_tool_integrations SET
               installation_id = ?, remote_machine_id = ?, ssh_user = ?,
               config_root_hash = ?, hook_record_json = ?,
               validation_state = 'valid', checked_at = ?
             WHERE integration_id = ?",
        )
        .bind(&persisted_report.installation_id)
        .bind(&persisted_report.remote_machine_id)
        .bind(ssh_user)
        .bind(&persisted_report.config_root_hash)
        .bind(mirror_json)
        .bind(&checked_at)
        .bind(integration_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| map_db_error("write", error))?;
    }

    transaction
        .commit()
        .await
        .map_err(|error| map_db_error("commit", error))
}

#[tauri::command]
pub async fn ssh_agent_record_hook_report(
    request: SshHookReportPersistenceRequest,
) -> Result<(), String> {
    let options = SqliteConnectOptions::new()
        .filename(app_paths::db_path()?)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| map_db_error("open", error))?;
    persist_hook_report(&mut connection, request).await
}

#[tauri::command]
pub async fn ssh_agent_save_host_preferences(
    request: SshHostPreferencesPersistenceRequest,
) -> Result<(), String> {
    let options = SqliteConnectOptions::new()
        .filename(app_paths::db_path()?)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| map_db_error("open", error))?;
    persist_host_preferences(&mut connection, request).await
}

#[cfg(test)]
mod tests {
    use super::{
        is_sqlite_busy_code, persist_hook_report, persist_host_preferences,
        SshHookReportPersistenceRequest, SshHostPreferencesPersistenceRequest,
    };
    use cli_manager_hook_schema::HookConfigReport;
    use sqlx::{Connection, Row, SqliteConnection};

    const HOST_ID: &str = "00000000-0000-4000-8000-000000000001";
    const INSTALLATION_ID: &str = "00000000-0000-4000-8000-000000000002";

    async fn database() -> SqliteConnection {
        let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE ssh_agent_tool_integrations (
               integration_id TEXT PRIMARY KEY,
               host_id TEXT,
               installation_id TEXT NOT NULL DEFAULT '',
               remote_machine_id TEXT NOT NULL DEFAULT '',
               ssh_user TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL,
               scope_kind TEXT NOT NULL DEFAULT 'hostPrimary',
               configured_root TEXT NOT NULL DEFAULT '',
               canonical_root TEXT NOT NULL DEFAULT '',
               config_root_hash TEXT NOT NULL DEFAULT '',
               hook_record_json TEXT NOT NULL DEFAULT '{}',
               history_source_instance_id TEXT NOT NULL DEFAULT '',
               validation_state TEXT NOT NULL DEFAULT 'unvalidated',
               cleanup_state TEXT NOT NULL DEFAULT 'active',
               checked_at TEXT NOT NULL DEFAULT ''
             );
             CREATE UNIQUE INDEX idx_host_primary
               ON ssh_agent_tool_integrations(host_id, source)
               WHERE host_id IS NOT NULL AND scope_kind = 'hostPrimary';
             CREATE TABLE ssh_host_tool_preferences (
               host_id TEXT NOT NULL,
               source TEXT NOT NULL,
               configured_root TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY (host_id, source)
             );",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    fn report(
        configured_root: &str,
        canonical_root: &str,
        managed_entries: u32,
    ) -> HookConfigReport {
        HookConfigReport {
            action: "inspect".to_string(),
            status: "installed".to_string(),
            source: "codex".to_string(),
            installation_id: INSTALLATION_ID.to_string(),
            remote_machine_id: "machine-1".to_string(),
            configured_config_root: configured_root.to_string(),
            canonical_config_root: canonical_root.to_string(),
            config_root_hash: "a".repeat(64),
            config_root_exists: true,
            will_create_config_root: false,
            config_files: Vec::new(),
            managed_entries,
            required_entries: 1,
            changes: Vec::new(),
            installation: None,
        }
    }

    fn request(report: HookConfigReport) -> SshHookReportPersistenceRequest {
        SshHookReportPersistenceRequest {
            host_id: HOST_ID.to_string(),
            ssh_user: "root".to_string(),
            configured_root: report.configured_config_root.clone(),
            report,
            integration_id: None,
            scope_kind: "hostPrimary".to_string(),
        }
    }

    fn preferences(claude_root: &str, codex_root: &str) -> SshHostPreferencesPersistenceRequest {
        SshHostPreferencesPersistenceRequest {
            host_id: HOST_ID.to_string(),
            claude_root: claude_root.to_string(),
            codex_root: codex_root.to_string(),
        }
    }

    #[test]
    fn recognizes_sqlite_busy_and_locked_extended_codes() {
        for code in [
            "5",
            "6",
            "261",
            "262",
            "517",
            "SQLITE_BUSY",
            "SQLITE_LOCKED",
        ] {
            assert!(is_sqlite_busy_code(code), "expected busy code: {code}");
        }
        assert!(!is_sqlite_busy_code("19"));
    }

    #[tokio::test]
    async fn saves_and_deletes_host_preferences_in_one_transaction() {
        let mut connection = database().await;
        persist_host_preferences(&mut connection, preferences("~/.claude", "~/.codex"))
            .await
            .unwrap();
        persist_host_preferences(&mut connection, preferences("", "/srv/codex"))
            .await
            .unwrap();

        let rows = sqlx::query(
            "SELECT source, configured_root FROM ssh_host_tool_preferences ORDER BY source",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get::<String, _>("source"), "codex");
        assert_eq!(rows[0].get::<String, _>("configured_root"), "/srv/codex");
    }

    #[tokio::test]
    async fn rolls_back_all_host_preferences_when_one_write_fails() {
        let mut connection = database().await;
        persist_host_preferences(&mut connection, preferences("~/.claude", "~/.codex"))
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TRIGGER reject_codex_preference
             BEFORE UPDATE ON ssh_host_tool_preferences
             WHEN NEW.source = 'codex'
             BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        assert!(persist_host_preferences(
            &mut connection,
            preferences("/srv/claude", "/srv/codex"),
        )
        .await
        .is_err());
        let claude_root: String = sqlx::query_scalar(
            "SELECT configured_root FROM ssh_host_tool_preferences
             WHERE host_id = ? AND source = 'claude'",
        )
        .bind(HOST_ID)
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(claude_root, "~/.claude");
    }

    #[tokio::test]
    async fn persists_same_root_mirrors_in_one_transaction() {
        let mut connection = database().await;
        let initial = report("~/.codex", "/root/.codex", 1);
        for (id, scope, configured_root) in [
            (
                "00000000-0000-4000-8000-000000000010",
                "hostPrimary",
                "~/.codex",
            ),
            (
                "00000000-0000-4000-8000-000000000011",
                "projectOverride",
                "/root/.codex",
            ),
        ] {
            sqlx::query(
                "INSERT INTO ssh_agent_tool_integrations (
                   integration_id, host_id, source, scope_kind, configured_root,
                   canonical_root, hook_record_json
                 ) VALUES (?, ?, 'codex', ?, ?, '/root/.codex', ?)",
            )
            .bind(id)
            .bind(HOST_ID)
            .bind(scope)
            .bind(configured_root)
            .bind(serde_json::to_string(&initial).unwrap())
            .execute(&mut connection)
            .await
            .unwrap();
        }

        persist_hook_report(&mut connection, request(initial))
            .await
            .unwrap();
        let rows = sqlx::query(
            "SELECT configured_root, hook_record_json FROM ssh_agent_tool_integrations
             ORDER BY configured_root",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        for row in rows {
            let configured_root: String = row.get("configured_root");
            let stored: HookConfigReport =
                serde_json::from_str(&row.get::<String, _>("hook_record_json")).unwrap();
            assert_eq!(stored.configured_config_root, configured_root);
            assert_eq!(stored.remote_machine_id, "machine-1");
        }
    }

    #[tokio::test]
    async fn rolls_back_retained_root_when_insert_fails() {
        let mut connection = database().await;
        let initial = report("~/.codex", "/root/.codex", 1);
        sqlx::query(
            "INSERT INTO ssh_agent_tool_integrations (
               integration_id, host_id, source, scope_kind, configured_root,
               canonical_root, hook_record_json
             ) VALUES (?, ?, 'codex', 'hostPrimary', '~/.codex', '/root/.codex', ?)",
        )
        .bind("00000000-0000-4000-8000-000000000010")
        .bind(HOST_ID)
        .bind(serde_json::to_string(&initial).unwrap())
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::raw_sql(
            "CREATE TRIGGER reject_integration_insert
             BEFORE INSERT ON ssh_agent_tool_integrations
             BEGIN SELECT RAISE(ABORT, 'rejected'); END;",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let changed = report("/srv/codex", "/srv/codex", 0);
        assert!(persist_hook_report(&mut connection, request(changed))
            .await
            .is_err());
        let scope: String = sqlx::query_scalar(
            "SELECT scope_kind FROM ssh_agent_tool_integrations
             WHERE integration_id = '00000000-0000-4000-8000-000000000010'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(scope, "hostPrimary");
    }
}
