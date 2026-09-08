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
    // 发送关闭信号并中止 HTTP 任务，字段释放同时结束文件监听。
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
    // 创建没有活动项目会话的 Live Server 管理器。
    pub fn new() -> Self {
        Self::default()
    }

    // 校验项目和 HTML 入口，清理已结束任务并复用或创建项目静态服务。
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

    // 按规范化项目键查询会话，同时清理已结束的服务任务。
    pub fn status(&self, project_path: String) -> Result<Option<LiveServerSession>, String> {
        let key = registry_key(&project_path)?;
        let mut servers = self.lock_servers()?;
        prune_finished(&mut servers);
        Ok(servers.get(&key).map(|running| running.session.clone()))
    }

    // 移除指定项目会话，通过析构释放监听及 HTTP 任务。
    pub fn stop(&self, project_path: String) -> Result<bool, String> {
        let key = registry_key(&project_path)?;
        let mut servers = self.lock_servers()?;
        Ok(servers.remove(&key).is_some())
    }

    // 清空全部服务会话，锁中毒时仅记录错误。
    pub fn shutdown(&self) {
        match self.servers.lock() {
            Ok(mut servers) => servers.clear(),
            Err(error) => log::error!("[live_server] shutdown lock poisoned: {error}"),
        }
    }

    // 取得服务注册表锁，将锁中毒转换为稳定错误。
    fn lock_servers(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, RunningLiveServer>>, String> {
        self.servers.lock().map_err(|_| "lock_poisoned".to_string())
    }
}

// 绑定随机回环端口、初始化路径上下文和监听器，再启动异步 HTTP 服务。
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
    let context = LiveServerHttpContext::new(&root, Arc::clone(&version), address.port())?;
    let watcher = LiveReloadWatcher::start(&root, version)?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(http::serve(listener, context, shutdown_rx));

    Ok(RunningLiveServer {
        session,
        shutdown_tx: Some(shutdown_tx),
        task,
        _watcher: watcher,
    })
}

// 根据项目路径和端口生成回环 origin 及会话元数据。
fn make_session(project_path: &str, port: u16) -> LiveServerSession {
    LiveServerSession {
        project_path: project_path.to_string(),
        origin: format!("http://127.0.0.1:{port}"),
        port,
    }
}

// 组合会话、编码后的页面 URL 和是否复用标记。
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

// 移除 HTTP 任务已经结束的注册会话。
fn prune_finished(servers: &mut HashMap<String, RunningLiveServer>) {
    servers.retain(|_, running| !running.task.inner().is_finished());
}

#[cfg(test)]
mod tests;
