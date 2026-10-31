use cli_manager_core::discovery::{daemon_info_path, is_pid_alive, read_daemon_info, DaemonInfo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{net::Ipv4Addr, path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{
        tcp::{OwnedReadHalf, OwnedWriteHalf},
        TcpStream,
    },
    time::timeout,
};

const ROUTING_FEATURE: &str = "local_routing_v1";
const SERVICE_KEY: &str = "routing.service.v1";
const TAKEOVERS_KEY: &str = "routing.takeovers.v1";
const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReconcileOutcome {
    Skipped,
    Noop,
    Started,
    Stopped,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedService {
    schema_version: u32,
    service_enabled: bool,
    listen_address: String,
    preferred_port: u16,
    actual_port: Option<u16>,
    show_local_quick_control: bool,
    show_failover_quick_control: bool,
    usage_logging_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Takeover {
    #[serde(default)]
    home_identity: HomeIdentity,
    #[serde(default)]
    endpoint_mode: String,
    #[serde(default)]
    advertised_host: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct HomeIdentity {
    #[serde(default)]
    environment_kind: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct TakeoversDocument {
    #[serde(default)]
    items: Vec<Takeover>,
}

struct ControlConnection {
    writer: OwnedWriteHalf,
    reader: BufReader<OwnedReadHalf>,
    next_id: u64,
}

impl ControlConnection {
    async fn connect(info: &DaemonInfo) -> Result<Self, String> {
        let stream = timeout(
            CONTROL_TIMEOUT,
            TcpStream::connect((Ipv4Addr::LOCALHOST, info.port)),
        )
        .await
        .map_err(|_| "daemon control connect timeout".to_string())?
        .map_err(|error| format!("daemon control connect failed: {error}"))?;
        stream
            .set_nodelay(true)
            .map_err(|error| format!("daemon control TCP setup failed: {error}"))?;
        let (reader, writer) = stream.into_split();
        let mut connection = Self {
            writer,
            reader: BufReader::new(reader),
            next_id: 1,
        };
        let auth = connection
            .request(json!({
                "type": "auth",
                "token": info.token,
                "client_version": env!("CARGO_PKG_VERSION"),
                "client_features": [ROUTING_FEATURE],
            }))
            .await?;
        if auth["type"] != "auth_ok" {
            return Err("daemon control authentication failed".into());
        }
        if !auth["features"]
            .as_array()
            .is_some_and(|features| features.iter().any(|feature| feature == ROUTING_FEATURE))
        {
            return Err("daemon local routing capability unavailable".into());
        }
        Ok(connection)
    }

    async fn request(&mut self, mut frame: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        if frame["type"] != "auth" {
            frame["id"] = json!(id);
        }
        let mut encoded = serde_json::to_vec(&frame).map_err(|error| error.to_string())?;
        encoded.push(b'\n');
        timeout(CONTROL_TIMEOUT, self.writer.write_all(&encoded))
            .await
            .map_err(|_| "daemon control write timeout".to_string())?
            .map_err(|error| format!("daemon control write failed: {error}"))?;
        loop {
            let mut line = String::new();
            timeout(CONTROL_TIMEOUT, self.reader.read_line(&mut line))
                .await
                .map_err(|_| "daemon control read timeout".to_string())?
                .map_err(|error| format!("daemon control read failed: {error}"))?;
            if line.is_empty() {
                return Err("daemon control disconnected".into());
            }
            let response: Value = serde_json::from_str(line.trim_end())
                .map_err(|error| format!("daemon control response malformed: {error}"))?;
            let response_id = response["id"]
                .as_u64()
                .or_else(|| response["event"]["requestId"].as_u64());
            if response_id == Some(id)
                || response["type"] == "auth_ok"
                || response["type"] == "auth_err"
            {
                return Ok(response);
            }
        }
    }

    async fn routing_status(&mut self) -> Result<Value, String> {
        let response = self.request(json!({"type": "routing_status"})).await?;
        routing_event_status(response)
    }

    async fn routing_start(
        &mut self,
        service: &PersistedService,
        listeners: Vec<String>,
    ) -> Result<Value, String> {
        let response = self
            .request(json!({
                "type": "routing_start",
                "listen_address": service.listen_address,
                "preferred_port": service.preferred_port,
                "last_actual_port": service.actual_port,
                "listener_addresses": listeners,
            }))
            .await?;
        routing_event_status(response)
    }

    async fn routing_stop(&mut self) -> Result<(), String> {
        let response = self.request(json!({"type": "routing_stop"})).await?;
        routing_event_status(response).map(|_| ())
    }
}

fn routing_event_status(response: Value) -> Result<Value, String> {
    if let Some(error) = response["event"]["error"]["code"].as_str() {
        return Err(error.to_string());
    }
    response["event"]["status"]
        .as_object()
        .map(|_| response["event"]["status"].clone())
        .ok_or_else(|| "daemon routing response missing status".into())
}

pub(crate) async fn reconcile_persisted_service() -> Result<ReconcileOutcome, String> {
    let database = crate::paths::database_path()?;
    let Some(data_root) = database.parent() else {
        return Err("daemon data root unavailable".into());
    };
    let providers_db = data_root.join("providers.db");
    let Some((mut service, takeovers)) = load_persisted_state(&providers_db).await? else {
        return Ok(ReconcileOutcome::Skipped);
    };
    let Some(info) = read_live_daemon_info(data_root)? else {
        return Err("daemon discovery unavailable for routing reconciliation".into());
    };
    let mut control = ControlConnection::connect(&info).await?;
    let status = control.routing_status().await?;
    let daemon_status = status["status"].as_str().unwrap_or_default();
    match runtime_action(service.service_enabled, daemon_status) {
        RuntimeAction::Start => {
            let listeners = listener_addresses(&service, &takeovers);
            let status = control.routing_start(&service, listeners).await?;
            service.actual_port = status["actualPort"].as_u64().map(|port| port as u16);
            save_service(&providers_db, &service).await?;
            Ok(ReconcileOutcome::Started)
        }
        RuntimeAction::Stop => {
            control.routing_stop().await?;
            Ok(ReconcileOutcome::Stopped)
        }
        RuntimeAction::None => Ok(ReconcileOutcome::Noop),
    }
}

fn read_live_daemon_info(data_root: &Path) -> Result<Option<DaemonInfo>, String> {
    for path in [
        daemon_info_path(data_root, cfg!(debug_assertions)),
        daemon_info_path(data_root, !cfg!(debug_assertions)),
    ] {
        let Some(info) = read_daemon_info(&path)? else {
            continue;
        };
        if is_pid_alive(info.pid) {
            return Ok(Some(info));
        }
    }
    Ok(None)
}

async fn load_persisted_state(
    path: &Path,
) -> Result<Option<(PersistedService, Vec<Takeover>)>, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let mut connection = match SqliteConnection::connect_with(&options).await {
        Ok(connection) => connection,
        Err(_error) if !path.is_file() => return Ok(None),
        Err(error) => return Err(format!("providers database open failed: {error}")),
    };
    let Some(row) = sqlx::query("SELECT value FROM settings WHERE key = ?1")
        .bind(SERVICE_KEY)
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| format!("routing settings read failed: {error}"))?
    else {
        return Ok(None);
    };
    let raw: String = row
        .try_get("value")
        .map_err(|error| format!("routing settings value invalid: {error}"))?;
    let service =
        serde_json::from_str(&raw).map_err(|error| format!("routing service invalid: {error}"))?;
    let takeovers = sqlx::query("SELECT value FROM settings WHERE key = ?1")
        .bind(TAKEOVERS_KEY)
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| format!("routing takeovers read failed: {error}"))?
        .and_then(|row| row.try_get::<String, _>("value").ok())
        .and_then(|raw| serde_json::from_str::<TakeoversDocument>(&raw).ok())
        .map(|document| document.items)
        .unwrap_or_default();
    Ok(Some((service, takeovers)))
}

async fn save_service(path: &Path, service: &PersistedService) -> Result<(), String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("providers database write open failed: {error}"))?;
    let value = serde_json::to_string(service).map_err(|error| error.to_string())?;
    sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(value)
        .bind(SERVICE_KEY)
        .execute(&mut connection)
        .await
        .map_err(|error| format!("routing settings write failed: {error}"))?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeAction {
    None,
    Start,
    Stop,
}

fn runtime_action(service_enabled: bool, daemon_status: &str) -> RuntimeAction {
    match (service_enabled, daemon_status == "running") {
        (true, false) => RuntimeAction::Start,
        (false, true) => RuntimeAction::Stop,
        _ => RuntimeAction::None,
    }
}
fn listener_addresses(service: &PersistedService, takeovers: &[Takeover]) -> Vec<String> {
    let mut addresses = vec![service.listen_address.clone()];
    for takeover in takeovers {
        let address = match takeover.home_identity.environment_kind.as_str() {
            "wsl" if takeover.endpoint_mode == "wsl_mirrored" => Some("127.0.0.1".to_string()),
            "wsl" if takeover.endpoint_mode == "wsl_gateway" => {
                Some(takeover.advertised_host.clone())
            }
            _ => None,
        };
        if let Some(address) = address.filter(|address| !address.is_empty()) {
            if !addresses.iter().any(|current| current == &address) {
                addresses.push(address);
            }
        }
    }
    addresses
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_action_matches_tauri_reconciliation_rules() {
        assert_eq!(runtime_action(true, "stopped"), RuntimeAction::Start);
        assert_eq!(runtime_action(true, "running"), RuntimeAction::None);
        assert_eq!(runtime_action(false, "running"), RuntimeAction::Stop);
        assert_eq!(runtime_action(false, "stopped"), RuntimeAction::None);
    }
    #[test]
    fn listener_addresses_match_persisted_takeover_modes() {
        let service = PersistedService {
            schema_version: 1,
            service_enabled: true,
            listen_address: "127.0.0.1".into(),
            preferred_port: 15721,
            actual_port: None,
            show_local_quick_control: false,
            show_failover_quick_control: false,
            usage_logging_enabled: true,
        };
        let takeovers = vec![
            Takeover {
                home_identity: HomeIdentity {
                    environment_kind: "wsl".into(),
                },
                endpoint_mode: "wsl_mirrored".into(),
                advertised_host: String::new(),
            },
            Takeover {
                home_identity: HomeIdentity {
                    environment_kind: "wsl".into(),
                },
                endpoint_mode: "wsl_gateway".into(),
                advertised_host: "172.20.1.1".into(),
            },
        ];
        assert_eq!(
            listener_addresses(&service, &takeovers),
            ["127.0.0.1", "172.20.1.1"]
        );
    }
}
