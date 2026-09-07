use cli_manager_web_server::auth::hash_password;
use cli_manager_web_server::config::Config;
use cli_manager_web_server::state::AppState;
use cli_manager_web_server::storage::Storage;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cli_manager_web_server=info,tower_http=info".into()),
        )
        .init();

    let mut config = Config::from_env()?;
    let admin_password = std::mem::take(&mut config.admin_password);
    let password_hash =
        tokio::task::spawn_blocking(move || hash_password(&admin_password)).await??;
    let storage = Storage::open(&config.database_path).await?;
    storage
        .ensure_single_user(&config.admin_username, &password_hash)
        .await?;
    storage.mark_all_devices_offline().await?;

    let bind = config.bind;
    let state = AppState::new(config, storage);
    let router = cli_manager_web_server::build_router(state)?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, "CLI-Manager Web server listening");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::warn!(%error, "failed to install Ctrl+C handler");
    }
}
