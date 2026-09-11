use cli_manager_web_server::config::Config;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cli_manager_web_server=info,tower_http=info".into()),
        )
        .init();

    cli_manager_web_server::run_with_shutdown(Config::from_env()?, shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::warn!(%error, "failed to install Ctrl+C handler");
    }
}
