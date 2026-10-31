use crate::frame::Output;
use cli_manager_core::{discovery::DaemonInfo, pty_frame::MAX_FRAME_BYTES};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, net::Ipv4Addr, path::Path, time::Duration};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot},
    time::{timeout, Instant},
};
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

const CLIENT_FEATURES: [&str; 6] = [
    "ws_binary_output_v1",
    "ws_binary_input_v1",
    "ws_native_client_v1",
    "ws_ack_bytes_v1",
    "checkpoint_replay_v1",
    "session_status_push_v1",
];
const REQUIRED_FEATURES: [&str; 2] = ["ws_binary_output_v1", "ws_native_client_v1"];

pub struct Endpoint {
    pub port: u16,
    token: String,
}

impl Endpoint {
    pub fn new(port: u16, token: String) -> Result<Self, String> {
        if port == 0 || token.is_empty() {
            return Err("invalid daemon endpoint".into());
        }
        Ok(Self { port, token })
    }

    pub fn from_discovery(info: &DaemonInfo) -> Result<Self, String> {
        Self::new(info.ws_port, info.token.clone())
    }

    /// Read an existing daemon endpoint without spawning or mutating the daemon.
    pub fn from_discovery_path(path: &Path) -> Result<Option<Self>, String> {
        let Some(info) = cli_manager_core::discovery::read_daemon_info(path)? else {
            return Ok(None);
        };
        Ok(Some(Self::from_discovery(&info)?))
    }
}

#[derive(Clone)]
pub struct ConnectionOptions {
    pub request_timeout: Duration,
    pub heartbeat_interval: Duration,
    pub heartbeat_timeout: Duration,
    pub event_capacity: usize,
}

impl Default for ConnectionOptions {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(15),
            heartbeat_interval: Duration::from_secs(5),
            heartbeat_timeout: Duration::from_secs(15),
            event_capacity: 128,
        }
    }
}

#[derive(Debug)]
pub enum Event {
    Output(Output),
    Control(Value),
    Disconnected,
}

struct Request {
    frame: Value,
    binary: Option<Vec<u8>>,
    reply: Option<oneshot::Sender<Result<Value, String>>>,
}

/// Cloneable command handle. Dropping all handles detaches the connection without killing sessions.
#[derive(Clone)]
pub struct Client {
    commands: mpsc::Sender<Request>,
    request_timeout: Duration,
    pub features: Vec<String>,
}

impl Client {
    pub async fn connect(
        endpoint: Endpoint,
        options: ConnectionOptions,
    ) -> Result<(Self, mpsc::Receiver<Event>), String> {
        if options.event_capacity == 0
            || options.heartbeat_interval.is_zero()
            || options.request_timeout.is_zero()
            || options.heartbeat_timeout.is_zero()
        {
            return Err("invalid daemon connection options".into());
        }
        let handshake = async {
            let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, endpoint.port))
                .await
                .map_err(|_| "daemon connect failed")?;
            stream
                .set_nodelay(true)
                .map_err(|_| "daemon TCP setup failed")?;
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_FRAME_BYTES))
                .max_frame_size(Some(MAX_FRAME_BYTES));
            // Native clients deliberately omit browser Origin; daemon still requires token auth.
            let (mut socket, _) = client_async_with_config(
                format!("ws://127.0.0.1:{}/pty", endpoint.port),
                stream,
                Some(config),
            )
            .await
            .map_err(|_| "daemon websocket handshake failed")?;
            socket
                .send(Message::Text(
                    json!({
                        "type":"auth", "token":endpoint.token,
                        "client_version":env!("CARGO_PKG_VERSION"),
                        "client_features": CLIENT_FEATURES,
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .map_err(|_| "daemon auth send failed")?;
            let auth = loop {
                match socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        break serde_json::from_str::<Value>(&text)
                            .map_err(|_| "daemon auth malformed")?
                    }
                    Some(Ok(Message::Ping(data))) => socket
                        .send(Message::Pong(data))
                        .await
                        .map_err(|_| "daemon auth disconnected")?,
                    _ => return Err("daemon auth disconnected"),
                }
            };
            if auth["type"] != "auth_ok" {
                return Err("daemon authentication rejected");
            }
            if auth["protocol_version"] != 3 || auth["binary_protocol_version"] != 1 {
                return Err("unsupported daemon protocol");
            }
            let features: Vec<String> = auth["features"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            for required in REQUIRED_FEATURES {
                if !features.iter().any(|value| value == required) {
                    return Err("daemon native transport capability unavailable");
                }
            }
            Ok((socket, features))
        };
        let (socket, features) = timeout(options.request_timeout, handshake)
            .await
            .map_err(|_| "daemon handshake timeout")?
            .map_err(str::to_owned)?;
        let (commands, receiver) = mpsc::channel(64);
        let (events, output) = mpsc::channel(options.event_capacity);
        let client = Self {
            commands,
            request_timeout: options.request_timeout,
            features,
        };
        tokio::spawn(run(socket, receiver, events, options));
        Ok((client, output))
    }

    pub async fn request(&self, frame: Value) -> Result<Value, String> {
        if !frame.is_object()
            || frame["type"].as_str().is_none()
            || matches!(frame["type"].as_str(), Some("auth" | "ping"))
        {
            return Err("invalid daemon request".into());
        }
        let (reply, result) = oneshot::channel();
        timeout(self.request_timeout, async {
            self.commands
                .send(Request {
                    frame,
                    binary: None,
                    reply: Some(reply),
                })
                .await
                .map_err(|_| "daemon disconnected".to_owned())?;
            result.await.map_err(|_| "daemon disconnected".to_owned())?
        })
        .await
        .map_err(|_| "daemon request timeout".to_owned())?
    }

    pub async fn list(&self) -> Result<Value, String> {
        self.request(json!({"type":"list"})).await
    }
    pub async fn reconcile(&self, active_session_ids: &[String]) -> Result<Value, String> {
        let response = self
            .request(json!({"type":"reconcile", "active_session_ids": active_session_ids}))
            .await?;
        response
            .get("summary")
            .cloned()
            .ok_or_else(|| "daemon reconcile response missing summary".to_owned())
    }

    pub async fn create(
        &self,
        session_id: &str,
        cwd: Option<&str>,
        shell: Option<&str>,
    ) -> Result<Value, String> {
        if session_id.trim().is_empty() {
            return Err("invalid session id".into());
        }
        self.request(json!({"type":"create", "session_id":session_id, "cwd":cwd, "shell":shell}))
            .await
    }

    /// Create a session, or probe the daemon after a lost/duplicate create response.
    /// The probe is restricted to the requested session ID and never creates a second PTY.
    pub async fn create_or_probe(
        &self,
        session_id: &str,
        cwd: Option<&str>,
        shell: Option<&str>,
    ) -> Result<Value, String> {
        let create_error = match self.create(session_id, cwd, shell).await {
            Ok(response)
                if response["type"] == "created" && response["meta"]["sessionId"] == session_id =>
            {
                return Ok(response)
            }
            Ok(_) => return Err("daemon create response malformed".into()),
            Err(error) => error,
        };
        let listing = self.list().await?;
        let exists = listing["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|meta| meta["sessionId"].as_str() == Some(session_id));
        if exists {
            self.attach(session_id, None).await
        } else {
            Err(create_error)
        }
    }

    /// 优先复用 daemon 中已存在的稳定会话，再创建缺失会话。
    ///
    /// 工作区快照可能早于客户端进程退出，daemon 仍持有对应 PTY 时必须先
    /// attach，避免重复创建同一工作区会话。list 失败会直接返回，避免在
    /// 无法确认现存会话时盲目 create。
    pub async fn attach_or_create(
        &self,
        session_id: &str,
        after_sequence: Option<u64>,
        cwd: Option<&str>,
        shell: Option<&str>,
    ) -> Result<Value, String> {
        if session_id.trim().is_empty() {
            return Err("invalid session id".into());
        }
        let listing = self.list().await?;
        let exists = listing["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|meta| meta["sessionId"].as_str() == Some(session_id));
        if exists {
            return self.attach(session_id, after_sequence).await;
        }
        self.create_or_probe(session_id, cwd, shell).await
    }

    pub async fn attach(
        &self,
        session_id: &str,
        after_sequence: Option<u64>,
    ) -> Result<Value, String> {
        self.request(
            json!({"type":"attach", "session_id":session_id, "after_sequence":after_sequence}),
        )
        .await
    }

    pub async fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        self.request(json!({"type":"write", "session_id":session_id, "data":data}))
            .await
            .map(|_| ())
    }

    /// Binary input keeps arbitrary bytes intact and uses the daemon's bounded session queue.
    pub async fn write_bytes(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        if session_id.trim().is_empty() || data.is_empty() {
            return Err("invalid terminal input".into());
        }
        if !self
            .features
            .iter()
            .any(|feature| feature == "ws_binary_input_v1")
        {
            return self
                .write(
                    session_id,
                    std::str::from_utf8(data)
                        .map_err(|_| "binary input unavailable for non-utf8 data")?,
                )
                .await;
        }
        let bytes = cli_manager_core::pty_frame::encode_binary_terminal_frame(
            cli_manager_core::pty_frame::BINARY_KIND_INPUT,
            session_id,
            0,
            0,
            0,
            data,
        )?;
        let (reply, result) = oneshot::channel();
        timeout(self.request_timeout, async {
            self.commands
                .send(Request {
                    frame: Value::Null,
                    binary: Some(bytes),
                    reply: Some(reply),
                })
                .await
                .map_err(|_| "daemon disconnected".to_owned())?;
            result.await.map_err(|_| "daemon disconnected".to_owned())?
        })
        .await
        .map_err(|_| "daemon binary input timeout".to_owned())??;
        Ok(())
    }

    /// Upload an ANSI checkpoint for the attached session. The daemon consumes
    /// it only at the replay/reset boundary; it never becomes a live output frame.
    pub async fn checkpoint(
        &self,
        session_id: &str,
        sequence: u64,
        cols: u16,
        rows: u16,
        data: &[u8],
    ) -> Result<(), String> {
        if !self
            .features
            .iter()
            .any(|feature| feature == "checkpoint_replay_v1")
        {
            return Err("daemon checkpoint capability unavailable".into());
        }
        if session_id.trim().is_empty() || cols == 0 || rows == 0 || data.is_empty() {
            return Err("invalid terminal checkpoint".into());
        }
        let bytes = cli_manager_core::pty_frame::encode_binary_terminal_frame(
            cli_manager_core::pty_frame::BINARY_KIND_CHECKPOINT,
            session_id,
            sequence,
            cols,
            rows,
            data,
        )?;
        let (reply, result) = oneshot::channel();
        timeout(self.request_timeout, async {
            self.commands
                .send(Request {
                    frame: Value::Null,
                    binary: Some(bytes),
                    reply: Some(reply),
                })
                .await
                .map_err(|_| "daemon disconnected".to_owned())?;
            result.await.map_err(|_| "daemon disconnected".to_owned())?
        })
        .await
        .map_err(|_| "daemon checkpoint send timeout".to_owned())??;
        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("invalid terminal size".into());
        }
        self.request(json!({"type":"resize", "session_id":session_id, "cols":cols, "rows":rows}))
            .await
            .map(|_| ())
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        self.request(json!({"type":"close", "session_id":session_id}))
            .await
            .map(|_| ())
    }

    pub async fn close_all(&self) -> Result<(), String> {
        self.request(json!({"type":"close_all"})).await.map(|_| ())
    }

    pub async fn detach(&self) -> Result<(), String> {
        self.request(json!({"type":"detach"})).await.map(|_| ())
    }

    pub async fn shutdown_if_idle(&self) -> Result<(), String> {
        self.request(json!({"type":"shutdown"})).await.map(|_| ())
    }

    /// Must only be called after the terminal engine has committed the frame.
    pub async fn commit(&self, output: &Output) -> Result<(), String> {
        if output.kind == cli_manager_core::pty_frame::BINARY_KIND_REPLAY_RESET {
            return Ok(());
        }
        let byte_ack = self
            .features
            .iter()
            .any(|feature| feature == "ws_ack_bytes_v1");
        self.request(json!({
            "type":"ack", "session_id":output.session_id, "sequence":output.sequence,
            "char_count": if byte_ack { 0 } else { output.utf16_units() },
            "byte_count": byte_ack.then_some(output.data.len()),
        }))
        .await
        .map(|_| ())
    }
}

type Socket = tokio_tungstenite::WebSocketStream<TcpStream>;

async fn run(
    mut socket: Socket,
    mut commands: mpsc::Receiver<Request>,
    events: mpsc::Sender<Event>,
    options: ConnectionOptions,
) {
    let mut pending = HashMap::new();
    let mut next_id = 1_u64;
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + options.heartbeat_interval,
        options.heartbeat_interval,
    );
    let mut ping = None;
    let mut last_pong = Instant::now();
    let mut queued_event = None;
    loop {
        tokio::select! {
            permit = events.reserve(), if queued_event.is_some() => {
                let Ok(permit) = permit else { break; };
                permit.send(queued_event.take().unwrap());
            }
            _ = events.closed() => break,
            request = commands.recv() => {
                let Some(mut request) = request else { break; };
                if request.reply.as_ref().is_some_and(oneshot::Sender::is_closed) { continue; }
                if let Some(bytes) = request.binary.take() {
                    if !matches!(timeout(options.request_timeout, socket.send(Message::Binary(bytes.into()))).await, Ok(Ok(()))) { break; }
                    if let Some(reply) = request.reply { let _ = reply.send(Ok(Value::Null)); }
                    continue;
                }
                let id = next_id;
                next_id += 1;
                request.frame["id"] = id.into();
                pending.insert(id, request.reply.expect("normal requests have replies"));
                if !matches!(timeout(options.request_timeout, socket.send(Message::Text(request.frame.to_string().into()))).await, Ok(Ok(()))) { break; }
            }
            _ = heartbeat.tick() => {
                pending.retain(|_, reply| !reply.is_closed());
                if last_pong.elapsed() >= options.heartbeat_timeout { break; }
                if ping.is_none() {
                    let id = next_id;
                    next_id += 1;
                    ping = Some(id);
                    if !matches!(timeout(options.request_timeout, socket.send(Message::Text(json!({"type":"ping", "id":id}).to_string().into()))).await, Ok(Ok(()))) { break; }
                }
            }
            frame = socket.next(), if queued_event.is_none() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { break; };
                        if !value.is_object() || value["type"].as_str().is_none() { break; }
                        if value["type"] == "pong" && value["id"].as_u64() == ping {
                            ping = None;
                            last_pong = Instant::now();
                        } else if let Some(reply) = value["id"].as_u64().and_then(|id| pending.remove(&id)) {
                            let result = if value["type"] == "err" {
                                Err(value["message"].as_str().unwrap_or("daemon request rejected").to_owned())
                            } else { Ok(value) };
                            let _ = reply.send(result);
                        } else if value["id"].as_u64().is_none() {
                            queued_event = Some(Event::Control(value));
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let Ok(output) = Output::decode(bytes) else { break; };
                        queued_event = Some(Event::Output(output));
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if !matches!(timeout(options.request_timeout, socket.send(Message::Pong(data))).await, Ok(Ok(()))) { break; }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    _ => break,
                }
            }
        }
    }
    for (_, reply) in pending {
        let _ = reply.send(Err("daemon disconnected".into()));
    }
    let _ = timeout(options.request_timeout, socket.close(None)).await;
    let _ = events.try_send(Event::Disconnected);
}

#[cfg(test)]
mod tests {
    use super::*;
    use cli_manager_core::discovery::DaemonInfo;

    #[test]
    fn endpoint_rejects_missing_credentials_and_reads_discovery() {
        assert!(Endpoint::new(0, "token".into()).is_err());
        assert!(Endpoint::new(1234, String::new()).is_err());
        let info = DaemonInfo {
            port: 1,
            ws_port: 1234,
            hook_port: 2,
            token: "t".into(),
            pid: 3,
            version: "v".into(),
            protocol_version: 3,
            binary_protocol_version: 1,
            features: vec![],
        };
        assert_eq!(Endpoint::from_discovery(&info).unwrap().port, 1234);
    }

    #[test]
    fn discovery_path_reads_existing_endpoint_without_requiring_a_spawn() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("daemon.json");
        std::fs::write(
            &path,
            r#"{"port":1,"wsPort":1234,"hookPort":2,"token":"t","pid":1,"version":"v"}"#,
        )
        .unwrap();
        assert_eq!(
            Endpoint::from_discovery_path(&path).unwrap().unwrap().port,
            1234
        );
        assert!(
            Endpoint::from_discovery_path(&directory.path().join("missing.json"))
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn invalid_options_fail_before_network_io() {
        let options = ConnectionOptions {
            event_capacity: 0,
            ..Default::default()
        };
        let error = Client::connect(Endpoint::new(1234, "t".into()).unwrap(), options)
            .await
            .err()
            .unwrap();
        assert_eq!(error, "invalid daemon connection options");
    }
}
