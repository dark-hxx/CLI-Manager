use crate::config::Config;
use crate::registry::{BrowserBroadcast, ConnectionRegistry};
use crate::storage::Storage;
use cli_manager_web_protocol::{BrowserEventPayload, BrowserSocketFrame};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub storage: Storage,
    pub registry: Arc<ConnectionRegistry>,
}

impl AppState {
    pub fn new(config: Config, storage: Storage) -> Self {
        Self {
            config: Arc::new(config),
            storage,
            registry: Arc::new(ConnectionRegistry::new()),
        }
    }

    pub async fn publish_event(
        &self,
        user_id: &str,
        payload: BrowserEventPayload,
    ) -> Result<BrowserSocketFrame, crate::error::AppError> {
        let frame = self.storage.append_browser_event(user_id, payload).await?;
        self.registry.broadcast_browser(BrowserBroadcast {
            user_id: user_id.to_string(),
            frame: frame.clone(),
        });
        Ok(frame)
    }
}
