use cli_manager_web_protocol::{BrowserSocketFrame, ServerToDeviceFrame};
use std::collections::HashMap;
use tokio::sync::{broadcast, mpsc, watch, RwLock};

#[derive(Debug, Clone)]
pub struct BrowserBroadcast {
    pub user_id: String,
    pub frame: BrowserSocketFrame,
}

pub struct ConnectionRegistry {
    devices: RwLock<HashMap<String, DeviceConnection>>,
    browser_events: broadcast::Sender<BrowserBroadcast>,
}

struct DeviceConnection {
    connection_id: String,
    sender: mpsc::Sender<ServerToDeviceFrame>,
    shutdown: watch::Sender<bool>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        let (browser_events, _) = broadcast::channel(256);
        Self {
            devices: RwLock::new(HashMap::new()),
            browser_events,
        }
    }

    pub async fn register_device(
        &self,
        device_id: String,
        connection_id: String,
        sender: mpsc::Sender<ServerToDeviceFrame>,
        shutdown: watch::Sender<bool>,
    ) {
        if let Some(previous) = self.devices.write().await.insert(
            device_id,
            DeviceConnection {
                connection_id,
                sender,
                shutdown,
            },
        ) {
            let _ = previous.shutdown.send(true);
        }
    }

    pub async fn remove_device(&self, device_id: &str, connection_id: &str) -> bool {
        let mut devices = self.devices.write().await;
        if devices
            .get(device_id)
            .is_some_and(|connection| connection.connection_id == connection_id)
        {
            devices.remove(device_id);
            true
        } else {
            false
        }
    }

    pub async fn is_device_online(&self, device_id: &str) -> bool {
        self.devices.read().await.contains_key(device_id)
    }

    pub async fn is_current_device_connection(&self, device_id: &str, connection_id: &str) -> bool {
        self.devices
            .read()
            .await
            .get(device_id)
            .is_some_and(|connection| connection.connection_id == connection_id)
    }

    pub async fn send_device(&self, device_id: &str, frame: ServerToDeviceFrame) -> bool {
        let connection = self.devices.read().await.get(device_id).map(|connection| {
            (
                connection.connection_id.clone(),
                connection.sender.clone(),
                connection.shutdown.clone(),
            )
        });
        match connection {
            Some((_connection_id, sender, shutdown)) => match sender.try_send(frame) {
                Ok(()) => true,
                Err(_) => {
                    let _ = shutdown.send(true);
                    false
                }
            },
            None => false,
        }
    }

    pub fn subscribe_browser(&self) -> broadcast::Receiver<BrowserBroadcast> {
        self.browser_events.subscribe()
    }

    pub fn broadcast_browser(&self, event: BrowserBroadcast) {
        let _ = self.browser_events.send(event);
    }
}

impl Default for ConnectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn newer_device_connection_replaces_the_old_generation() {
        let registry = ConnectionRegistry::new();
        let (old_sender, _) = mpsc::channel(1);
        let (old_shutdown, mut old_shutdown_rx) = watch::channel(false);
        registry
            .register_device(
                "device-1".to_string(),
                "old".to_string(),
                old_sender,
                old_shutdown,
            )
            .await;
        let (new_sender, _) = mpsc::channel(1);
        let (new_shutdown, _) = watch::channel(false);
        registry
            .register_device(
                "device-1".to_string(),
                "new".to_string(),
                new_sender,
                new_shutdown,
            )
            .await;

        old_shutdown_rx.changed().await.unwrap();
        assert!(*old_shutdown_rx.borrow());
        assert!(
            !registry
                .is_current_device_connection("device-1", "old")
                .await
        );
        assert!(
            registry
                .is_current_device_connection("device-1", "new")
                .await
        );
        assert!(!registry.remove_device("device-1", "old").await);
        assert!(registry.remove_device("device-1", "new").await);
    }
}
