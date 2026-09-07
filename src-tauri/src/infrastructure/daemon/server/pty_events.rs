use super::super::protocol::DaemonFrame;
use super::{now_ms, DaemonHost, OUTPUT_BUFFERING_DURATION, OUTPUT_BUFFERING_MAX_BYTES};
use crate::pty::manager::{PtyEventSink, PtyProcessStatus};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::Instant;

/// daemon 侧 [`PtyEventSink`]：输出进 ring buffer 并推送给订阅客户端。
pub(super) struct DaemonPtyEventSink {
    pub(super) sender: SyncSender<DaemonPtyEvent>,
}

pub(super) enum DaemonPtyEvent {
    Output(Vec<u8>),
    Status(PtyProcessStatus),
}

impl DaemonPtyEventSink {
    pub(super) fn new(host: Arc<DaemonHost>, session_id: String) -> Self {
        let (sender, receiver) = sync_channel(1);
        std::thread::spawn(move || {
            let mut carried = None;
            loop {
                let first = match carried.take().or_else(|| receiver.recv().ok()) {
                    Some(event) => event,
                    None => return,
                };
                match first {
                    DaemonPtyEvent::Status(status) => {
                        emit_daemon_status(&host, &session_id, status);
                        return;
                    }
                    DaemonPtyEvent::Output(data) => {
                        let mut pending = data;
                        let deadline = Instant::now() + OUTPUT_BUFFERING_DURATION;
                        let mut final_status = None;
                        while pending.len() < OUTPUT_BUFFERING_MAX_BYTES {
                            let now = Instant::now();
                            if now >= deadline {
                                break;
                            }
                            match receiver.recv_timeout(deadline.saturating_duration_since(now)) {
                                Ok(DaemonPtyEvent::Output(data)) => {
                                    if output_batch_would_overflow(pending.len(), data.len()) {
                                        carried = Some(DaemonPtyEvent::Output(data));
                                        break;
                                    }
                                    pending.extend_from_slice(&data);
                                }
                                Ok(DaemonPtyEvent::Status(status)) => {
                                    final_status = Some(status);
                                    break;
                                }
                                Err(RecvTimeoutError::Timeout) => break,
                                Err(RecvTimeoutError::Disconnected) => break,
                            }
                        }
                        emit_daemon_output(&host, &session_id, &pending);
                        if let Some(status) = final_status {
                            emit_daemon_status(&host, &session_id, status);
                            return;
                        }
                    }
                }
            }
        });
        Self { sender }
    }
}

pub(super) fn output_batch_would_overflow(pending_bytes: usize, next_bytes: usize) -> bool {
    pending_bytes > 0 && pending_bytes.saturating_add(next_bytes) > OUTPUT_BUFFERING_MAX_BYTES
}

impl PtyEventSink for DaemonPtyEventSink {
    fn on_output(&self, _session_id: &str, data: &[u8]) {
        let _ = self.sender.send(DaemonPtyEvent::Output(data.to_vec()));
    }

    fn on_status(&self, _session_id: &str, status: PtyProcessStatus) {
        let _ = self.sender.send(DaemonPtyEvent::Status(status));
    }
}

pub(super) fn emit_daemon_output(host: &DaemonHost, session_id: &str, data: &[u8]) {
    let char_count = String::from_utf8_lossy(data).encode_utf16().count();
    let Some(session) = host.get_session(session_id) else {
        return;
    };
    let Ok(mut entry) = session.lock() else {
        return;
    };
    let sequence = entry.next_sequence;
    entry.next_sequence = entry.next_sequence.saturating_add(1);
    let output_size = (entry.cols, entry.rows);
    entry
        .buffer
        .push_output(output_size.0, output_size.1, sequence, data);
    entry.meta.replay_available = entry.buffer.replay_available();
    entry.meta.replay_truncated = entry.buffer.truncated;
    let frame = DaemonFrame::Output {
        session_id: session_id.to_string(),
        sequence,
        cols: output_size.0,
        rows: output_size.1,
        data_base64: STANDARD.encode(data),
    };
    host.push_output_to_attached(session_id, sequence, char_count, &frame);
}

pub(super) fn emit_daemon_status(host: &DaemonHost, session_id: &str, status: PtyProcessStatus) {
    if status.status == "running" {
        return;
    }
    if let Some(session) = host.get_session(session_id) {
        if let Ok(mut entry) = session.lock() {
            entry.meta.alive = false;
            if !matches!(entry.meta.task_status.as_deref(), Some("done" | "failed")) {
                entry.meta.task_status = Some(if status.status == "error" {
                    "failed".to_string()
                } else {
                    "done".to_string()
                });
                entry.meta.task_updated_at_ms = Some(now_ms());
            }
        }
    }
    host.push_to_attached(
        session_id,
        &DaemonFrame::Exit {
            session_id: session_id.to_string(),
            exit_code: status.exit_code,
        },
    );
    host.release_ssh_agent_bridge(session_id);
    host.enforce_total_buffer_cap();
}
