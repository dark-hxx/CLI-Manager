pub mod api;
pub mod auth;
pub mod config;
pub mod conversations;
pub mod error;
pub mod mobile;
pub mod registry;
pub mod state;
pub mod storage;
pub mod ws;

use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::routing::{delete, get, post};
use axum::Router;
use state::AppState;
use std::future::{Future, IntoFuture};
use std::time::Duration;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

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
        .route("/devices/{device_id}", delete(api::remove_device))
        .route(
            "/devices/{device_id}/wallpaper",
            get(api::get_device_wallpaper),
        )
        .route("/pairing/claim", post(api::claim_pairing))
        .route("/history", get(api::list_history))
        .route("/conversations", get(conversations::list))
        .route("/conversations/{session_id}", get(conversations::detail))
        .route("/mobile/tickets", post(mobile::create_ticket))
        .route("/mobile/tickets/{device_id}", delete(mobile::stop_ticket))
        .route("/mobile/device-ticket", post(mobile::device_ticket))
        .route(
            "/mobile/device-ticket/revoke",
            post(mobile::stop_device_ticket),
        )
        .route("/mobile/redeem", post(mobile::redeem))
        .route("/mobile/sessions", get(mobile::list_sessions))
        .route("/mobile/sessions/{id}", delete(mobile::revoke))
        .route("/operations", post(api::create_operation))
        .route("/operations/{operation_id}", get(api::get_operation))
        .fallback(api::not_found)
        .layer(axum::middleware::from_fn_with_state(state.clone(), check_api_origin));

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
                .allow_methods([Method::GET, Method::POST, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE]),
        );
    }
    Ok(router)
}

async fn check_api_origin(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, error::AppError> {
    // Native device clients have no Origin; browser requests must match the
    // configured public origin. CORS alone does not prevent request execution.
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let host = request.headers().get(header::HOST).and_then(|value| value.to_str().ok());
        if !origin.to_str().is_ok_and(|origin| state.config.allows_browser_origin(origin, host)) {
            return Err(error::AppError::forbidden("origin_forbidden", "request origin is not allowed"));
        }
    } else if !matches!(*request.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && auth::cookie_value(request.headers()).is_some() {
        return Err(error::AppError::forbidden("origin_required", "Origin header is required for browser changes"));
    }
    Ok(next.run(request).await)
}

/// Run the standalone service with a caller-provided shutdown future.
/// The desktop application uses this to host the same server in a managed
/// background thread without requiring a visible console or a separate CLI.
pub async fn run_with_shutdown<F>(config: config::Config, shutdown: F) -> Result<(), String>
where
    F: Future<Output = ()> + Send + 'static,
{
    run_with_shutdown_ready(config, shutdown, None).await
}

pub async fn run_with_shutdown_ready<F>(
    mut config: config::Config,
    shutdown: F,
    ready: Option<std::sync::mpsc::SyncSender<Result<(), String>>>,
) -> Result<(), String>
where
    F: Future<Output = ()> + Send + 'static,
{
    let bind = config.bind;
    let startup = async {
        config.validate_network()?;
        // Reserve the configured port before touching shared state. A second
        // managed instance then fails without marking devices offline or
        // opening another SQLite pool.
        let listener = tokio::net::TcpListener::bind(bind)
            .await
            .map_err(|error| format!("bind Web server listener failed on {bind}: {error}"))?;
        // A specific VPN/LAN bind excludes loopback. Reserve both before opening
        // storage so a failed local bind cannot disturb another server instance.
        let local_listener = if !bind.ip().is_loopback() && !bind.ip().is_unspecified() {
            let local = std::net::SocketAddr::from(([127, 0, 0, 1], listener.local_addr()
                .map_err(|error| error.to_string())?.port()));
            Some(tokio::net::TcpListener::bind(local).await
                .map_err(|error| format!("bind local device listener failed on {local}: {error}"))?)
        } else {
            None
        };
        let admin_password = config.admin_password.clone();
        let password_hash =
            tokio::task::spawn_blocking(move || auth::hash_password(&admin_password))
                .await
                .map_err(|error| format!("hash admin password failed: {error}"))?
                .map_err(|error| error.to_string())?;
        let storage = storage::Storage::open(&config.database_path)
            .await
            .map_err(|error| error.to_string())?;
        storage
            .ensure_single_user(&config.admin_username, &password_hash)
            .await
            .map_err(|error| error.to_string())?;
        storage
            .mark_all_devices_offline()
            .await
            .map_err(|error| error.to_string())?;

        let state = AppState::new(config, storage);
        let router = build_router(state.clone())?;
        Ok::<_, String>((listener, local_listener, router, state))
    }
    .await;
    let (listener, local_listener, router, state) = match startup {
        Ok(value) => value,
        Err(error) => {
            if let Some(sender) = ready {
                let _ = sender.send(Err(error.clone()));
            }
            return Err(error);
        }
    };
    tracing::info!(%bind, "CLI-Manager Web server listening");
    if let Some(sender) = ready {
        let _ = sender.send(Ok(()));
    }
    let mut main_stop = state.shutdown.subscribe();
    let mut local_stop = state.shutdown.subscribe();
    let main_server = axum::serve(listener, router.clone())
        .with_graceful_shutdown(async move { let _ = main_stop.wait_for(|stop| *stop).await; })
        .into_future();
    let local_server = async move {
        if let Some(listener) = local_listener {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { let _ = local_stop.wait_for(|stop| *stop).await; })
                .await
        } else {
            Ok(())
        }
    };
    let server = async { tokio::try_join!(main_server, local_server).map(|_| ()) };
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => {
            state.shutdown.send_replace(true);
            result.map_err(|error| format!("Web server stopped with error: {error}"))
        }
        _ = shutdown => {
            // Upgrade handlers and both listeners share the same cancellation.
            state.shutdown.send_replace(true);
            match tokio::time::timeout(GRACEFUL_SHUTDOWN_TIMEOUT, &mut server).await {
                Ok(result) => result.map_err(|error| format!("Web server stopped with error: {error}")),
                Err(_) => {
                    tracing::info!("Web server graceful shutdown timed out after signaling socket cancellation");
                    Ok(())
                }
            }
        }
    }
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
    async fn configured_origin_rejects_spoofed_forwarding_headers() {
        let storage = Storage::open_memory().await.unwrap();
        let mut config = Config::test("unused.db".into());
        config.allowed_origin = Some("https://cli.example.com".into());
        config.validate_network().unwrap();
        let router = build_router(AppState::new(config, storage)).unwrap();
        for (origin, expected) in [
            ("https://cli.example.com", StatusCode::OK),
            ("http://cli.example.com", StatusCode::FORBIDDEN),
            ("https://evil.example", StatusCode::FORBIDDEN),
        ] {
            let response = router.clone().oneshot(Request::builder()
                .uri("/api/health")
                .header("host", "127.0.0.1:9090")
                .header("origin", origin)
                .header("x-forwarded-proto", "https")
                .header("x-forwarded-host", "cli.example.com")
                .body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn cookie_mutation_needs_origin_but_native_ticket_uses_device_auth() {
        let router = test_router().await;
        let response = router.clone().oneshot(Request::builder()
            .method(Method::POST).uri("/api/auth/logout")
            .header(header::COOKIE, "cli_manager_session=token")
            .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = router.oneshot(Request::builder()
            .method(Method::POST).uri("/api/mobile/device-ticket")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, "Bearer invalid")
            .body(Body::from(r#"{"deviceId":"device"}"#)).unwrap()).await.unwrap();
        // Reaches device authentication, not blocked by browser Origin rules.
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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

    #[tokio::test]
    async fn shutdown_releases_listener_and_database_with_an_active_connection() {
        let probe = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let bind = probe.local_addr().unwrap();
        drop(probe);
        let database_path = std::env::temp_dir().join(format!(
            "cli-manager-web-restart-{}.db",
            uuid::Uuid::new_v4()
        ));
        let mut config = Config::test(database_path.clone());
        config.bind = bind;
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(run_with_shutdown(config, async move {
            let _ = shutdown_rx.await;
        }));

        let active_connection = loop {
            match std::net::TcpStream::connect_timeout(&bind, Duration::from_millis(100)) {
                Ok(stream) => break stream,
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        shutdown_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(4), server)
            .await
            .expect("managed shutdown must not wait forever for active connections")
            .unwrap()
            .unwrap();
        drop(active_connection);

        let rebound = std::net::TcpListener::bind(bind).unwrap();
        drop(rebound);
        let reopened = Storage::open(&database_path).await.unwrap();
        reopened.pool().close().await;
        for path in [
            database_path.clone(),
            database_path.with_extension("db-wal"),
            database_path.with_extension("db-shm"),
        ] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[tokio::test]
    async fn startup_reports_bind_failure_before_touching_database() {
        let occupied = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let bind = occupied.local_addr().unwrap();
        let database_path = std::env::temp_dir().join(format!(
            "cli-manager-web-bind-failure-{}.db",
            uuid::Uuid::new_v4()
        ));
        let mut config = Config::test(database_path.clone());
        config.bind = bind;
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let result = run_with_shutdown_ready(config, std::future::pending(), Some(ready_tx)).await;
        assert!(result.is_err());
        assert!(ready_rx.recv().unwrap().is_err());
        assert!(!database_path.exists());
    }

    #[tokio::test]
    async fn specific_network_bind_serves_loopback_and_releases_both_listeners() {
        // A UDP route lookup sends no packets. Machines without an IPv4 route
        // cannot exercise a specific LAN bind and retain pure config coverage.
        let probe = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        if probe.connect("192.0.2.1:9").is_err() { return; }
        let ip = probe.local_addr().unwrap().ip();
        if ip.is_loopback() || ip.is_unspecified() { return; }
        let port_probe = std::net::TcpListener::bind((ip, 0)).unwrap();
        let bind = port_probe.local_addr().unwrap();
        drop(port_probe);
        let mut config = Config::test(std::env::temp_dir().join(format!("web-dual-{}.db", uuid::Uuid::new_v4())));
        config.bind = bind;
        config.trusted_network = true;
        config.allowed_origin = Some(format!("http://{bind}"));
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let server = tokio::spawn(run_with_shutdown_ready(config, async { let _ = stop_rx.await; }, Some(ready_tx)));
        tokio::task::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(30)).unwrap().unwrap()).await.unwrap();
        let local = std::net::SocketAddr::from(([127, 0, 0, 1], bind.port()));
        for address in [bind, local] {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
            let mut response = Vec::new();
            tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await.unwrap().unwrap();
            assert!(response.starts_with(b"HTTP/1.1 200"));
        }
        stop_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(4), server).await.unwrap().unwrap().unwrap();
        for address in [bind, local] {
            let rebound = std::net::TcpListener::bind(address).unwrap();
            drop(rebound);
        }
    }
}
