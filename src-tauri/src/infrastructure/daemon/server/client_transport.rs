use super::super::protocol::{
    encode_binary_terminal_frame, encode_frame, DaemonFrame, BINARY_KIND_OUTPUT,
    BINARY_KIND_REPLAY, BINARY_KIND_REPLAY_RESET,
};
use super::{CLIENT_CONTROL_QUEUE_MAX_FRAMES, CLIENT_OUTPUT_QUEUE_MAX_BYTES};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::collections::VecDeque;
use std::io::Write;
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use tungstenite::{Message, WebSocket};

pub(super) enum ClientTransport {
    Ndjson(Mutex<TcpStream>),
    WebSocket(Mutex<WebSocket<TcpStream>>),
}

#[derive(Clone)]
pub(super) enum ClientWireFrame {
    Daemon(DaemonFrame),
    BinaryTerminal {
        kind: u8,
        session_id: String,
        sequence: u64,
        cols: u16,
        rows: u16,
        data: Vec<u8>,
    },
}

impl ClientTransport {
    pub(super) fn send_frame(&self, frame: &ClientWireFrame) -> Result<(), String> {
        match self {
            Self::Ndjson(writer) => match frame {
                ClientWireFrame::Daemon(frame) => writer
                    .lock()
                    .map_err(|_| "writer poisoned".to_string())?
                    .write_all(encode_frame(frame).as_bytes())
                    .map_err(|err| err.to_string()),
                ClientWireFrame::BinaryTerminal { .. } => {
                    Err("binary terminal frame is unavailable on ndjson transport".to_string())
                }
            },
            Self::WebSocket(socket) => {
                let mut socket = socket
                    .lock()
                    .map_err(|_| "websocket writer poisoned".to_string())?;
                match frame {
                    ClientWireFrame::BinaryTerminal {
                        kind,
                        session_id,
                        sequence,
                        cols,
                        rows,
                        data,
                    } => {
                        let binary = encode_binary_terminal_frame(
                            *kind, session_id, *sequence, *cols, *rows, data,
                        )?;
                        socket
                            .send(Message::Binary(binary.into()))
                            .map_err(|err| err.to_string())
                    }
                    ClientWireFrame::Daemon(DaemonFrame::Output {
                        session_id,
                        sequence,
                        cols,
                        rows,
                        data_base64,
                    }) => {
                        let data = STANDARD
                            .decode(data_base64)
                            .map_err(|err| err.to_string())?;
                        let binary = encode_binary_terminal_frame(
                            BINARY_KIND_OUTPUT,
                            session_id,
                            *sequence,
                            *cols,
                            *rows,
                            &data,
                        )?;
                        socket
                            .send(Message::Binary(binary.into()))
                            .map_err(|err| err.to_string())
                    }
                    ClientWireFrame::Daemon(frame) => socket
                        .send(Message::Text(
                            encode_frame(frame).trim_end().to_string().into(),
                        ))
                        .map_err(|err| err.to_string()),
                }
            }
        }
    }

    pub(super) fn is_websocket(&self) -> bool {
        matches!(self, Self::WebSocket(_))
    }

    pub(super) fn close(&self) {
        match self {
            Self::Ndjson(stream) => {
                if let Ok(stream) = stream.lock() {
                    let _ = stream.shutdown(Shutdown::Both);
                }
            }
            Self::WebSocket(socket) => {
                if let Ok(mut socket) = socket.lock() {
                    let _ = socket.close(None);
                    let _ = socket.get_mut().shutdown(Shutdown::Both);
                }
            }
        }
    }
}

pub(super) fn websocket_attached_frames(
    frame: &DaemonFrame,
) -> Result<Vec<ClientWireFrame>, String> {
    let DaemonFrame::Attached {
        id,
        session_id,
        replay,
        latest_sequence,
        meta,
        replay_reset,
        replay_truncated,
        oldest_sequence,
        ..
    } = frame
    else {
        return Err("expected attached frame".to_string());
    };
    let mut frames = Vec::with_capacity(replay.len() + 2);
    if *replay_reset {
        frames.push(ClientWireFrame::BinaryTerminal {
            kind: BINARY_KIND_REPLAY_RESET,
            session_id: session_id.clone(),
            sequence: 0,
            cols: replay.first().map(|entry| entry.cols).unwrap_or(80),
            rows: replay.first().map(|entry| entry.rows).unwrap_or(24),
            data: Vec::new(),
        });
    }
    for entry in replay {
        frames.push(ClientWireFrame::BinaryTerminal {
            kind: BINARY_KIND_REPLAY,
            session_id: session_id.clone(),
            sequence: entry.sequence,
            cols: entry.cols,
            rows: entry.rows,
            data: STANDARD
                .decode(&entry.data_base64)
                .map_err(|err| err.to_string())?,
        });
    }
    frames.push(ClientWireFrame::Daemon(DaemonFrame::Attached {
        id: *id,
        session_id: session_id.clone(),
        replay_base64: String::new(),
        replay: Vec::new(),
        latest_sequence: *latest_sequence,
        meta: meta.clone(),
        replay_reset: *replay_reset,
        replay_truncated: *replay_truncated,
        oldest_sequence: *oldest_sequence,
    }));
    Ok(frames)
}

pub(super) struct QueuedOutputFrame {
    pub(super) frame: ClientWireFrame,
    pub(super) live_output_bytes: usize,
}

pub(super) struct ClientWriterState {
    pub(super) control: VecDeque<ClientWireFrame>,
    pub(super) output: VecDeque<QueuedOutputFrame>,
    pub(super) output_bytes: usize,
    pub(super) closed: bool,
}

impl ClientWriterState {
    pub(super) fn pop_next(&mut self) -> Option<ClientWireFrame> {
        if let Some(frame) = self.control.pop_front() {
            return Some(frame);
        }
        let queued = self.output.pop_front()?;
        self.output_bytes = self.output_bytes.saturating_sub(queued.live_output_bytes);
        Some(queued.frame)
    }
}

pub(super) struct ClientWriter {
    pub(super) shared: Arc<(Mutex<ClientWriterState>, Condvar)>,
    pub(super) websocket: bool,
}

impl ClientWriter {
    pub(super) fn new(transport: ClientTransport) -> Arc<Self> {
        let websocket = transport.is_websocket();
        let shared = Arc::new((
            Mutex::new(ClientWriterState {
                control: VecDeque::new(),
                output: VecDeque::new(),
                output_bytes: 0,
                closed: false,
            }),
            Condvar::new(),
        ));
        let thread_shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            loop {
                let frame = {
                    let (lock, changed) = &*thread_shared;
                    let Ok(mut state) = lock.lock() else {
                        break;
                    };
                    while !state.closed && state.control.is_empty() && state.output.is_empty() {
                        let Ok(next) = changed.wait(state) else {
                            return;
                        };
                        state = next;
                    }
                    if state.closed {
                        None
                    } else {
                        state.pop_next()
                    }
                };
                let Some(frame) = frame else {
                    break;
                };
                if let Err(err) = transport.send_frame(&frame) {
                    log::debug!("daemon client writer stopped: {err}");
                    break;
                }
            }
            transport.close();
        });
        Arc::new(Self { shared, websocket })
    }

    pub(super) fn send_frame(&self, frame: &DaemonFrame) -> Result<(), String> {
        if self.websocket && matches!(frame, DaemonFrame::Attached { .. }) {
            return self.send_attached(frame);
        }
        let wire_frame = ClientWireFrame::Daemon(frame.clone());
        if matches!(frame, DaemonFrame::Output { .. }) {
            self.send_output(wire_frame, frame_payload_bytes(frame))
        } else {
            self.send_control(wire_frame)
        }
    }

    pub(super) fn send_attached(&self, frame: &DaemonFrame) -> Result<(), String> {
        let frames = websocket_attached_frames(frame)?;
        let (lock, changed) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "client writer unavailable".to_string())?;
        if state.closed {
            return Err("client writer closed".to_string());
        }
        state
            .output
            .extend(frames.into_iter().map(|frame| QueuedOutputFrame {
                frame,
                live_output_bytes: 0,
            }));
        changed.notify_one();
        Ok(())
    }

    pub(super) fn send_control(&self, frame: ClientWireFrame) -> Result<(), String> {
        let (lock, changed) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "client writer unavailable".to_string())?;
        if state.closed || state.control.len() >= CLIENT_CONTROL_QUEUE_MAX_FRAMES {
            state.closed = true;
            changed.notify_all();
            return Err("client control queue full".to_string());
        }
        state.control.push_back(frame);
        changed.notify_one();
        Ok(())
    }

    pub(super) fn send_output(&self, frame: ClientWireFrame, bytes: usize) -> Result<(), String> {
        let (lock, changed) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "client writer unavailable".to_string())?;
        if state.closed || state.output_bytes.saturating_add(bytes) > CLIENT_OUTPUT_QUEUE_MAX_BYTES
        {
            state.closed = true;
            changed.notify_all();
            return Err("client output queue full".to_string());
        }
        state.output_bytes = state.output_bytes.saturating_add(bytes);
        state.output.push_back(QueuedOutputFrame {
            frame,
            live_output_bytes: bytes,
        });
        changed.notify_one();
        Ok(())
    }

    pub(super) fn close(&self) {
        let (lock, changed) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            state.closed = true;
            changed.notify_all();
        }
    }
}

pub(super) fn frame_payload_bytes(frame: &DaemonFrame) -> usize {
    match frame {
        DaemonFrame::Output { data_base64, .. } => data_base64.len(),
        _ => 0,
    }
}
