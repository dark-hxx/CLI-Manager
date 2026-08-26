mod http;
mod paths;
mod watcher;

use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tokio::sync::oneshot;

use self::http::LiveServerHttpContext;
use self::paths::{build_page_url, registry_key, validate_start_request};
use self::watcher::LiveReloadWatcher;

const INITIAL_RELOAD_VERSION: u64 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveServerSession {
    pub project_path: String,
    pub origin: String,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveServerOpenResult {
    pub session: LiveServerSession,
    pub url: String,
    pub reused: bool,
}

struct RunningLiveServer {
    session: LiveServerSession,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    _watcher: LiveReloadWatcher,
}

impl Drop for RunningLiveServer {
    fn drop(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        self.task.abort();
    }
}

#[derive(Default)]
pub struct LiveServerManager {
    servers: Mutex<HashMap<String, RunningLiveServer>>,
}

impl LiveServerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(
        &self,
        project_path: String,
        relative_path: String,
    ) -> Result<LiveServerOpenResult, String> {
        let validated = validate_start_request(&project_path, &relative_path)?;
        let mut servers = self.lock_servers()?;
        prune_finished(&mut servers);

        if let Some(running) = servers.get(&validated.registry_key) {
            return Ok(open_result(
                &running.session,
                &validated.relative_path,
                true,
            ));
        }

        let running = start_server(&project_path, validated.root)?;
        let result = open_result(&running.session, &validated.relative_path, false);
        servers.insert(validated.registry_key, running);
        Ok(result)
    }

    pub fn status(&self, project_path: String) -> Result<Option<LiveServerSession>, String> {
        let key = registry_key(&project_path)?;
        let mut servers = self.lock_servers()?;
        prune_finished(&mut servers);
        Ok(servers.get(&key).map(|running| running.session.clone()))
    }

    pub fn stop(&self, project_path: String) -> Result<bool, String> {
        let key = registry_key(&project_path)?;
        let mut servers = self.lock_servers()?;
        Ok(servers.remove(&key).is_some())
    }

    pub fn shutdown(&self) {
        match self.servers.lock() {
            Ok(mut servers) => servers.clear(),
            Err(error) => log::error!("[live_server] shutdown lock poisoned: {error}"),
        }
    }

    fn lock_servers(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, RunningLiveServer>>, String> {
        self.servers.lock().map_err(|_| "lock_poisoned".to_string())
    }
}

fn start_server(project_path: &str, root: std::path::PathBuf) -> Result<RunningLiveServer, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("listener_bind_failed: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("listener_config_failed: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("listener_address_failed: {error}"))?;
    let session = make_session(project_path, address.port());
    let version = Arc::new(AtomicU64::new(INITIAL_RELOAD_VERSION));
    let watcher = LiveReloadWatcher::start(&root, Arc::clone(&version))?;
    let context = LiveServerHttpContext::new(root, version, address.port());
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(http::serve(listener, context, shutdown_rx));

    Ok(RunningLiveServer {
        session,
        shutdown_tx: Some(shutdown_tx),
        task,
        _watcher: watcher,
    })
}

fn make_session(project_path: &str, port: u16) -> LiveServerSession {
    LiveServerSession {
        project_path: project_path.to_string(),
        origin: format!("http://127.0.0.1:{port}"),
        port,
    }
}

fn open_result(
    session: &LiveServerSession,
    relative_path: &str,
    reused: bool,
) -> LiveServerOpenResult {
    LiveServerOpenResult {
        session: session.clone(),
        url: build_page_url(&session.origin, relative_path),
        reused,
    }
}

fn prune_finished(servers: &mut HashMap<String, RunningLiveServer>) {
    servers.retain(|_, running| !running.task.inner().is_finished());
}

#[cfg(test)]
mod tests;
