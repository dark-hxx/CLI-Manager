use crate::{auth, error::AppError, state::AppState, storage::now_ms};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRequest {
    device_id: String,
}

pub async fn create_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<TicketRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = auth::require_full_user(&state, &headers).await?;
    state
        .storage
        .device_for_user(&user.id, &request.device_id)
        .await?
        .ok_or_else(|| AppError::not_found("device_not_found", "device not found"))?;
    issue_ticket(&state, &user.id, &request.device_id).await
}

pub async fn device_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<TicketRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = device_owner(&state, &headers, &request.device_id).await?;
    issue_ticket(&state, &user_id, &request.device_id).await
}

pub async fn stop_device_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<TicketRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = device_owner(&state, &headers, &request.device_id).await?;
    sqlx::query("DELETE FROM mobile_tickets WHERE user_id = ? AND device_id = ?")
        .bind(user_id)
        .bind(request.device_id)
        .execute(state.storage.pool())
        .await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn device_owner(
    state: &AppState,
    headers: &HeaderMap,
    device_id: &str,
) -> Result<String, AppError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() <= 128)
        .ok_or_else(AppError::unauthorized)?;
    if !state
        .storage
        .verify_device_token(device_id, &auth::hash_secret(token))
        .await?
    {
        return Err(AppError::unauthorized());
    }
    state
        .storage
        .device_user_id(device_id)
        .await?
        .ok_or_else(AppError::unauthorized)
}

async fn issue_ticket(
    state: &AppState,
    user_id: &str,
    device_id: &str,
) -> Result<Json<serde_json::Value>, AppError> {
    let token = auth::random_token();
    let expires_at = now_ms() + 120_000;
    let mut tx = state.storage.pool().begin().await?;
    // Refresh also invalidates the previously displayed QR for this desktop.
    sqlx::query(
        "DELETE FROM mobile_tickets WHERE (user_id = ? AND device_id = ?) OR expires_at <= ?",
    )
    .bind(user_id)
    .bind(device_id)
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO mobile_tickets (token_hash, user_id, device_id, expires_at) VALUES (?, ?, ?, ?)")
        .bind(auth::hash_secret(&token)).bind(user_id).bind(device_id).bind(expires_at).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        serde_json::json!({"token":token,"expiresAt":expires_at}),
    ))
}

#[derive(Deserialize)]
pub struct RedeemRequest {
    token: String,
    name: Option<String>,
}

pub async fn stop_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = auth::require_full_user(&state, &headers).await?;
    state
        .storage
        .device_for_user(&user.id, &device_id)
        .await?
        .ok_or_else(|| AppError::not_found("device_not_found", "device not found"))?;
    sqlx::query("DELETE FROM mobile_tickets WHERE user_id = ? AND device_id = ?")
        .bind(user.id)
        .bind(device_id)
        .execute(state.storage.pool())
        .await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

pub async fn redeem(
    State(state): State<AppState>,
    Json(request): Json<RedeemRequest>,
) -> Result<Response, AppError> {
    if request.token.len() > 128 || request.name.as_ref().is_some_and(|s| s.len() > 128) {
        return Err(AppError::bad_request(
            "invalid_mobile_ticket",
            "invalid mobile ticket",
        ));
    }
    let token = auth::random_token();
    let now = now_ms();
    let mut tx = state.storage.pool().begin().await?;
    // DELETE RETURNING makes concurrent and repeated redemption strictly single-use.
    let row = sqlx::query("DELETE FROM mobile_tickets WHERE token_hash = ? AND expires_at > ? AND EXISTS (SELECT 1 FROM devices d WHERE d.id = mobile_tickets.device_id AND d.user_id = mobile_tickets.user_id) RETURNING user_id, device_id")
        .bind(auth::hash_secret(&request.token)).bind(now).fetch_optional(&mut *tx).await?
        .ok_or_else(|| AppError::bad_request("invalid_mobile_ticket", "mobile ticket expired or was already used"))?;
    let user_id: String = row.get("user_id");
    let device_id: String = row.get("device_id");
    sqlx::query("INSERT INTO browser_sessions (token_hash, user_id, created_at, expires_at, device_scope, display_name, last_seen_at, public_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(auth::hash_secret(&token)).bind(&user_id).bind(now).bind(now + auth::SESSION_TTL_MS).bind(&device_id).bind(request.name.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("Mobile browser")).bind(now).bind(Uuid::new_v4().to_string()).execute(&mut *tx).await?;
    tx.commit().await?;
    let user = state
        .storage
        .user_for_session(&auth::hash_secret(&token))
        .await?;
    let mut response = Json(cli_manager_web_protocol::AuthStatusResponse {
        authenticated: true,
        user,
        device_scope: Some(device_id),
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&auth::session_cookie(&token, state.config.cookie_secure))
            .map_err(|e| AppError::Internal(e.to_string()))?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = auth::require_full_user(&state, &headers).await?;
    let rows = sqlx::query("SELECT public_id, device_scope, display_name, created_at, last_seen_at, expires_at FROM browser_sessions WHERE user_id = ? AND device_scope IS NOT NULL AND expires_at > ? ORDER BY created_at DESC")
        .bind(user.id).bind(now_ms()).fetch_all(state.storage.pool()).await?;
    let sessions: Vec<_> = rows.into_iter().map(|row| serde_json::json!({"id":row.get::<String,_>("public_id"),"deviceId":row.get::<String,_>("device_scope"),"name":row.get::<String,_>("display_name"),"createdAt":row.get::<i64,_>("created_at"),"lastSeenAt":row.get::<i64,_>("last_seen_at"),"expiresAt":row.get::<i64,_>("expires_at")})).collect();
    Ok(Json(serde_json::json!({"sessions":sessions})))
}

pub async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = auth::require_full_user(&state, &headers).await?;
    sqlx::query("DELETE FROM browser_sessions WHERE user_id = ? AND public_id = ? AND device_scope IS NOT NULL")
        .bind(user.id).bind(id).execute(state.storage.pool()).await?;
    state.registry.notify_session_revocation();
    Ok(Json(serde_json::json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, storage::Storage};

    #[tokio::test]
    async fn mobile_ticket_is_single_use_scoped_and_revocable() {
        let storage = Storage::open_memory().await.unwrap();
        storage.ensure_single_user("admin", "unused").await.unwrap();
        let user = storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap();
        storage
            .upsert_device_hello("device", "PC", "windows", "1", &[], None, None, None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET user_id = ? WHERE id = 'device'")
            .bind(&user.id)
            .execute(storage.pool())
            .await
            .unwrap();
        storage
            .create_browser_session(
                &auth::hash_secret("admin-token"),
                &user.id,
                now_ms() + auth::SESSION_TTL_MS,
            )
            .await
            .unwrap();
        let state = AppState::new(Config::test("unused".into()), storage);
        let mut admin = HeaderMap::new();
        admin.insert(
            header::COOKIE,
            HeaderValue::from_static("cli_manager_session=admin-token"),
        );
        let ticket = create_ticket(
            State(state.clone()),
            admin.clone(),
            Json(TicketRequest {
                device_id: "device".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        let token = ticket["token"].as_str().unwrap().to_string();
        let response = redeem(
            State(state.clone()),
            Json(RedeemRequest {
                token: token.clone(),
                name: None,
            }),
        )
        .await
        .unwrap();
        assert!(redeem(
            State(state.clone()),
            Json(RedeemRequest { token, name: None })
        )
        .await
        .is_err());
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let mut mobile = HeaderMap::new();
        mobile.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        assert!(auth::require_user(&state, &mobile).await.is_ok());
        assert!(auth::require_device_scope(&state, &mobile, "device")
            .await
            .is_ok());
        assert!(auth::require_device_scope(&state, &mobile, "other")
            .await
            .is_err());
        assert!(auth::require_full_user(&state, &mobile).await.is_err());
        // Exercise the real router: every resource route applies the same device scope.
        use axum::{
            body::Body,
            http::{Method, Request, StatusCode},
        };
        use tower::ServiceExt;
        let router = crate::build_router(state.clone()).unwrap();
        for (method, uri, body) in [
            (Method::GET, "/api/history?deviceId=other", ""),
            (Method::GET, "/api/conversations?deviceId=other", ""),
            (Method::GET, "/api/conversations/session?deviceId=other", ""),
            (Method::GET, "/api/devices/other/wallpaper", ""),
            (Method::DELETE, "/api/devices/device", ""),
            (Method::POST, "/api/pairing/claim", r#"{"code":"ABCDEF"}"#),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header(header::COOKIE, mobile[header::COOKIE].clone())
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
        }
        assert!(create_ticket(
            State(state.clone()),
            mobile.clone(),
            Json(TicketRequest {
                device_id: "device".into()
            })
        )
        .await
        .is_err());
        let sessions = list_sessions(State(state.clone()), admin.clone())
            .await
            .unwrap()
            .0;
        let id = sessions["sessions"][0]["id"].as_str().unwrap().to_string();
        let mut revoked = state.registry.subscribe_session_revocations();
        let _ = revoke(State(state.clone()), admin.clone(), Path(id))
            .await
            .unwrap();
        assert!(revoked.try_recv().is_ok());
        assert!(auth::require_user(&state, &mobile).await.is_err());
        let ticket = create_ticket(
            State(state.clone()),
            admin,
            Json(TicketRequest {
                device_id: "device".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        sqlx::query("UPDATE mobile_tickets SET expires_at = 0")
            .execute(state.storage.pool())
            .await
            .unwrap();
        assert!(redeem(
            State(state),
            Json(RedeemRequest {
                token: ticket["token"].as_str().unwrap().into(),
                name: None
            })
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn device_ticket_rejects_wrong_token_or_identity() {
        let storage = Storage::open_memory().await.unwrap();
        storage.ensure_single_user("admin", "unused").await.unwrap();
        let user = storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap();
        storage
            .upsert_device_hello("device", "PC", "windows", "1", &[], None, None, None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET user_id = ?, device_token_hash = ? WHERE id = 'device'")
            .bind(user.id)
            .bind(auth::hash_secret("correct-token"))
            .execute(storage.pool())
            .await
            .unwrap();
        let state = AppState::new(Config::test("unused".into()), storage);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wrong-token"),
        );
        assert!(device_ticket(
            State(state.clone()),
            headers.clone(),
            Json(TicketRequest {
                device_id: "device".into()
            })
        )
        .await
        .is_err());
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer correct-token"),
        );
        assert!(device_ticket(
            State(state.clone()),
            headers.clone(),
            Json(TicketRequest {
                device_id: "other-device".into()
            })
        )
        .await
        .is_err());
        assert!(device_ticket(
            State(state),
            headers,
            Json(TicketRequest {
                device_id: "device".into()
            })
        )
        .await
        .is_ok());
    }
}
