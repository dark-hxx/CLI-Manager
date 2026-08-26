use std::fs;
use std::time::Duration;

use reqwest::header::{ALLOW, HOST};
use tempfile::tempdir;

use super::http::RELOAD_ENDPOINT;
use super::{LiveServerManager, LiveServerOpenResult, LiveServerSession};

const WATCHER_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_DELAY: Duration = Duration::from_millis(50);

async fn reload_version(client: &reqwest::Client, session: &LiveServerSession) -> u64 {
    client
        .get(format!("{}{}", session.origin, RELOAD_ENDPOINT))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
        .parse()
        .unwrap()
}

async fn wait_for_version_change(
    client: &reqwest::Client,
    session: &LiveServerSession,
    initial: u64,
) -> u64 {
    tokio::time::timeout(WATCHER_TIMEOUT, async {
        loop {
            let current = reload_version(client, session).await;
            if current != initial {
                return current;
            }
            tokio::time::sleep(POLL_DELAY).await;
        }
    })
    .await
    .expect("watcher did not advance reload version")
}

async fn assert_listener_closed(port: u16) {
    tokio::time::timeout(WATCHER_TIMEOUT, async {
        loop {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
            {
                return;
            }
            tokio::time::sleep(POLL_DELAY).await;
        }
    })
    .await
    .expect("listener remained reachable after stop");
}

async fn assert_http_contract(client: &reqwest::Client, result: &LiveServerOpenResult) {
    let response = client.get(&result.url).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert!(response
        .text()
        .await
        .unwrap()
        .contains("data-cli-manager-live-server"));

    let invalid_host = client
        .get(&result.url)
        .header(HOST, "example.test")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_host.status(), reqwest::StatusCode::FORBIDDEN);

    let rejected_method = client.post(&result.url).send().await.unwrap();
    assert_eq!(
        rejected_method.status(),
        reqwest::StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(rejected_method.headers()[ALLOW], "GET, HEAD");

    let head = client.head(&result.url).send().await.unwrap();
    assert_eq!(head.status(), reqwest::StatusCode::OK);
    assert!(head.bytes().await.unwrap().is_empty());
}

async fn assert_reload_changes(
    client: &reqwest::Client,
    session: &LiveServerSession,
    root: &std::path::Path,
) {
    let initial = reload_version(client, session).await;
    fs::write(root.join("styles.css"), "body { color: red; }").unwrap();
    let changed = wait_for_version_change(client, session, initial).await;
    assert!(changed > initial);
}

#[tokio::test]
async fn starts_reuses_serves_and_stops_project_server() {
    let temp = tempdir().unwrap();
    fs::write(
        temp.path().join("index.html"),
        "<html><body>ok</body></html>",
    )
    .unwrap();
    let root = temp.path().to_str().unwrap().to_string();
    let manager = LiveServerManager::new();

    let first = manager
        .start(root.clone(), "index.html".to_string())
        .unwrap();
    let second = manager
        .start(root.clone(), "index.html".to_string())
        .unwrap();
    assert!(!first.reused);
    assert!(second.reused);
    assert_eq!(first.session.port, second.session.port);

    let client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();
    assert_http_contract(&client, &first).await;
    assert_reload_changes(&client, &first.session, temp.path()).await;

    assert_eq!(manager.status(root.clone()).unwrap(), Some(first.session));
    let port = second.session.port;
    assert!(manager.stop(root.clone()).unwrap());
    assert_eq!(manager.status(root).unwrap(), None);
    assert_listener_closed(port).await;
}
