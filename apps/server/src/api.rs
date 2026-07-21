use crate::auth::{
    clear_session_cookie, cookie_value, hash_secret, normalize_pairing_code, optional_user,
    random_token, require_user, session_cookie, verify_password, SESSION_TTL_MS,
};
use crate::error::AppError;
use crate::state::AppState;
use crate::storage::now_ms;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use cli_manager_web_protocol::{
    AuthStatusResponse, BrowserEventPayload, DeviceView, HistorySessionSummary, OperationStatus,
    OperationView, ServerToDeviceFrame,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_OPERATION_PAYLOAD_BYTES: usize = 256 * 1024;
const ENABLED_OPERATION_KINDS: &[&str] = &[
    "conversation.start",
    "conversation.prompt",
    "ssh.hosts.list",
    "ssh.client_status",
    "ssh.test_connection",
    "ssh.check_path",
    "ssh.list_directories",
    "ssh.host.create",
    "ssh.host.update",
    "ssh.host.delete",
    "file.list",
    "file.search",
    "file.search_content",
    "file.create",
    "file.create_directory",
    "file.rename",
    "file.copy",
    "file.move",
    "file.delete",
    "git.status",
    "git.branches",
    "git.fetch",
    "git.checkout",
    "git.create_branch",
    "git.stage",
    "git.unstage",
    "git.commit",
    "git.pull",
    "git.push",
    "git.discard",
    "git.delete_untracked",
    "worktree.list",
    "worktree.create",
    "worktree.check_deps",
    "worktree.merge",
    "worktree.remove",
    "hook.status",
    "hook.install",
    "hook.repair",
    "hook.test",
    "hook.uninstall",
];

const CONFIRMED_OPERATION_KINDS: &[&str] = &[
    "ssh.host.create",
    "ssh.host.update",
    "ssh.host.delete",
    "file.create",
    "file.create_directory",
    "file.rename",
    "file.copy",
    "file.move",
    "file.delete",
    "git.fetch",
    "git.checkout",
    "git.create_branch",
    "git.stage",
    "git.unstage",
    "git.commit",
    "git.pull",
    "git.push",
    "git.discard",
    "git.delete_untracked",
    "worktree.create",
    "worktree.merge",
    "worktree.remove",
    "hook.install",
    "hook.repair",
    "hook.uninstall",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "cli-manager-web-server",
        version: env!("CARGO_PKG_VERSION"),
    })
}

pub async fn not_found() -> AppError {
    AppError::not_found("route_not_found", "API route not found")
}

pub async fn auth_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AuthStatusResponse>, AppError> {
    let user = optional_user(&state, &headers).await?;
    Ok(Json(AuthStatusResponse {
        authenticated: user.is_some(),
        user,
    }))
}

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<AppState>,
    Json(request): Json<LoginRequest>,
) -> Result<Response, AppError> {
    if request.username.len() > 128 || request.password.len() > 1024 {
        return Err(AppError::bad_request(
            "invalid_credentials",
            "invalid username or password",
        ));
    }
    let Some(user) = state
        .storage
        .find_user_by_username(request.username.trim())
        .await?
    else {
        return Err(AppError::Api {
            status: StatusCode::UNAUTHORIZED,
            code: "invalid_credentials",
            message: "invalid username or password".to_string(),
        });
    };
    let password = request.password;
    let password_hash = user.password_hash.clone();
    let verified = tokio::task::spawn_blocking(move || verify_password(&password, &password_hash))
        .await
        .map_err(|err| AppError::Internal(format!("password verifier failed: {err}")))?;
    if !verified {
        return Err(AppError::Api {
            status: StatusCode::UNAUTHORIZED,
            code: "invalid_credentials",
            message: "invalid username or password".to_string(),
        });
    }
    let token = random_token();
    state
        .storage
        .create_browser_session(&hash_secret(&token), &user.id, now_ms() + SESSION_TTL_MS)
        .await?;
    let cookie = HeaderValue::from_str(&session_cookie(&token, state.config.cookie_secure))
        .map_err(|err| AppError::Internal(format!("invalid session cookie: {err}")))?;
    let mut response = Json(AuthStatusResponse {
        authenticated: true,
        user: Some(cli_manager_web_protocol::UserView {
            id: user.id,
            username: user.username,
        }),
    })
    .into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

#[derive(Serialize)]
pub struct OkResponse {
    ok: bool,
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    if let Some(token) = cookie_value(&headers) {
        state
            .storage
            .delete_browser_session(&hash_secret(&token))
            .await?;
    }
    let cookie = HeaderValue::from_str(&clear_session_cookie(state.config.cookie_secure))
        .map_err(|err| AppError::Internal(format!("invalid clear cookie: {err}")))?;
    let mut response = Json(OkResponse { ok: true }).into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

#[derive(Serialize)]
pub struct DevicesResponse {
    devices: Vec<DeviceView>,
}

pub async fn list_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DevicesResponse>, AppError> {
    let user = require_user(&state, &headers).await?;
    Ok(Json(DevicesResponse {
        devices: state.storage.list_devices(&user.id).await?,
    }))
}

pub async fn get_device_wallpaper(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
) -> Result<Response, AppError> {
    let user = require_user(&state, &headers).await?;
    let wallpaper = state
        .storage
        .device_wallpaper_for_user(&user.id, &device_id)
        .await?
        .ok_or_else(|| AppError::not_found("wallpaper_not_found", "device wallpaper not found"))?;
    let mut response = wallpaper.bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", wallpaper.revision))
            .map_err(|error| AppError::Internal(format!("invalid wallpaper revision: {error}")))?,
    );
    Ok(response)
}

#[derive(Deserialize)]
pub struct PairingClaimRequest {
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    id: String,
    status: &'static str,
    expires_at: i64,
}

#[derive(Serialize)]
pub struct PairingClaimResponse {
    pairing: PairingView,
    device: DeviceView,
}

pub async fn claim_pairing(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PairingClaimRequest>,
) -> Result<Json<PairingClaimResponse>, AppError> {
    let user = require_user(&state, &headers).await?;
    let code = normalize_pairing_code(&request.code)?;
    let device_token = random_token();
    let claim = state
        .storage
        .claim_pairing(&hash_secret(&code), &user.id, &hash_secret(&device_token))
        .await?;
    if !state
        .registry
        .send_device(
            &claim.device.id,
            ServerToDeviceFrame::PairingClaimed {
                pairing_id: claim.pairing_id.clone(),
                device_token,
            },
        )
        .await
    {
        state
            .storage
            .rollback_pairing_claim(&claim.pairing_id, &user.id)
            .await?;
        return Err(AppError::conflict(
            "device_disconnected",
            "device disconnected before pairing completed",
        ));
    }
    if let Err(error) = state
        .publish_event(
            &user.id,
            BrowserEventPayload::PairingUpdated {
                pairing_id: claim.pairing_id.clone(),
                status: "claimed".to_string(),
                device_id: claim.device.id.clone(),
            },
        )
        .await
    {
        tracing::warn!(%error, pairing_id = %claim.pairing_id, "pairing event publish failed");
    }
    if let Err(error) = state
        .publish_event(
            &user.id,
            BrowserEventPayload::DeviceUpdated {
                device: claim.device.clone(),
            },
        )
        .await
    {
        tracing::warn!(%error, device_id = %claim.device.id, "paired device event publish failed");
    }
    Ok(Json(PairingClaimResponse {
        pairing: PairingView {
            id: claim.pairing_id,
            status: "claimed",
            expires_at: claim.expires_at,
        },
        device: claim.device,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    device_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResponse {
    items: Vec<HistorySessionSummary>,
    next_offset: Option<u32>,
}

pub async fn list_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryResponse>, AppError> {
    let user = require_user(&state, &headers).await?;
    if let Some(device_id) = query.device_id.as_deref() {
        state
            .storage
            .device_for_user(&user.id, device_id)
            .await?
            .ok_or_else(|| AppError::not_found("device_not_found", "device not found"))?;
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let offset = query.offset.unwrap_or(0);
    let items = state
        .storage
        .list_history(&user.id, query.device_id.as_deref(), limit, offset)
        .await?;
    let next_offset = (items.len() == limit as usize).then_some(offset + limit);
    Ok(Json(HistoryResponse { items, next_offset }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOperationRequest {
    device_id: String,
    kind: String,
    idempotency_key: String,
    payload: Value,
}

#[derive(Serialize)]
pub struct OperationResponse {
    operation: OperationView,
}

pub async fn create_operation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateOperationRequest>,
) -> Result<(StatusCode, Json<OperationResponse>), AppError> {
    let user = require_user(&state, &headers).await?;
    validate_operation_request(&request)?;
    let device = state
        .storage
        .device_for_user(&user.id, &request.device_id)
        .await?
        .ok_or_else(|| AppError::not_found("device_not_found", "device not found"))?;
    if let Some(operation) = state
        .storage
        .operation_by_idempotency(&user.id, &request.idempotency_key)
        .await?
    {
        if !operation_matches_request(&operation, &request) {
            return Err(AppError::conflict(
                "idempotency_conflict",
                "idempotencyKey was already used for a different operation",
            ));
        }
        return Ok((StatusCode::OK, Json(OperationResponse { operation })));
    }
    let required_capability = operation_capability(&request.kind);
    if !device
        .capabilities
        .iter()
        .any(|capability| capability == required_capability)
    {
        return Err(AppError::conflict(
            "device_capability_unavailable",
            "the selected device does not support this operation",
        ));
    }
    if !state.registry.is_device_online(&request.device_id).await {
        return Err(AppError::conflict("device_offline", "device is offline"));
    }
    let mut operation = state
        .storage
        .create_operation(
            &user.id,
            &request.device_id,
            &request.kind,
            &request.idempotency_key,
            &request.payload,
            OperationStatus::Submitted,
        )
        .await?;
    if !operation_matches_request(&operation, &request) {
        return Err(AppError::conflict(
            "idempotency_conflict",
            "idempotencyKey was already used for a different operation",
        ));
    }
    if !state
        .registry
        .send_device(
            &request.device_id,
            ServerToDeviceFrame::OperationRequest {
                operation: operation.clone(),
            },
        )
        .await
    {
        if let Some((_, updated)) = state
            .storage
            .update_operation_status(
                &request.device_id,
                &operation.id,
                OperationStatus::WaitingDevice,
                None,
                None,
            )
            .await?
        {
            operation = updated;
        }
    }
    if let Err(error) = state
        .publish_event(
            &user.id,
            BrowserEventPayload::OperationUpdated {
                operation: operation.clone(),
            },
        )
        .await
    {
        tracing::warn!(%error, operation_id = %operation.id, "operation event publish failed");
    }
    Ok((StatusCode::CREATED, Json(OperationResponse { operation })))
}

pub async fn get_operation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(operation_id): Path<String>,
) -> Result<Json<OperationResponse>, AppError> {
    let user = require_user(&state, &headers).await?;
    let operation = state
        .storage
        .operation_for_user(&user.id, &operation_id)
        .await?
        .ok_or_else(|| AppError::not_found("operation_not_found", "operation not found"))?;
    Ok(Json(OperationResponse { operation }))
}

fn validate_operation_request(request: &CreateOperationRequest) -> Result<(), AppError> {
    if request.device_id.is_empty() || request.device_id.len() > 128 {
        return Err(AppError::bad_request(
            "invalid_device_id",
            "invalid deviceId",
        ));
    }
    if request.kind.is_empty() || request.kind.len() > 128 {
        return Err(AppError::bad_request(
            "invalid_operation_kind",
            "invalid operation kind",
        ));
    }
    if !ENABLED_OPERATION_KINDS.contains(&request.kind.as_str()) {
        return Err(AppError::bad_request(
            "unsupported_operation_kind",
            "operation kind is not enabled for this Web release",
        ));
    }
    if request.idempotency_key.is_empty() || request.idempotency_key.len() > 128 {
        return Err(AppError::bad_request(
            "invalid_idempotency_key",
            "invalid idempotencyKey",
        ));
    }
    let Some(payload) = request.payload.as_object() else {
        return Err(AppError::bad_request(
            "invalid_operation_payload",
            "operation payload must be an object",
        ));
    };
    if serde_json::to_vec(&request.payload)?.len() > MAX_OPERATION_PAYLOAD_BYTES {
        return Err(AppError::bad_request(
            "operation_payload_too_large",
            "operation payload is too large",
        ));
    }
    if matches!(
        request.kind.as_str(),
        "conversation.start" | "conversation.prompt"
    ) && payload
        .get("prompt")
        .and_then(Value::as_str)
        .is_none_or(|prompt| prompt.trim().is_empty())
    {
        return Err(AppError::bad_request(
            "invalid_operation_payload",
            "payload.prompt must be a non-empty string",
        ));
    }
    if operation_requires_confirmation(&request.kind)
        && payload.get("confirmed").and_then(Value::as_bool) != Some(true)
    {
        return Err(AppError::bad_request(
            "operation_confirmation_required",
            "this operation requires explicit confirmation",
        ));
    }
    if request.kind == "ssh.test_connection"
        && payload.get("acceptNewHostKey").and_then(Value::as_bool) == Some(true)
        && payload.get("confirmed").and_then(Value::as_bool) != Some(true)
    {
        return Err(AppError::bad_request(
            "operation_confirmation_required",
            "accepting a new SSH host key requires explicit confirmation",
        ));
    }
    Ok(())
}

fn operation_capability(kind: &str) -> &'static str {
    match kind.split_once('.').map(|(prefix, _)| prefix) {
        Some("conversation") => "conversation",
        Some("ssh") => "ssh.management",
        Some("file") => "file.management",
        Some("git") => "git.management",
        Some("worktree") => "worktree.management",
        Some("hook") => "hook.management",
        _ => "unsupported",
    }
}

fn operation_requires_confirmation(kind: &str) -> bool {
    CONFIRMED_OPERATION_KINDS.contains(&kind)
}

fn operation_matches_request(operation: &OperationView, request: &CreateOperationRequest) -> bool {
    operation.device_id == request.device_id
        && operation.kind == request.kind
        && operation.payload == request.payload
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: &str, payload: Value) -> CreateOperationRequest {
        CreateOperationRequest {
            device_id: "device-1".to_string(),
            kind: kind.to_string(),
            idempotency_key: "request-1".to_string(),
            payload,
        }
    }

    #[test]
    fn operation_validation_rejects_unsupported_kinds() {
        let error = validate_operation_request(&request(
            "shell.execute",
            serde_json::json!({ "prompt": "hello" }),
        ));
        assert!(error.is_err());
    }

    #[test]
    fn operation_validation_requires_prompt_text() {
        let error = validate_operation_request(&request(
            "conversation.start",
            serde_json::json!({ "prompt": "  " }),
        ));
        assert!(error.is_err());
    }

    #[test]
    fn management_operation_requires_explicit_confirmation() {
        assert!(validate_operation_request(&request(
            "file.delete",
            serde_json::json!({ "projectKey": "p", "cwd": "C:/repo", "path": "a.txt" }),
        ))
        .is_err());
        assert!(validate_operation_request(&request(
            "file.delete",
            serde_json::json!({ "projectKey": "p", "cwd": "C:/repo", "path": "a.txt", "confirmed": true }),
        ))
        .is_ok());
    }

    #[test]
    fn management_read_operation_does_not_require_confirmation() {
        assert!(validate_operation_request(&request(
            "git.status",
            serde_json::json!({ "projectKey": "p", "cwd": "C:/repo" }),
        ))
        .is_ok());
        assert_eq!(operation_capability("hook.status"), "hook.management");
    }

    #[test]
    fn git_fetch_requires_explicit_confirmation() {
        assert!(validate_operation_request(&request(
            "git.fetch",
            serde_json::json!({ "projectKey": "p", "cwd": "C:/repo" }),
        ))
        .is_err());
        assert!(validate_operation_request(&request(
            "git.fetch",
            serde_json::json!({ "projectKey": "p", "cwd": "C:/repo", "confirmed": true }),
        ))
        .is_ok());
    }
}
