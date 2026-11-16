use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use cli_manager_web_server::{
    auth, build_router, config::Config, state::AppState, storage::Storage,
};
use sqlx::Row;
use std::time::Duration;
use tower::ServiceExt;

async fn test_storage() -> (Storage, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!("web-auth-test-{}.db", uuid::Uuid::new_v4()));
    (Storage::open(&path).await.unwrap(), path)
}

async fn cleanup(storage: Storage, path: std::path::PathBuf) {
    storage.pool().close().await;
    // SQLite worker teardown may briefly retain a handle on Windows.
    for attempt in 0..20 {
        match std::fs::remove_file(&path) {
            Ok(()) => return,
            Err(error) if error.raw_os_error() == Some(32) && attempt < 19 => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => panic!("test database cleanup failed: {error}"),
        }
    }
}

fn config() -> Config {
    Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        database_path: "unused.db".into(),
        web_dist: "missing-dist".into(),
        admin_username: "admin".into(),
        admin_password: "test-initial".into(),
        sync_admin_credentials: true,
        cookie_secure: false,
        trusted_network: false,
        allowed_origin: None,
    }
}

async fn login(storage: &Storage, username: &str, password: &str) -> axum::response::Response {
    build_router(AppState::new(config(), storage.clone()))
        .unwrap()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::HOST, "localhost")
                .header(header::ORIGIN, "http://localhost")
                .body(Body::from(
                    serde_json::json!({ "username": username, "password": password }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn seed_device(storage: &Storage, user_id: &str) {
    storage
        .upsert_device_hello(
            "paired-pc",
            "PC",
            "windows",
            "test",
            &[],
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET user_id = ?1, device_token_hash = ?2 WHERE id = 'paired-pc'")
        .bind(user_id)
        .bind(auth::hash_secret("test-device-token"))
        .execute(storage.pool())
        .await
        .unwrap();
}

#[tokio::test]
async fn managed_password_change_updates_login_and_revokes_sessions_without_unpairing_device() {
    let (storage, path) = test_storage().await;
    storage
        .configure_admin("admin", "test-initial", true)
        .await
        .unwrap();
    let before = storage
        .find_user_by_username("admin")
        .await
        .unwrap()
        .unwrap();
    seed_device(&storage, &before.id).await;
    let response = login(&storage, "admin", "test-initial").await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
    let token = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
    assert!(storage
        .user_for_session(&auth::hash_secret(token))
        .await
        .unwrap()
        .is_some());
    storage
        .create_browser_session("mobile-session", &before.id, i64::MAX)
        .await
        .unwrap();
    sqlx::query("UPDATE browser_sessions SET device_scope = 'paired-pc' WHERE token_hash = 'mobile-session'")
        .execute(storage.pool()).await.unwrap();
    sqlx::query("INSERT INTO mobile_tickets (token_hash, user_id, device_id, expires_at) VALUES ('ticket', ?1, 'paired-pc', ?2)")
        .bind(&before.id).bind(i64::MAX).execute(storage.pool()).await.unwrap();

    storage
        .configure_admin("admin", "test-new-中文-!", true)
        .await
        .unwrap();
    assert_eq!(
        login(&storage, "admin", "test-initial").await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&storage, "admin", "test-new-中文-!").await.status(),
        StatusCode::OK
    );
    assert!(storage
        .user_for_session(&auth::hash_secret(token))
        .await
        .unwrap()
        .is_none());
    assert!(storage
        .user_for_session("mobile-session")
        .await
        .unwrap()
        .is_none());
    let tickets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mobile_tickets")
        .fetch_one(storage.pool())
        .await
        .unwrap();
    assert_eq!(tickets, 0);
    let after = storage
        .find_user_by_username("admin")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.id, before.id);
    let device =
        sqlx::query("SELECT user_id, device_token_hash FROM devices WHERE id = 'paired-pc'")
            .fetch_one(storage.pool())
            .await
            .unwrap();
    assert_eq!(device.get::<String, _>("user_id"), before.id);
    assert_eq!(
        device.get::<String, _>("device_token_hash"),
        auth::hash_secret("test-device-token")
    );
    drop(device);
    cleanup(storage, path).await;
}

#[tokio::test]
async fn unchanged_managed_credentials_preserve_hash_and_sessions_but_rename_revokes_them() {
    let (storage, path) = test_storage().await;
    storage
        .configure_admin("admin", "test-initial", true)
        .await
        .unwrap();
    let original = storage
        .find_user_by_username("admin")
        .await
        .unwrap()
        .unwrap();
    storage
        .create_browser_session("existing", &original.id, i64::MAX)
        .await
        .unwrap();
    storage
        .configure_admin("admin", "test-initial", true)
        .await
        .unwrap();
    assert_eq!(
        storage
            .find_user_by_username("admin")
            .await
            .unwrap()
            .unwrap()
            .password_hash,
        original.password_hash
    );
    assert!(storage
        .user_for_session("existing")
        .await
        .unwrap()
        .is_some());
    storage
        .configure_admin("renamed", "test-initial", true)
        .await
        .unwrap();
    assert!(storage
        .user_for_session("existing")
        .await
        .unwrap()
        .is_none());
    assert!(storage
        .find_user_by_username("admin")
        .await
        .unwrap()
        .is_none());
    let renamed = storage
        .find_user_by_username("renamed")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed.id, original.id);
    assert_eq!(renamed.password_hash, original.password_hash);
    assert_eq!(
        login(&storage, "renamed", "test-initial").await.status(),
        StatusCode::OK
    );
    cleanup(storage, path).await;
}

#[tokio::test]
async fn standalone_bootstrap_does_not_replace_existing_credentials() {
    let (storage, path) = test_storage().await;
    storage
        .configure_admin("admin", "test-initial", false)
        .await
        .unwrap();
    storage
        .configure_admin("other", "test-other", false)
        .await
        .unwrap();
    assert_eq!(
        login(&storage, "admin", "test-initial").await.status(),
        StatusCode::OK
    );
    assert!(storage
        .find_user_by_username("other")
        .await
        .unwrap()
        .is_none());
    assert!(storage
        .configure_admin("admin", &"x".repeat(1025), true)
        .await
        .is_err());
    assert_eq!(
        login(&storage, "admin", "test-initial").await.status(),
        StatusCode::OK
    );
    cleanup(storage, path).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn valid_cookie_reads_do_not_wait_for_a_writer_and_invalid_scopes_still_fail() {
    let path = std::env::temp_dir().join(format!("web-auth-lock-{}.db", uuid::Uuid::new_v4()));
    let storage = Storage::open(&path).await.unwrap();
    storage.ensure_single_user("admin", "unused").await.unwrap();
    let user = storage
        .find_user_by_username("admin")
        .await
        .unwrap()
        .unwrap();
    seed_device(&storage, &user.id).await;
    for token in ["desktop", "mobile", "expired", "orphaned"] {
        storage
            .create_browser_session(
                token,
                &user.id,
                if token == "expired" { 1 } else { i64::MAX },
            )
            .await
            .unwrap();
    }
    sqlx::query(
        "UPDATE browser_sessions SET device_scope = 'paired-pc' WHERE token_hash = 'mobile'",
    )
    .execute(storage.pool())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE browser_sessions SET device_scope = 'not-owned' WHERE token_hash = 'orphaned'",
    )
    .execute(storage.pool())
    .await
    .unwrap();
    let blocker = storage.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    for token in ["desktop", "mobile", "desktop", "mobile"] {
        let user =
            tokio::time::timeout(Duration::from_millis(400), storage.user_for_session(token))
                .await
                .expect("authentication must be read-only under the existing writer")
                .unwrap();
        assert!(user.is_some());
    }
    for token in ["expired", "orphaned", "unknown"] {
        assert!(storage.user_for_session(token).await.unwrap().is_none());
    }
    // A queued cleanup does not hold up the caller either.
    storage.schedule_transcript_prune(chrono::Utc::now().timestamp_millis());
    assert!(storage.user_for_session("desktop").await.unwrap().is_some());
    blocker.rollback().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let seen: Option<i64> = sqlx::query_scalar(
                "SELECT last_seen_at FROM browser_sessions WHERE token_hash = 'mobile'",
            )
            .fetch_one(storage.pool())
            .await
            .unwrap();
            if seen.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let desktop_seen: Option<i64> = sqlx::query_scalar(
        "SELECT last_seen_at FROM browser_sessions WHERE token_hash = 'desktop'",
    )
    .fetch_one(storage.pool())
    .await
    .unwrap();
    assert_eq!(desktop_seen, None);
    cleanup(storage, path).await;
}
