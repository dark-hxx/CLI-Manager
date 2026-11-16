use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use cli_manager_web_server::{build_router, config::Config, state::AppState, storage::Storage};
use tower::ServiceExt;

#[tokio::test]
async fn optional_tap_spa_and_assets_do_not_fall_back_to_classic_web() {
    let root =
        std::env::temp_dir().join(format!("cli-manager-tap-static-{}", uuid::Uuid::new_v4()));
    let dist = root.join("dist");
    std::fs::create_dir_all(dist.join("tap/assets")).unwrap();
    std::fs::write(dist.join("index.html"), "classic-shell").unwrap();
    std::fs::write(dist.join("tap/index.html"), "tap-shell").unwrap();
    std::fs::write(dist.join("tap/assets/app.js"), "tap-script").unwrap();
    let config = Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        database_path: root.join("db.sqlite"),
        web_dist: dist,
        admin_username: "admin".into(),
        admin_password: "test-only".into(),
        sync_admin_credentials: false,
        cookie_secure: false,
        trusted_network: false,
        allowed_origin: None,
    };
    let storage = Storage::open(&config.database_path).await.unwrap();
    let router = build_router(AppState::new(config, storage.clone())).unwrap();
    for (path, status, text) in [
        ("/", StatusCode::OK, "classic-shell"),
        ("/tap/", StatusCode::OK, "tap-shell"),
        ("/tap/s/session-a", StatusCode::OK, "tap-shell"),
        ("/tap/assets/app.js", StatusCode::OK, "tap-script"),
        ("/tap/assets/missing.js", StatusCode::NOT_FOUND, ""),
    ] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(std::str::from_utf8(&body).unwrap(), text, "{path}");
    }
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/does-not-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    storage.pool().close().await;
    // root was created for this test only, with a fresh UUID, never a caller-supplied path.
    std::fs::remove_dir_all(&root).unwrap();
}
