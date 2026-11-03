use super::request_queue::{stage, Stage};
use super::*;

impl DaemonServer {
    // 只有表内确实不存在才返回 missing；锁/客户端失效是临时错误，不能删除前端恢复意图。
    // entry 锁内建立 replay 快照和订阅，Attached 入队之后才允许 live 越过屏障。
    pub(super) fn attach_session(
        &self,
        client_id: u64,
        id: u64,
        session_id: String,
        after_sequence: Option<u64>,
    ) -> DaemonFrame {
        if !is_valid_session_id(&session_id) {
            return err_frame(id, "invalid session id");
        }
        let session = match self.host.sessions.lock() {
            Ok(sessions) => match sessions.get(&session_id).cloned() {
                Some(session) => session,
                None => return err_frame(id, "session not found"),
            },
            Err(_) => return err_frame(id, "daemon state unavailable"),
        };
        stage(Stage::SessionLock);
        let entry = match session.lock() {
            Ok(entry) => entry,
            Err(_) => return err_frame(id, "session state unavailable"),
        };
        stage(Stage::ReplayRead);
        // An empty lost window must still invalidate cursors behind the last produced output.
        let oldest_sequence = entry
            .buffer
            .oldest_sequence()
            .unwrap_or(if entry.buffer.truncated {
                entry.next_sequence
            } else {
                0
            });
        let replay_reset = after_sequence
            .map(|sequence| sequence.saturating_add(1) < oldest_sequence)
            .unwrap_or(true);
        let replay = if replay_reset {
            entry.buffer.replay_entries()
        } else {
            entry.buffer.replay_entries_after(after_sequence)
        };
        let latest_sequence = entry.next_sequence.saturating_sub(1);
        let mut clients = match self.host.clients.lock() {
            Ok(clients) => clients,
            Err(_) => return err_frame(id, "client state unavailable"),
        };
        let Some(client) = clients.get_mut(&client_id) else {
            return err_frame(id, "client disconnected");
        };
        client.attached.insert(session_id.clone());
        client.unacknowledged_chars.insert(session_id.clone(), 0);
        client.flow_control_paused.remove(&session_id);
        client
            .last_sent_sequence
            .insert(session_id.clone(), latest_sequence);
        client
            .last_acknowledged_sequence
            .insert(session_id.clone(), latest_sequence);
        client.attaching.insert(session_id.clone(), Vec::new());
        DaemonFrame::Attached {
            id,
            session_id,
            replay_base64: String::new(),
            replay,
            latest_sequence,
            meta: entry.meta.clone(),
            replay_reset,
            replay_truncated: entry.buffer.truncated,
            oldest_sequence,
        }
    }

    // 心跳和只读盘点直接应答；其余操作在固定 worker 中执行，慢会话不占用 reader。
    pub(super) fn dispatch(
        self: &Arc<Self>,
        client_id: u64,
        frame: ClientFrame,
        writer: &Arc<ClientWriter>,
    ) -> bool {
        if matches!(
            frame,
            ClientFrame::Ping { .. } | ClientFrame::List { .. } | ClientFrame::Reconcile { .. }
        ) {
            if matches!(frame, ClientFrame::List { .. }) {
                self.host.flush_hook_cache_to(writer);
            }
            return writer
                .send_frame(&self.handle_frame(client_id, frame))
                .is_ok();
        }
        let (id, operation, key) = request_identity(&frame);
        let bytes = match serde_json::to_vec(&frame) {
            Ok(encoded) => encoded.len(),
            Err(_) => return false,
        };
        let server = Arc::clone(self);
        let output = Arc::clone(writer);
        self.host
            .requests
            .submit(key, client_id, id, operation, bytes, move || {
                if output.is_closed() {
                    return;
                }
                let attach_session = match &frame {
                    ClientFrame::Attach { session_id, .. } => Some(session_id.clone()),
                    _ => None,
                };
                let reply = server.handle_frame(client_id, frame);
                stage(Stage::Reply);
                if output.send_frame(&reply).is_err() {
                    output.close();
                    return;
                }
                if matches!(reply, DaemonFrame::Attached { .. }) {
                    if let Some(session) = attach_session {
                        server.host.complete_attach(client_id, &session);
                    }
                }
            })
    }

    // 二进制输入与 JSON 输入使用同一会话队列；检查点也必须遵守 replay/ACK 顺序。
    pub(super) fn queue_binary_frame(
        self: &Arc<Self>,
        client_id: u64,
        data: Vec<u8>,
        writer: &Arc<ClientWriter>,
    ) -> bool {
        let frame = match decode_binary_terminal_frame(&data) {
            Ok(frame) => frame,
            Err(_) => return false,
        };
        if !is_valid_session_id(&frame.session_id) {
            return false;
        }
        let operation = match frame.kind {
            BINARY_KIND_INPUT => "binary_input",
            BINARY_KIND_CHECKPOINT => "checkpoint",
            _ => return false,
        };
        let server = Arc::clone(self);
        let output = Arc::clone(writer);
        self.host.requests.submit(
            Some(format!("session:{}", frame.session_id)),
            client_id,
            0,
            operation,
            data.len(),
            move || {
                if !output.is_closed() && !server.handle_binary_frame(client_id, &data, &output) {
                    output.close();
                }
            },
        )
    }

    // 仅处理已 attach 会话的二进制输入或检查点，校验失败时要求关闭连接。
    pub(super) fn handle_binary_frame(
        &self,
        client_id: u64,
        data: &[u8],
        writer: &Arc<ClientWriter>,
    ) -> bool {
        let frame = match decode_binary_terminal_frame(data) {
            Ok(frame) => frame,
            Err(message) => {
                let _ = writer.send_frame(&DaemonFrame::Err { id: 0, message });
                return false;
            }
        };
        let attached = self
            .host
            .clients
            .lock()
            .ok()
            .and_then(|clients| {
                clients
                    .get(&client_id)
                    .map(|client| client.attached.contains(&frame.session_id))
            })
            .unwrap_or(false);
        if !attached || !is_valid_session_id(&frame.session_id) {
            let _ = writer.send_frame(&DaemonFrame::Err {
                id: 0,
                message: "binary frame session is not attached".to_string(),
            });
            return false;
        }
        match frame.kind {
            BINARY_KIND_INPUT => {
                stage(Stage::PtyWrite);
                self.host
                    .pty
                    .write_bytes(&frame.session_id, &frame.data)
                    .is_ok()
            }
            BINARY_KIND_CHECKPOINT => {
                let result = self
                    .host
                    .get_session(&frame.session_id)
                    .ok_or_else(|| "session not found".to_string())
                    .and_then(|session| {
                        stage(Stage::SessionLock);
                        let mut entry = session
                            .lock()
                            .map_err(|_| "session state unavailable".to_string())?;
                        let latest_sequence = entry.next_sequence.saturating_sub(1);
                        if frame.sequence > latest_sequence {
                            return Err("checkpoint sequence is ahead of daemon output".to_string());
                        }
                        stage(Stage::ReplayRead);
                        entry.buffer.accept_checkpoint(
                            frame.cols,
                            frame.rows,
                            frame.sequence,
                            frame.data,
                        )?;
                        entry.meta.replay_available = entry.buffer.replay_available();
                        entry.meta.replay_truncated = entry.buffer.truncated;
                        Ok(())
                    });
                let response = match result {
                    Ok(()) => DaemonFrame::CheckpointAccepted {
                        session_id: frame.session_id,
                        sequence: frame.sequence,
                    },
                    Err(message) => DaemonFrame::CheckpointRejected {
                        session_id: frame.session_id,
                        sequence: frame.sequence,
                        message,
                    },
                };
                writer.send_frame(&response).is_ok()
            }
            _ => false,
        }
    }
}

// 类型匹配产生静态操作名，绝不从请求正文或任意 type 字符串生成诊断内容。
fn request_identity(frame: &ClientFrame) -> (u64, &'static str, Option<String>) {
    let (id, operation, session) = match frame {
        ClientFrame::Create { id, session_id, .. } => (*id, "create", Some(session_id)),
        ClientFrame::Attach { id, session_id, .. } => (*id, "attach", Some(session_id)),
        ClientFrame::Write { id, session_id, .. } => (*id, "write", Some(session_id)),
        ClientFrame::Resize { id, session_id, .. } => (*id, "resize", Some(session_id)),
        ClientFrame::Ack { id, session_id, .. } => (*id, "ack", Some(session_id)),
        ClientFrame::Close { id, session_id, .. } => (*id, "close", Some(session_id)),
        ClientFrame::SetTerminalColors { id, session_id, .. } => (*id, "colors", Some(session_id)),
        ClientFrame::CloseAll { id } => return (*id, "close_all", None),
        ClientFrame::Detach { id } => return (*id, "detach", None),
        ClientFrame::Shutdown { id } => return (*id, "shutdown", None),
        ClientFrame::SshAgentRequest { id, ssh_launch, .. } => {
            return (
                *id,
                "ssh_request",
                Some(format!("ssh:{}", ssh_launch.host_id)),
            )
        }
        ClientFrame::SshAgentRelease { id, host_id, .. } => {
            return (*id, "ssh_release", Some(format!("ssh:{host_id}")))
        }
        ClientFrame::Status { id } => return (*id, "status", Some("status".into())),
        ClientFrame::RoutingReload { id, .. }
        | ClientFrame::RoutingStatus { id }
        | ClientFrame::RoutingStart { id, .. }
        | ClientFrame::RoutingStop { id }
        | ClientFrame::RoutingResetCircuit { id, .. } => {
            return (*id, "routing", Some("routing".into()))
        }
        ClientFrame::Auth { .. } => return (0, "auth", Some("auth".into())),
        ClientFrame::Ping { id } | ClientFrame::List { id } | ClientFrame::Reconcile { id, .. } => {
            return (*id, "control", Some("control".into()))
        }
    };
    (
        id,
        operation,
        session.map(|session| format!("session:{session}")),
    )
}
