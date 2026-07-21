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
    BrowserEventPayload, BrowserSocketFrame, DeviceHostInfo, DeviceStatus, DeviceToServerFrame,
    DeviceWallpaperUpload, OperationStatus, ServerToDeviceFrame, DEVICE_PROTOCOL_VERSION,
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
    Ok(ws.on_upgrade(move |socket| {
        handle_browser_socket(
            socket,
            state,
            user.id,
            token_hash,
            query.after_sequence.max(0),
        )
    }))
}

pub async fn device_socket(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    Ok(ws.on_upgrade(move |socket| handle_device_socket(socket, state)))
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
            if !send_json(&mut sender, &frame).await {
                return;
            }
        }
    }

    let mut session_check = tokio::time::interval(SESSION_RECHECK_INTERVAL);
    session_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Ping(data))) => {
                    if send_message(&mut sender, Message::Pong(data)).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            event = live.recv() => match event {
                Ok(event) if event.user_id == user_id => {
                    let sequence = match &event.frame {
                        BrowserSocketFrame::Event { sequence, .. } => *sequence,
                        _ => 0,
                    };
                    if sequence <= cursor {
                        continue;
                    }
                    if !send_json(&mut sender, &event.frame).await {
                        break;
                    }
                    cursor = sequence;
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
        }
    }
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
            device_token,
            name,
            platform,
            app_version,
            capabilities,
            host_info,
            wallpaper,
        }) => (
            protocol_version,
            device_id,
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
                    DeviceToServerFrame::HistorySnapshot { sequence, sessions } => {
                        let Some(owner_id) = user_id.as_deref() else {
                            if !send_device_error(&mut sender, "pairing_required", "pair the device before sending history").await {
                                break;
                            }
                            continue;
                        };
                        match state.storage.replace_history_snapshot(&device_id, owner_id, sequence, &sessions).await {
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
                                if !send_device_error(&mut sender, "invalid_history_snapshot", "history snapshot was rejected").await {
                                    break;
                                }
                            }
                        }
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
    if let Some(allowed) = state.config.allowed_origin.as_deref() {
        if origin == allowed {
            return Ok(());
        }
    } else if let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    {
        let scheme = if state.config.cookie_secure {
            "https"
        } else {
            "http"
        };
        if origin == format!("{scheme}://{host}") {
            return Ok(());
        }
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
    fn hello_validation_rejects_wrong_version() {
        assert!(validate_device_hello(2, "device", "PC", "windows", "1.0", &[], None).is_err());
    }

    #[test]
    fn hello_validation_bounds_capabilities() {
        let capabilities = vec!["x".to_string(); 65];
        assert!(
            validate_device_hello(1, "device", "PC", "windows", "1.0", &capabilities, None)
                .is_err()
        );
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
}
