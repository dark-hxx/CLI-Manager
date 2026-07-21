pub mod api;
pub mod auth;
pub mod config;
pub mod error;
pub mod registry;
pub mod state;
pub mod storage;
pub mod ws;

use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use state::AppState;
use std::time::Duration;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

pub fn build_router(state: AppState) -> Result<Router, String> {
    let web_dist = state.config.web_dist.clone();
    let static_files = ServeDir::new(&web_dist)
        .append_index_html_on_directories(true)
        .not_found_service(ServeFile::new(web_dist.join("index.html")));

    let api_router = Router::new()
        .route("/health", get(api::health))
        .route("/auth/status", get(api::auth_status))
        .route("/auth/login", post(api::login))
        .route("/auth/logout", post(api::logout))
        .route("/devices", get(api::list_devices))
        .route(
            "/devices/{device_id}/wallpaper",
            get(api::get_device_wallpaper),
        )
        .route("/pairing/claim", post(api::claim_pairing))
        .route("/history", get(api::list_history))
        .route("/operations", post(api::create_operation))
        .route("/operations/{operation_id}", get(api::get_operation))
        .fallback(api::not_found);

    let mut router = Router::new()
        .nest("/api", api_router)
        .route("/ws/browser", get(ws::browser_socket))
        .route("/ws/device", get(ws::device_socket))
        .fallback_service(static_files)
        .with_state(state.clone())
        .layer(RequestBodyLimitLayer::new(MAX_HTTP_BODY_BYTES))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            HTTP_TIMEOUT,
        ))
        .layer(TraceLayer::new_for_http());

    if let Some(origin) = state.config.allowed_origin.as_deref() {
        let origin = HeaderValue::from_str(origin)
            .map_err(|error| format!("invalid CLI_MANAGER_WEB_ALLOWED_ORIGIN: {error}"))?;
        router = router.layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_credentials(true)
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([header::CONTENT_TYPE]),
        );
    }
    Ok(router)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::storage::Storage;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn test_router() -> Router {
        let storage = Storage::open_memory().await.unwrap();
        storage
            .ensure_single_user("admin", "unused-password-hash")
            .await
            .unwrap();
        build_router(AppState::new(Config::test("unused.db".into()), storage)).unwrap()
    }

    #[tokio::test]
    async fn health_route_is_available() {
        let response = test_router()
            .await
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn unknown_api_route_does_not_fall_back_to_spa() {
        let response = test_router()
            .await
            .oneshot(
                Request::builder()
                    .uri("/api/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
    }

    #[tokio::test]
    async fn protected_route_requires_session_cookie() {
        let response = test_router()
            .await
            .oneshot(
                Request::builder()
                    .uri("/api/devices")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
