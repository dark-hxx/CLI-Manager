use super::{
    git_safe_directory_environment_for_value, is_switch_identifier, load_registered_projects,
    project_switch_token, CcConnectProfile, RegisteredProject, RegisteredSshHost,
};
use crate::codex_app_server_proxy::SshCodexLaunch;
use crate::ssh_transport::SshTransportSpec;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::HashMap;
use std::time::Duration;

pub(super) fn sqlite_u16(row: &sqlx::sqlite::SqliteRow, field: &str) -> Result<u16, String> {
    let value: i64 = row
        .try_get(field)
        .map_err(|err| format!("read SSH host {field} failed: {err}"))?;
    u16::try_from(value).map_err(|_| format!("read SSH host {field} failed: out of range"))
}

pub(super) fn sqlite_u32(row: &sqlx::sqlite::SqliteRow, field: &str) -> Result<u32, String> {
    let value: i64 = row
        .try_get(field)
        .map_err(|err| format!("read SSH host {field} failed: {err}"))?;
    u32::try_from(value).map_err(|_| format!("read SSH host {field} failed: out of range"))
}

pub(super) fn sqlite_u64(row: &sqlx::sqlite::SqliteRow, field: &str) -> Result<u64, String> {
    let value: i64 = row
        .try_get(field)
        .map_err(|err| format!("read SSH host {field} failed: {err}"))?;
    u64::try_from(value).map_err(|_| format!("read SSH host {field} failed: out of range"))
}

pub(super) async fn query_registered_ssh_host(
    connection: &mut SqliteConnection,
    host_id: &str,
) -> Result<Option<RegisteredSshHost>, String> {
    let row = sqlx::query(
        "SELECT host, port, username, config_alias, config_file, auth_mode, identity_file, \
                credential_ref, jump_mode, jump_host_id, proxy_type, proxy_host, proxy_port, \
                proxy_command, connect_timeout_sec, server_alive_interval_sec, \
                server_alive_count_max, startup_script \
         FROM ssh_hosts WHERE id = ?",
    )
    .bind(host_id)
    .fetch_optional(connection)
    .await
    .map_err(|err| format!("query CLI-Manager SSH host failed: {err}"))?;
    row.map(|row| {
        Ok(RegisteredSshHost {
            host: row
                .try_get("host")
                .map_err(|err| format!("read SSH host address failed: {err}"))?,
            port: sqlite_u16(&row, "port")?,
            username: row
                .try_get("username")
                .map_err(|err| format!("read SSH host username failed: {err}"))?,
            config_alias: row
                .try_get("config_alias")
                .map_err(|err| format!("read SSH config alias failed: {err}"))?,
            config_file: row
                .try_get("config_file")
                .map_err(|err| format!("read SSH config file failed: {err}"))?,
            auth_mode: row
                .try_get("auth_mode")
                .map_err(|err| format!("read SSH authentication mode failed: {err}"))?,
            identity_file: row
                .try_get("identity_file")
                .map_err(|err| format!("read SSH identity file failed: {err}"))?,
            credential_ref: row
                .try_get("credential_ref")
                .map_err(|err| format!("read SSH credential reference failed: {err}"))?,
            jump_mode: row
                .try_get("jump_mode")
                .map_err(|err| format!("read SSH jump mode failed: {err}"))?,
            jump_host_id: row
                .try_get("jump_host_id")
                .map_err(|err| format!("read SSH jump host failed: {err}"))?,
            proxy_type: row
                .try_get("proxy_type")
                .map_err(|err| format!("read SSH proxy type failed: {err}"))?,
            proxy_host: row
                .try_get("proxy_host")
                .map_err(|err| format!("read SSH proxy host failed: {err}"))?,
            proxy_port: sqlite_u16(&row, "proxy_port")?,
            proxy_command: row
                .try_get("proxy_command")
                .map_err(|err| format!("read SSH proxy command failed: {err}"))?,
            connect_timeout_sec: sqlite_u64(&row, "connect_timeout_sec")?,
            server_alive_interval_sec: sqlite_u64(&row, "server_alive_interval_sec")?,
            server_alive_count_max: sqlite_u32(&row, "server_alive_count_max")?,
            startup_script: row
                .try_get("startup_script")
                .map_err(|err| format!("read SSH startup script failed: {err}"))?,
        })
    })
    .transpose()
}

pub(super) fn ssh_jump_target(host: &RegisteredSshHost) -> String {
    if !host.config_alias.trim().is_empty() {
        return host.config_alias.trim().to_string();
    }
    let address = host.host.trim();
    if address.is_empty() {
        return String::new();
    }
    let address = if address.contains(':') && !address.starts_with('[') {
        format!("[{address}]")
    } else {
        address.to_string()
    };
    let user = if host.username.trim().is_empty() {
        String::new()
    } else {
        format!("{}@", host.username.trim())
    };
    let port = if host.port == 0 || host.port == 22 {
        String::new()
    } else {
        format!(":{}", host.port)
    };
    format!("{user}{address}{port}")
}

pub(super) fn selected_ssh_jump_host_id<'a>(
    jump_mode: &str,
    jump_host_id: Option<&'a str>,
    proxy_type: &str,
) -> Result<Option<&'a str>, String> {
    if matches!(proxy_type, "http" | "socks5" | "proxy_command") || jump_mode == "none" {
        return Ok(None);
    }
    jump_host_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Some)
        .ok_or_else(|| "handoff_ssh_jump_host_missing".to_string())
}

pub(super) fn parse_project_environment(raw: &str) -> HashMap<String, String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .map(|values| {
            values
                .into_iter()
                .filter_map(|(key, value)| value.as_str().map(|value| (key, value.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn load_ssh_codex_launch(project: &RegisteredProject) -> Result<SshCodexLaunch, String> {
    if project.environment_type != "ssh" {
        return Err("handoff_ssh_project_required".to_string());
    }
    let host_id = project
        .ssh_host_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "handoff_ssh_host_missing".to_string())?;
    let database_path = crate::app_paths::db_path()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("create SSH host query runtime failed: {err}"))?;
    let (host, jump_target) = runtime.block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .read_only(true)
            .busy_timeout(Duration::from_secs(3));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|err| format!("open CLI-Manager SSH database failed: {err}"))?;
        let host = query_registered_ssh_host(&mut connection, host_id)
            .await?
            .ok_or_else(|| "handoff_ssh_host_missing".to_string())?;
        let jump_target = match selected_ssh_jump_host_id(
            &host.jump_mode,
            host.jump_host_id.as_deref(),
            &host.proxy_type,
        )? {
            Some(jump_host_id) => query_registered_ssh_host(&mut connection, jump_host_id)
                .await?
                .map(|jump_host| ssh_jump_target(&jump_host))
                .filter(|target| !target.is_empty())
                .ok_or_else(|| "handoff_ssh_jump_host_missing".to_string())?,
            None => String::new(),
        };
        let _ = connection.close().await;
        Ok::<_, String>((host, jump_target))
    })?;
    if matches!(host.auth_mode.as_str(), "password_prompt" | "interactive") {
        return Err("handoff_ssh_interactive_auth_unsupported".to_string());
    }
    let mut environment_overrides = parse_project_environment(&project.env_vars);
    if !project.cli_config_root.trim().is_empty() {
        environment_overrides.insert(
            "CODEX_HOME".to_string(),
            project.cli_config_root.trim().to_string(),
        );
    }
    let inherited_git_config_count = environment_overrides.get("GIT_CONFIG_COUNT").cloned();
    for (key, value) in git_safe_directory_environment_for_value(
        project.remote_path.trim(),
        inherited_git_config_count.as_deref(),
    ) {
        environment_overrides.insert(key, value);
    }
    let transport = SshTransportSpec {
        host: host.host,
        port: host.port,
        username: host.username,
        config_alias: host.config_alias,
        config_file: host.config_file,
        auth_mode: host.auth_mode.clone(),
        identity_file: if host.auth_mode == "identity_file" {
            host.identity_file
        } else {
            String::new()
        },
        credential_ref: if host.auth_mode == "credential_ref" {
            host.credential_ref
        } else {
            String::new()
        },
        jump_target,
        proxy_type: host.proxy_type.clone(),
        proxy_host: host.proxy_host,
        proxy_port: host.proxy_port,
        proxy_command: if host.proxy_type == "proxy_command" {
            host.proxy_command
        } else {
            String::new()
        },
        connect_timeout_sec: host.connect_timeout_sec,
        server_alive_interval_sec: host.server_alive_interval_sec,
        server_alive_count_max: host.server_alive_count_max,
    };
    let launch = SshCodexLaunch {
        transport,
        remote_path: project.remote_path.trim().to_string(),
        environment_overrides,
        initialization_command: (!host.startup_script.trim().is_empty())
            .then(|| host.startup_script.trim().to_string()),
    };
    launch.encode()?;
    Ok(launch)
}

pub(super) fn registered_project_by_token(
    profile: &CcConnectProfile,
    token: &str,
) -> Result<RegisteredProject, String> {
    if !is_switch_identifier(token) {
        return Err("invalid CLI-Manager project switch token".to_string());
    }
    load_registered_projects(Some(profile))?
        .into_iter()
        .find(|project| project_switch_token(&project.id).eq_ignore_ascii_case(token))
        .ok_or_else(|| "the selected project is no longer registered in CLI-Manager".to_string())
}
