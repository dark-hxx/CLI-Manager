use crate::auth::{cookie_value, hash_secret, normalize_pairing_code};
use crate::error::AppError;
use crate::state::AppState;
use crate::storage::now_ms;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap};
use axum::response::Response;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use cli_manager_web_protocol::{
    BrowserEventPayload, BrowserSocketFrame, BrowserToServerFrame, DeviceHostInfo, DeviceStatus,
    DeviceToServerFrame, DeviceWallpaperUpload, OperationStatus, ServerToDeviceFrame,
    TerminalCommand, TerminalOutputFrame, TerminalOutputKind, DEVICE_PROTOCOL_VERSION,
};
use futures_util::{Sink, SinkExt, StreamExt};
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Display;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, watch};
use uuid::Uuid;

const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_RECHECK_INTERVAL: Duration = Duration::from_secs(60);
const MAX_SOCKET_FRAME_BYTES: usize = 1024 * 1024;
const DEVICE_SEND_QUEUE: usize = 64;
const MAX_WALLPAPER_BYTES: usize = 384 * 1024;
const MAX_WALLPAPER_DIMENSION: u32 = 1024;
const MAX_TERMINAL_DATA_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSocketQuery {
    #[serde(default)]
    after_sequence: i64,
}

pub async fn browser_socket(
    State(state): State<AppState>,
    Query(query): Query<BrowserSocketQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    validate_browser_origin(&state, &headers)?;
    let Some(token) = cookie_value(&headers) else {
        return Ok(ws.on_upgrade(close_unauthorized));
    };
    let token_hash = hash_secret(&token);
    let Some(user) = state.storage.user_for_session(&token_hash).await? else {
        return Ok(ws.on_upgrade(close_unauthorized));
    };
    Ok(ws.on_upgrade(move |socket| async move {
        let mut shutdown = state.shutdown.subscribe();
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
          biased;
          _ = shutdown.changed() => {},
          _ = handle_browser_socket(
            socket,
            state,
            user.id,
            token_hash,
            query.after_sequence.max(0),
          ) => {},
        }
    }))
}

pub async fn device_socket(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    Ok(ws.on_upgrade(move |socket| async move {
        let mut shutdown = state.shutdown.subscribe();
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => {},
            _ = handle_device_socket(socket, state) => {},
        }
    }))
}

async fn close_unauthorized(mut socket: WebSocket) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: 4401,
            reason: "unauthorized".into(),
        })))
        .await;
}

async fn handle_browser_socket(
    socket: WebSocket,
    state: AppState,
    user_id: String,
    token_hash: String,
    after_sequence: i64,
) {
    let (mut sender, mut receiver) = socket.split();
    let mut live = state.registry.subscribe_browser();
    let mut revocations = state.registry.subscribe_session_revocations();
    let scope = match state.storage.session_device_scope(&token_hash).await {
        Ok(scope) => scope,
        Err(_) => return,
    };
    let latest_sequence = match state.storage.latest_browser_sequence(&user_id).await {
        Ok(sequence) => sequence,
        Err(error) => {
            tracing::warn!(%error, "browser websocket sequence lookup failed");
            return;
        }
    };
    if !send_json(&mut sender, &BrowserSocketFrame::Ready { latest_sequence }).await {
        return;
    }

    let mut cursor = if after_sequence > latest_sequence {
        0
    } else {
        after_sequence
    };
    loop {
        let events = match state.storage.browser_events_after(&user_id, cursor).await {
            Ok(events) => events,
            Err(error) => {
                tracing::warn!(%error, "browser websocket replay failed");
                return;
            }
        };
        if events.is_empty() {
            break;
        }
        for frame in events {
            if let BrowserSocketFrame::Event { sequence, .. } = &frame {
                cursor = cursor.max(*sequence);
            }
            // Ready triggers a current HTTP snapshot. Historical invalidations
            // add no data and must not launch thousands of duplicate refreshes.
            // Retain the high-water event so legacy clients advance their cursor.
            if matches!(&frame, BrowserSocketFrame::Event { sequence, payload: BrowserEventPayload::HistoryUpdated { .. }, .. } if *sequence < latest_sequence)
            {
                continue;
            }
            if !browser_frame_in_scope(&frame, scope.as_deref()) {
                continue;
            }
            if state
                .storage
                .user_for_session(&token_hash)
                .await
                .ok()
                .flatten()
                .is_none()
            {
                return;
            }
            if !send_json(&mut sender, &frame).await {
                return;
            }
        }
    }

    let mut session_check = tokio::time::interval(SESSION_RECHECK_INTERVAL);
    session_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !send_json(&mut sender, &BrowserSocketFrame::Heartbeat).await { break; }
            },
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Ping(data))) => {
                    if send_message(&mut sender, Message::Pong(data)).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    let Ok(BrowserToServerFrame::TerminalCommand { device_id, command }) = serde_json::from_str(&text) else { continue; };
                    if scope.as_deref().is_some_and(|value| value != device_id) { continue; }
                    if state.storage.device_for_user(&user_id, &device_id).await.ok().flatten().is_none() { continue; }
                    if !valid_terminal_command(&command) { continue; }
                    if !state.registry.send_device(&device_id, ServerToDeviceFrame::TerminalCommand { command }).await {
                        let _ = send_json(&mut sender, &BrowserSocketFrame::Error { code: "device_offline".into(), message: "device is offline".into() }).await;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            event = live.recv() => match event {
                Ok(event) if event.user_id == user_id => {
                    let sequence = match &event.frame { BrowserSocketFrame::Event { sequence, .. } => Some(*sequence), _ => None };
                    if sequence.is_some_and(|value| value <= cursor) { continue; }
                    if !browser_frame_in_scope(&event.frame, scope.as_deref()) { continue; }
                    if state.storage.user_for_session(&token_hash).await.ok().flatten().is_none() { break; }
                    if !send_json(&mut sender, &event.frame).await {
                        break;
                    }
                    if let Some(sequence) = sequence { cursor = sequence; }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = send_json(
                        &mut sender,
                        &BrowserSocketFrame::Error {
                            code: "replay_required".to_string(),
                            message: "client fell behind; reconnect with the last sequence".to_string(),
                        },
                    ).await;
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = session_check.tick() => {
                match state.storage.user_for_session(&token_hash).await {
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        let _ = send_message(
                            &mut sender,
                            Message::Close(Some(CloseFrame {
                                code: 4401,
                                reason: "session expired".into(),
                            })),
                        ).await;
                        break;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "browser websocket session check failed");
                        break;
                    }
                }
            }
            _ = revocations.recv() => {
                if state.storage.user_for_session(&token_hash).await.ok().flatten().is_none() {
                    let _ = send_message(&mut sender, Message::Close(Some(CloseFrame { code: 4401, reason: "session revoked".into() }))).await;
                    break;
                }
            }
        }
    }
}

fn browser_frame_in_scope(frame: &BrowserSocketFrame, scope: Option<&str>) -> bool {
    let Some(scope) = scope else {
        return true;
    };
    let BrowserSocketFrame::Event { payload, .. } = frame else {
        return match frame {
            BrowserSocketFrame::TerminalOutput { device_id, .. }
            | BrowserSocketFrame::TerminalStatus { device_id, .. } => device_id == scope,
            _ => true,
        };
    };
    let device_id = match payload {
        BrowserEventPayload::DeviceUpdated { device } => &device.id,
        BrowserEventPayload::OperationUpdated { operation } => &operation.device_id,
        BrowserEventPayload::HistoryUpdated { device_id, .. }
        | BrowserEventPayload::ConversationUpdated { device_id, .. } => device_id,
        BrowserEventPayload::PairingUpdated { .. } => return false,
    };
    device_id == scope
}

fn valid_terminal_command(command: &TerminalCommand) -> bool {
    let session_id = match command {
        TerminalCommand::Attach { session_id, .. }
        | TerminalCommand::Detach { session_id }
        | TerminalCommand::Close { session_id }
        | TerminalCommand::Input { session_id, .. }
        | TerminalCommand::Resize { session_id, .. } => session_id,
    };
    if session_id.is_empty() || session_id.len() > 128 {
        return false;
    }
    match command {
        TerminalCommand::Input { data, .. } => {
            !data.is_empty() && data.len() <= MAX_TERMINAL_DATA_BYTES
        }
        TerminalCommand::Resize { cols, rows, .. } => {
            (2..=500).contains(cols) && (1..=300).contains(rows)
        }
        _ => true,
    }
}

fn validate_terminal_output(
    session_id: &str,
    frames: &[TerminalOutputFrame],
) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("invalid_session_id".into());
    }
    if frames.is_empty() || frames.len() > 4096 {
        return Err(format!("invalid_frame_count: count={}", frames.len()));
    }
    let encoded_bytes = frames.iter().map(|frame| frame.data.len()).sum::<usize>();
    if encoded_bytes > MAX_TERMINAL_DATA_BYTES * 2 {
        return Err(format!(
            "encoded_batch_too_large: bytes={encoded_bytes}, limit={}",
            MAX_TERMINAL_DATA_BYTES * 2
        ));
    }
    for (index, frame) in frames.iter().enumerate() {
        if !((frame.cols == 0 && frame.rows == 0)
            || ((2..=500).contains(&frame.cols) && (1..=300).contains(&frame.rows)))
        {
            return Err(format!(
                "invalid_dimensions: frame={index}, cols={}, rows={}",
                frame.cols, frame.rows
            ));
        }
        if matches!(frame.kind, TerminalOutputKind::Reset) && !frame.data.is_empty() {
            return Err(format!(
                "reset_contains_data: frame={index}, bytes={}",
                frame.data.len()
            ));
        }
        if STANDARD.decode(frame.data.as_bytes()).is_err() {
            return Err(format!(
                "invalid_base64: frame={index}, bytes={}",
                frame.data.len()
            ));
        }
    }
    Ok(())
}

async fn handle_device_socket(mut socket: WebSocket, state: AppState) {
    let first = match tokio::time::timeout(FIRST_FRAME_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(message))) => message,
        _ => {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: "hello frame required".into(),
                })))
                .await;
            return;
        }
    };
    let hello = match parse_device_frame(first) {
        Ok(DeviceToServerFrame::Hello {
            protocol_version,
            device_id,
            client_id,
            machine_id,
            client_kind,
            device_token,
            name,
            platform,
            app_version,
            capabilities,
            host_info,
            wallpaper,
        }) => (
            protocol_version,
            client_id.unwrap_or(device_id),
            machine_id,
            client_kind,
            device_token,
            name,
            platform,
            app_version,
            capabilities,
            host_info,
            wallpaper,
        ),
        _ => {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: "first frame must be hello".into(),
                })))
                .await;
            return;
        }
    };
    let (
        protocol_version,
        device_id,
        machine_id,
        client_kind,
        device_token,
        name,
        platform,
        app_version,
        capabilities,
        host_info,
        wallpaper,
    ) = hello;
    if let Err(message) = validate_device_hello(
        protocol_version,
        &device_id,
        &name,
        &platform,
        &app_version,
        &capabilities,
        machine_id.as_deref(),
        client_kind.as_deref(),
        host_info.as_ref(),
    ) {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: 1008,
                reason: message.into(),
            })))
            .await;
        return;
    }
    let wallpaper = match wallpaper.as_ref().map(validate_wallpaper).transpose() {
        Ok(wallpaper) => wallpaper,
        Err(message) => {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: message.into(),
                })))
                .await;
            return;
        }
    };

    let mut user_id = match state.storage.device_user_id(&device_id).await {
        Ok(user_id) => user_id,
        Err(error) => {
            tracing::warn!(%error, %device_id, "device lookup failed");
            return;
        }
    };
    if user_id.is_some() {
        let verified = match device_token.as_deref() {
            Some(token) => match state
                .storage
                .verify_device_token(&device_id, &hash_secret(token))
                .await
            {
                Ok(verified) => verified,
                Err(error) => {
                    tracing::warn!(%error, %device_id, "device token lookup failed");
                    return;
                }
            },
            None => false,
        };
        if !verified {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 4401,
                    reason: "invalid device token".into(),
                })))
                .await;
            return;
        }
    }

    let device = match state
        .storage
        .upsert_device_hello(
            &device_id,
            &name,
            &platform,
            &app_version,
            &capabilities,
            machine_id.as_deref(),
            client_kind.as_deref(),
            host_info.as_ref(),
            wallpaper
                .as_ref()
                .map(|(bytes, revision)| (bytes.as_slice(), revision.as_str())),
        )
        .await
    {
        Ok(device) => device,
        Err(error) => {
            tracing::warn!(%error, %device_id, "device hello persistence failed");
            return;
        }
    };
    let connection_id = Uuid::new_v4().to_string();
    let (outbound_tx, mut outbound_rx) = mpsc::channel(DEVICE_SEND_QUEUE);
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    state
        .registry
        .register_device(
            device_id.clone(),
            connection_id.clone(),
            outbound_tx,
            shutdown_tx,
        )
        .await;

    let (mut sender, mut receiver) = socket.split();
    if !send_json(
        &mut sender,
        &ServerToDeviceFrame::HelloOk {
            paired: user_id.is_some(),
            device_token: None,
        },
    )
    .await
    {
        cleanup_device_connection(&state, &device_id, &connection_id, user_id.as_deref()).await;
        return;
    }
    if let Some(user_id) = user_id.as_deref() {
        if let Err(error) = state
            .publish_event(
                user_id,
                BrowserEventPayload::DeviceUpdated {
                    device: device.clone(),
                },
            )
            .await
        {
            tracing::warn!(%error, %device_id, "device online event publish failed");
        }
        if let Ok(operations) = state
            .storage
            .pending_operations_for_device(&device_id)
            .await
        {
            for operation in operations {
                if !state
                    .registry
                    .send_device(
                        &device_id,
                        ServerToDeviceFrame::OperationRequest { operation },
                    )
                    .await
                {
                    break;
                }
            }
        }
    }

    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    break;
                }
            }
            outgoing = outbound_rx.recv() => match outgoing {
                Some(frame) => {
                    if !send_json(&mut sender, &frame).await {
                        break;
                    }
                }
                None => break,
            },
            incoming = receiver.next() => {
                let Some(incoming) = incoming else { break; };
                let message = match incoming {
                    Ok(message) => message,
                    Err(_) => break,
                };
                if let Message::Ping(data) = message {
                    if send_message(&mut sender, Message::Pong(data)).await.is_err() {
                        break;
                    }
                    continue;
                }
                if matches!(message, Message::Close(_)) {
                    break;
                }
                let frame = match parse_device_frame(message) {
                    Ok(frame) => frame,
                    Err(message) => {
                        if !send_json(
                            &mut sender,
                            &ServerToDeviceFrame::Error {
                                code: "invalid_frame".to_string(),
                                message,
                            },
                        ).await {
                            break;
                        }
                        continue;
                    }
                };
                if !state
                    .registry
                    .is_current_device_connection(&device_id, &connection_id)
                    .await
                {
                    break;
                }
                if user_id.is_none() {
                    match state.storage.device_user_id(&device_id).await {
                        Ok(owner) => user_id = owner,
                        Err(error) => {
                            tracing::warn!(%error, %device_id, "device pairing state refresh failed");
                            let _ = send_device_error(
                                &mut sender,
                                "internal_error",
                                "device state could not be refreshed",
                            )
                            .await;
                            break;
                        }
                    }
                }
                let paired = user_id.is_some();
                match frame {
                    DeviceToServerFrame::Hello { .. } => {
                        if !send_device_error(&mut sender, "duplicate_hello", "hello may only be sent once").await {
                            break;
                        }
                    }
                    DeviceToServerFrame::PairingOffer { code, expires_at } => {
                        if paired {
                            if !send_device_error(&mut sender, "already_paired", "device is already paired").await {
                                break;
                            }
                            continue;
                        }
                        let code = match normalize_pairing_code(&code) {
                            Ok(code) if expires_at > now_ms() => code,
                            _ => {
                                if !send_device_error(&mut sender, "invalid_pairing_offer", "invalid or expired pairing offer").await {
                                    break;
                                }
                                continue;
                            }
                        };
                        match state.storage.store_pairing_offer(&device_id, &hash_secret(&code), expires_at).await {
                            Ok(pairing_id) => {
                                if !send_json(&mut sender, &ServerToDeviceFrame::PairingOffered { pairing_id }).await {
                                    break;
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, %device_id, "pairing offer persistence failed");
                                if !send_device_error(&mut sender, "pairing_offer_failed", "pairing offer could not be stored").await {
                                    break;
                                }
                            }
                        }
                    }
                    DeviceToServerFrame::Heartbeat { sequence } => {
                        match state.storage.accept_device_sequence(&device_id, "heartbeat", sequence).await {
                            Ok(_) => {
                                if let Err(error) = state
                                    .storage
                                    .mark_device_status(&device_id, DeviceStatus::Online)
                                    .await
                                {
                                    tracing::warn!(%error, %device_id, "heartbeat persistence failed");
                                }
                                if !send_json(&mut sender, &ServerToDeviceFrame::Ack { sequence }).await {
                                    break;
                                }
                            }
                            Err(_) => {
                                if !send_device_error(&mut sender, "invalid_sequence", "invalid heartbeat sequence").await {
                                    break;
                                }
                            }
                        }
                    }
                    DeviceToServerFrame::HistorySnapshot { sequence, sessions, workspace } => {
                        let Some(owner_id) = user_id.as_deref() else {
                            if !send_device_error(&mut sender, "pairing_required", "pair the device before sending history").await {
                                break;
                            }
                            continue;
                        };
                        if validate_history_sessions(&sessions, &device_id).is_err() {
                            if !send_device_error(&mut sender, "invalid_history_snapshot", "history sessions were rejected").await {
                                break;
                            }
                            continue;
                        }
                        if let Some(snapshot) = workspace.as_ref() {
                            if validate_workspace_snapshot(snapshot).is_err() {
                                if !send_device_error(&mut sender, "invalid_history_snapshot", "workspace snapshot was rejected").await {
                                    break;
                                }
                                continue;
                            }
                        }
                        match state.storage.replace_history_snapshot(&device_id, owner_id, sequence, &sessions, workspace.as_ref()).await {
                            Ok(changed) => {
                                if !send_json(&mut sender, &ServerToDeviceFrame::Ack { sequence }).await {
                                    break;
                                }
                                if changed {
                                    let latest_updated_at = sessions.iter().map(|session| session.updated_at).max().unwrap_or_else(now_ms);
                                    if let Err(error) = state.publish_event(
                                        owner_id,
                                        BrowserEventPayload::HistoryUpdated {
                                            device_id: device_id.clone(),
                                            latest_updated_at,
                                        },
                                    ).await {
                                        tracing::warn!(%error, %device_id, "history event publish failed");
                                    }
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, %device_id, "history snapshot rejected");
                                if !send_device_error(&mut sender, "history_storage_failed", "history snapshot could not be stored; see server log").await {
                                    break;
                                }
                            }
                        }
                    }
                    DeviceToServerFrame::ConversationEvent {event} => {
                        if !paired {
                            if !send_device_error(&mut sender, "pairing_required", "pair the device before sending conversation events").await { break; }
                            continue;
                        }
                        match state.storage.ingest_conversation_event(&device_id, &event).await {
                            Ok(published) => {
                                if let Some((user_id, frame)) = published {
                                    state.registry.broadcast_browser(crate::registry::BrowserBroadcast {user_id, frame});
                                }
                                if !send_json(&mut sender, &ServerToDeviceFrame::ConversationAck {operation_id:event.operation_id, sequence:event.sequence}).await { break; }
                            }
                            Err(error) => {
                                tracing::warn!(%error, %device_id, "conversation event rejected");
                                if !send_device_error(&mut sender, "invalid_conversation_event", "conversation event was rejected").await { break; }
                            }
                        }
                    }
                    DeviceToServerFrame::TerminalOutput { session_id, sequence, frames } => {
                        let Some(owner_id) = user_id.as_deref() else { continue; };
                        if let Err(reason) = validate_terminal_output(&session_id, &frames) {
                            tracing::warn!(%device_id, %reason, sequence, frame_count = frames.len(), "terminal output rejected");
                            if !session_id.is_empty() && session_id.len() <= 128 {
                                state.registry.broadcast_browser(crate::registry::BrowserBroadcast {
                                    user_id: owner_id.to_string(),
                                    frame: BrowserSocketFrame::TerminalStatus {
                                        device_id: device_id.clone(), session_id, status: "error".into(), exit_code: None, control_mode: None,
                                    },
                                });
                            }
                            if !send_device_error(&mut sender, "invalid_terminal_output", &reason).await { break; }
                            continue;
                        }
                        state.registry.broadcast_browser(crate::registry::BrowserBroadcast {
                            user_id: owner_id.to_string(),
                            frame: BrowserSocketFrame::TerminalOutput { device_id: device_id.clone(), session_id, sequence, frames },
                        });
                    }
                    DeviceToServerFrame::TerminalStatus { session_id, status, exit_code, control_mode } => {
                        let Some(owner_id) = user_id.as_deref() else { continue; };
                        let valid_control_mode = control_mode
                            .as_deref()
                            .is_none_or(|mode| matches!(mode, "desktop" | "web"));
                        if session_id.is_empty() || session_id.len() > 128 || !valid_control_mode || !matches!(status.as_str(), "running" | "exited" | "error") { continue; }
                        state.registry.broadcast_browser(crate::registry::BrowserBroadcast {
                            user_id: owner_id.to_string(),
                            frame: BrowserSocketFrame::TerminalStatus { device_id: device_id.clone(), session_id, status, exit_code, control_mode },
                        });
                    }
                    DeviceToServerFrame::OperationAccepted { operation_id } => {
                        if !paired {
                            if !send_device_error(
                                &mut sender,
                                "pairing_required",
                                "pair the device before updating operations",
                            )
                            .await
                            {
                                break;
                            }
                            continue;
                        }
                        if !handle_operation_update(
                            &state,
                            &mut sender,
                            &device_id,
                            &operation_id,
                            OperationStatus::Accepted,
                            None,
                            None,
                        ).await {
                            break;
                        }
                    }
                    DeviceToServerFrame::OperationRunning { operation_id } => {
                        if !paired {
                            if !send_device_error(
                                &mut sender,
                                "pairing_required",
                                "pair the device before updating operations",
                            )
                            .await
                            {
                                break;
                            }
                            continue;
                        }
                        if !handle_operation_update(
                            &state,
                            &mut sender,
                            &device_id,
                            &operation_id,
                            OperationStatus::Running,
                            None,
                            None,
                        ).await {
                            break;
                        }
                    }
                    DeviceToServerFrame::OperationCompleted { operation_id, status, result, error } => {
                        if !paired {
                            if !send_device_error(
                                &mut sender,
                                "pairing_required",
                                "pair the device before updating operations",
                            )
                            .await
                            {
                                break;
                            }
                            continue;
                        }
                        if !status.is_terminal() {
                            if !send_device_error(&mut sender, "invalid_operation_status", "completed operation must use a terminal status").await {
                                break;
                            }
                            continue;
                        }
                        if !handle_operation_update(
                            &state,
                            &mut sender,
                            &device_id,
                            &operation_id,
                            status,
                            result.as_ref(),
                            error.as_ref(),
                        ).await {
                            break;
                        }
                    }
                }
            }
        }
    }

    cleanup_device_connection(&state, &device_id, &connection_id, user_id.as_deref()).await;
}

async fn handle_operation_update<S>(
    state: &AppState,
    sender: &mut S,
    device_id: &str,
    operation_id: &str,
    status: OperationStatus,
    result: Option<&serde_json::Value>,
    error: Option<&cli_manager_web_protocol::OperationError>,
) -> bool
where
    S: Sink<Message> + Unpin,
    S::Error: Display,
{
    match state
        .storage
        .update_operation_status(device_id, operation_id, status, result, error)
        .await
    {
        Ok(Some((user_id, operation))) => {
            let acknowledged_status = operation.status.clone();
            if let Err(publish_error) = state
                .publish_event(
                    &user_id,
                    BrowserEventPayload::OperationUpdated { operation },
                )
                .await
            {
                tracing::warn!(error = %publish_error, "operation event publish failed");
            }
            send_json(
                sender,
                &ServerToDeviceFrame::OperationAck {
                    operation_id: operation_id.to_string(),
                    status: acknowledged_status,
                },
            )
            .await
        }
        Ok(None) => send_device_error(sender, "operation_not_found", "operation not found").await,
        Err(update_error) => {
            tracing::warn!(error = %update_error, %device_id, %operation_id, "operation update rejected");
            send_device_error(
                sender,
                "operation_update_rejected",
                "operation state transition was rejected",
            )
            .await
        }
    }
}

async fn cleanup_device_connection(
    state: &AppState,
    device_id: &str,
    connection_id: &str,
    user_id: Option<&str>,
) {
    if !state.registry.remove_device(device_id, connection_id).await {
        return;
    }
    match state
        .storage
        .mark_device_status(device_id, DeviceStatus::Offline)
        .await
    {
        Ok(Some(device)) => {
            let owner = match user_id {
                Some(user_id) => Some(user_id.to_string()),
                None => match state.storage.device_user_id(device_id).await {
                    Ok(owner) => owner,
                    Err(error) => {
                        tracing::warn!(%error, %device_id, "offline device owner lookup failed");
                        None
                    }
                },
            };
            if let Some(user_id) = owner.as_deref() {
                if let Err(error) = state
                    .publish_event(user_id, BrowserEventPayload::DeviceUpdated { device })
                    .await
                {
                    tracing::warn!(%error, %device_id, "device offline event publish failed");
                }
            }
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, %device_id, "failed to mark device offline"),
    }
}

fn parse_device_frame(message: Message) -> Result<DeviceToServerFrame, String> {
    let Message::Text(text) = message else {
        return Err("text frame required".to_string());
    };
    if text.len() > MAX_SOCKET_FRAME_BYTES {
        return Err("frame exceeds size limit".to_string());
    }
    serde_json::from_str(text.as_str()).map_err(|_| "invalid JSON frame".to_string())
}

fn validate_device_hello(
    protocol_version: u16,
    device_id: &str,
    name: &str,
    platform: &str,
    app_version: &str,
    capabilities: &[String],
    machine_id: Option<&str>,
    client_kind: Option<&str>,
    host_info: Option<&DeviceHostInfo>,
) -> Result<(), String> {
    if protocol_version != DEVICE_PROTOCOL_VERSION {
        return Err("unsupported protocol version".to_string());
    }
    if device_id.is_empty() || device_id.len() > 128 {
        return Err("invalid device id".to_string());
    }
    if name.is_empty() || name.len() > 128 {
        return Err("invalid device name".to_string());
    }
    if platform.is_empty() || platform.len() > 64 {
        return Err("invalid platform".to_string());
    }
    if app_version.is_empty() || app_version.len() > 64 {
        return Err("invalid app version".to_string());
    }
    if capabilities.len() > 64 || capabilities.iter().any(|value| value.len() > 128) {
        return Err("invalid capabilities".to_string());
    }
    if machine_id.is_some_and(|value| value.is_empty() || value.len() > 128) {
        return Err("invalid machine id".to_string());
    }
    if client_kind.is_some_and(|value| !matches!(value, "development" | "release")) {
        return Err("invalid client kind".to_string());
    }
    if let Some(info) = host_info {
        let strings = [
            (&info.host_name, 128usize),
            (&info.os_version, 256),
            (&info.cpu_arch, 64),
            (&info.cpu_model, 256),
        ];
        if strings
            .iter()
            .any(|(value, max)| value.is_empty() || value.len() > *max)
            || info.display_width == 0
            || info.display_height == 0
            || info.display_width > 16_384
            || info.display_height > 16_384
        {
            return Err("invalid host info".to_string());
        }
    }
    Ok(())
}

fn validate_workspace_snapshot(
    snapshot: &cli_manager_web_protocol::WorkspaceSnapshot,
) -> Result<(), String> {
    if let Some(terminals) = &snapshot.terminals {
        let mut ids = std::collections::HashSet::new();
        if terminals.len() > 2_000 || terminals.iter().any(|terminal| {
            !is_opaque_id(&terminal.session_id) || !is_opaque_id(&terminal.project_id)
                || !ids.insert(&terminal.session_id)
                || terminal.title.len() > 512
                || terminal.worktree_id.as_ref().is_some_and(|id| !is_opaque_id(id))
        }) {
            return Err("invalid workspace terminals".to_string());
        }
    }
    if snapshot.groups.len() > 2_000
        || snapshot.projects.len() > 10_000
        || snapshot.worktrees.len() > 20_000
    {
        return Err("workspace snapshot exceeds item limit".to_string());
    }
    if snapshot.groups.iter().any(|group| {
        !is_opaque_id(&group.id)
            || group.name.is_empty()
            || group.name.len() > 512
            || group
                .parent_id
                .as_ref()
                .is_some_and(|value| !is_opaque_id(value))
    }) {
        return Err("invalid workspace group".to_string());
    }
    if snapshot.projects.iter().any(|project| {
        project.id.is_empty()
            || !is_opaque_id(&project.id)
            || project.name.is_empty()
            || project.name.len() > 512
            || project
                .group_id
                .as_ref()
                .is_some_and(|value| !is_opaque_id(value))
            || project
                .source
                .as_ref()
                .is_some_and(|value| value != "claude" && value != "codex")
            || project.cwd.as_ref().is_some_and(|value| value.len() > 4096)
            || !matches!(project.environment_type.as_str(), "local" | "wsl" | "ssh")
    }) {
        return Err("invalid workspace project".to_string());
    }
    if snapshot.worktrees.iter().any(|worktree| {
        worktree.id.is_empty()
            || !is_opaque_id(&worktree.id)
            || !is_opaque_id(&worktree.project_id)
            || worktree.name.is_empty()
            || worktree.name.len() > 512
            || worktree.branch.len() > 512
            || worktree
                .cwd
                .as_ref()
                .is_some_and(|value| value.len() > 4096)
            || !matches!(worktree.status.as_str(), "active" | "missing")
    }) {
        return Err("invalid workspace worktree".to_string());
    }
    Ok(())
}

fn validate_history_sessions(
    sessions: &[cli_manager_web_protocol::HistorySessionSummary],
    device_id: &str,
) -> Result<(), String> {
    if sessions.len() > 20_000 {
        return Err("history snapshot exceeds item limit".to_string());
    }
    if sessions.iter().any(|session| {
        session.device_id != device_id
            || session.session_id.is_empty()
            || session.session_id.len() > 256
            || session.source.is_empty()
            || session.source.len() > 64
            || session.project_key.len() > 512
            || session
                .project_id
                .as_ref()
                .is_some_and(|value| !is_opaque_id(value))
            || session
                .worktree_id
                .as_ref()
                .is_some_and(|value| !is_opaque_id(value))
            || session.title.len() > 4096
            || session.cwd.as_ref().is_some_and(|value| value.len() > 4096)
    }) {
        return Err("invalid history session".to_string());
    }
    Ok(())
}

fn is_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains(':')
        && !value.chars().any(|ch| ch.is_control())
}

fn validate_wallpaper(upload: &DeviceWallpaperUpload) -> Result<(Vec<u8>, String), String> {
    if upload.mime_type != "image/jpeg"
        || upload.width == 0
        || upload.height == 0
        || upload.width > MAX_WALLPAPER_DIMENSION
        || upload.height > MAX_WALLPAPER_DIMENSION
        || upload.data_base64.len() > MAX_WALLPAPER_BYTES * 2
    {
        return Err("invalid wallpaper metadata".to_string());
    }
    let bytes = STANDARD
        .decode(&upload.data_base64)
        .map_err(|_| "invalid wallpaper encoding".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_WALLPAPER_BYTES {
        return Err("invalid wallpaper size".to_string());
    }
    let digest = Sha256::digest(&bytes);
    let revision = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((bytes, revision))
}

fn validate_browser_origin(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::forbidden("origin_required", "Origin header is required"))?;
    if state.config.allows_browser_origin(origin, headers
        .get(header::HOST).and_then(|value| value.to_str().ok())) {
        return Ok(());
    }
    Err(AppError::forbidden(
        "origin_forbidden",
        "request origin is not allowed",
    ))
}

async fn send_device_error<S>(sender: &mut S, code: &str, message: &str) -> bool
where
    S: Sink<Message> + Unpin,
    S::Error: Display,
{
    send_json(
        sender,
        &ServerToDeviceFrame::Error {
            code: code.to_string(),
            message: message.to_string(),
        },
    )
    .await
}

async fn send_json<S, T>(sender: &mut S, frame: &T) -> bool
where
    S: Sink<Message> + Unpin,
    S::Error: Display,
    T: Serialize,
{
    let text = match serde_json::to_string(frame) {
        Ok(text) => text,
        Err(error) => {
            tracing::warn!(%error, "websocket serialization failed");
            return false;
        }
    };
    send_message(sender, Message::Text(text.into()))
        .await
        .is_ok()
}

async fn send_message<S>(sender: &mut S, message: Message) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
    S::Error: Display,
{
    match tokio::time::timeout(SEND_TIMEOUT, sender.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            tracing::debug!(%error, "websocket send failed");
            Err(())
        }
        Err(_) => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_output_rejection_reports_metadata_without_content() {
        let mut frame = TerminalOutputFrame {
            sequence: 1,
            cols: 120,
            rows: 32,
            data: "YQ==".into(),
            kind: TerminalOutputKind::Output,
            replay_batch_end: true,
        };
        assert!(validate_terminal_output("session", &[frame.clone()]).is_ok());
        frame.data = "A".repeat(MAX_TERMINAL_DATA_BYTES * 2);
        assert!(validate_terminal_output("session", &[frame.clone()]).is_ok());
        frame.data.push_str("AAAA");
        assert!(validate_terminal_output("session", &[frame.clone()])
            .unwrap_err()
            .starts_with("encoded_batch_too_large:"));
        frame.data = "private-terminal-content!".into();
        let reason = validate_terminal_output("session", &[frame.clone()]).unwrap_err();
        assert!(reason.starts_with("invalid_base64:"));
        assert!(!reason.contains(&frame.data));
        frame.data = "YQ==".into();
        frame.cols = 501;
        assert!(validate_terminal_output("session", &[frame.clone()])
            .unwrap_err()
            .starts_with("invalid_dimensions:"));
        frame.cols = 120;
        frame.kind = TerminalOutputKind::Reset;
        assert!(validate_terminal_output("session", &[frame.clone()])
            .unwrap_err()
            .starts_with("reset_contains_data:"));
        frame.data.clear();
        assert!(validate_terminal_output("session", &[frame]).is_ok());
    }

    #[test]
    fn scoped_browser_replay_and_live_events_hide_other_devices_and_pairing() {
        let frame = BrowserSocketFrame::Event {
            sequence: 1,
            occurred_at: 1,
            payload: BrowserEventPayload::HistoryUpdated {
                device_id: "device-a".into(),
                latest_updated_at: 1,
            },
        };
        assert!(browser_frame_in_scope(&frame, None));
        assert!(browser_frame_in_scope(&frame, Some("device-a")));
        assert!(!browser_frame_in_scope(&frame, Some("device-b")));
        let frame = BrowserSocketFrame::Event {
            sequence: 2,
            occurred_at: 1,
            payload: BrowserEventPayload::PairingUpdated {
                device_id: "device-a".into(),
                pairing_id: "pairing".into(),
                status: "claimed".into(),
            },
        };
        assert!(!browser_frame_in_scope(&frame, Some("device-a")));
        let terminal = BrowserSocketFrame::TerminalOutput {
            device_id: "device-a".into(),
            session_id: "terminal-1".into(),
            sequence: 1,
            frames: vec![cli_manager_web_protocol::TerminalOutputFrame {
                sequence: 1,
                cols: 80,
                rows: 24,
                data: "YQ==".into(),
                kind: TerminalOutputKind::Output,
                replay_batch_end: false,
            }],
        };
        assert!(browser_frame_in_scope(&terminal, Some("device-a")));
        assert!(!browser_frame_in_scope(&terminal, Some("device-b")));
    }

    #[test]
    fn hello_validation_rejects_wrong_version() {
        assert!(validate_device_hello(
            DEVICE_PROTOCOL_VERSION + 1,
            "client",
            "PC",
            "windows",
            "1.0",
            &[],
            None,
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn hello_validation_bounds_capabilities() {
        let capabilities = vec!["x".to_string(); 65];
        assert!(validate_device_hello(
            DEVICE_PROTOCOL_VERSION,
            "client",
            "PC",
            "windows",
            "1.0",
            &capabilities,
            None,
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn hello_validation_accepts_client_identity() {
        assert!(validate_device_hello(
            DEVICE_PROTOCOL_VERSION,
            "client-1",
            "PC",
            "windows",
            "1.0",
            &[],
            Some("machine-1"),
            Some("development"),
            None,
        )
        .is_ok());
    }

    #[test]
    fn terminal_command_validation_bounds_input_and_resize() {
        assert!(valid_terminal_command(&TerminalCommand::Attach {
            session_id: "terminal-1".into(),
            after_sequence: Some(42),
        }));
        assert!(!valid_terminal_command(&TerminalCommand::Input {
            session_id: "terminal-1".into(),
            data: String::new(),
        }));
        assert!(!valid_terminal_command(&TerminalCommand::Resize {
            session_id: "terminal-1".into(),
            cols: 1,
            rows: 24,
        }));
        assert!(valid_terminal_command(&TerminalCommand::Resize {
            session_id: "terminal-1".into(),
            cols: 120,
            rows: 36,
        }));
    }

    #[test]
    fn wallpaper_validation_rejects_oversized_metadata() {
        let upload = DeviceWallpaperUpload {
            mime_type: "image/jpeg".to_string(),
            data_base64: STANDARD.encode([1, 2, 3]),
            width: MAX_WALLPAPER_DIMENSION + 1,
            height: 270,
        };
        assert!(validate_wallpaper(&upload).is_err());
    }

    #[test]
    fn workspace_validation_rejects_unknown_project_source() {
        let snapshot = cli_manager_web_protocol::WorkspaceSnapshot {
            terminals: None,
            groups: vec![],
            projects: vec![cli_manager_web_protocol::WorkspaceProjectSummary {
                id: "project-1".to_string(),
                name: "Project".to_string(),
                group_id: None,
                sort_order: 0,
                source: Some("unknown".to_string()),
                cwd: None,
                environment_type: "local".to_string(),
            }],
            worktrees: vec![],
            updated_at: 1,
        };
        assert!(validate_workspace_snapshot(&snapshot).is_err());
    }
}
