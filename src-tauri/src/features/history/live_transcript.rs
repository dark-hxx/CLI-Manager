//! Live Web reads never materialize HistorySessionDetail or hold the history catalog lock.
use super::live_transcript_reader::{Reader, TranscriptPage};
use super::scope::history_source_base;
use super::{collect_session_files, history_roots, path_within_history_scope, HistoryRoots};
use cli_manager_history_core::TranscriptWatcher;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock, Weak,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const MAX_ENTRIES: usize = 4;
const LEASE_MS: u64 = 12_000;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRequest {
    pub session_id: String,
    pub cli_session_id: String,
    pub source: String,
    pub cwd: String,
    pub claude_config_dir: Option<String>,
    pub codex_config_dir: Option<String>,
    pub before: Option<usize>,
    pub include_details: Option<bool>,
    pub revision: Option<String>,
}

struct Entry {
    path: PathBuf,
    base: PathBuf,
    reader: Mutex<Reader>,
    touched: AtomicU64,
}
type Entries = Mutex<HashMap<String, Arc<Entry>>>;
static ENTRIES: OnceLock<Entries> = OnceLock::new();
static READ_LANES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
type TranscriptCallback = Arc<dyn Fn() + Send + Sync + 'static>;

struct WatchRequest {
    key: String,
    path: PathBuf,
    entry: Weak<Entry>,
    callback: TranscriptCallback,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn checked_path(path: &Path, base: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|_| "session_file_not_found")?;
    let current_base = base
        .canonicalize()
        .map_err(|_| "history_source_not_found")?;
    if !canonical.is_file() || !path_within_history_scope(&canonical, &current_base) {
        return Err("session_file_outside_history_scope".into());
    }
    Ok(canonical)
}

fn locate(roots: &HistoryRoots, request: &TranscriptRequest) -> Result<(PathBuf, PathBuf), String> {
    let base = history_source_base(&request.source, roots)?
        .canonicalize()
        .map_err(|_| "history_source_not_found")?;
    // Enumerate using the existing native / WSL guest boundary; parse only the exact filename.
    let suffix = format!("-{}.jsonl", request.cli_session_id);
    let claude_name = format!("{}.jsonl", request.cli_session_id);
    let matches = |file: &super::SessionFileRef| {
        let name = file
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        file.source == request.source
            && if request.source == "codex" {
                name.starts_with("rollout-") && name.ends_with(&suffix)
            } else {
                name == claude_name
            }
    };
    let mut candidates: Vec<_> = collect_session_files(Some(&request.source), roots)
        .into_iter()
        .filter(matches)
        .collect();
    if candidates.is_empty() {
        candidates =
            super::discovery::collect_session_files_with_force(Some(&request.source), roots, true)
                .into_iter()
                .filter(matches)
                .collect();
    }
    // Ambiguous IDs must not silently choose a different transcript.
    if candidates.len() != 1 {
        return Err("session_file_not_found".into());
    }
    let path = checked_path(&candidates[0].path, &base)?;
    Ok((path, base))
}

fn watch(key: String, entry: &Arc<Entry>, changed: impl Fn() + Send + Sync + 'static) {
    static WATCH_COMMANDS: OnceLock<tokio::sync::mpsc::UnboundedSender<WatchRequest>> =
        OnceLock::new();
    let sender = WATCH_COMMANDS.get_or_init(|| {
        let (sender, mut commands) = tokio::sync::mpsc::unbounded_channel::<WatchRequest>();
        tauri::async_runtime::spawn(async move {
            let Ok(mut watcher) = TranscriptWatcher::new() else {
                return;
            };
            let mut subscriptions: HashMap<PathBuf, Vec<WatchRequest>> = HashMap::new();
            loop {
                tokio::select! {
                    command = commands.recv() => {
                        let Some(command) = command else { break; };
                        let path = command.path.canonicalize().unwrap_or_else(|_| command.path.clone());
                        if watcher.watch_path(&path).is_ok() {
                            subscriptions.entry(path).or_default().push(command);
                        }
                    }
                    batch = watcher.next_changed_paths() => {
                        let Ok(paths) = batch else { break; };
                        for path in paths {
                            if let Some(items) = subscriptions.get(&path) {
                                for item in items {
                                    if let Some(entry) = item.entry.upgrade() {
                                        if now().saturating_sub(entry.touched.load(Ordering::Relaxed)) <= LEASE_MS {
                                            // Hints contain no text/path and never masquerade as PTY output frames.
                                            (item.callback)();
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {
                        let mut expired = Vec::new();
                        subscriptions.retain(|path, items| {
                            items.retain(|item| {
                                let Some(entry) = item.entry.upgrade() else { return false; };
                                let active = now().saturating_sub(entry.touched.load(Ordering::Relaxed)) <= LEASE_MS;
                                if !active {
                                    if let Ok(mut entries) = ENTRIES.get_or_init(Default::default).lock() {
                                        if entries.get(&item.key).is_some_and(|current| Arc::ptr_eq(current, &entry)) {
                                            entries.remove(&item.key);
                                        }
                                    }
                                }
                                active
                            });
                            if items.is_empty() { expired.push(path.clone()); false } else { true }
                        });
                        for path in expired {
                            watcher.unregister_path(path);
                        }
                    }
                }
            }
        });
        sender
    });
    let _ = sender.send(WatchRequest {
        key,
        path: entry.path.clone(),
        entry: Arc::downgrade(entry),
        callback: Arc::new(changed),
    });
}

fn read(app: AppHandle, request: TranscriptRequest) -> Result<TranscriptPage, String> {
    if !matches!(request.source.as_str(), "claude" | "codex")
        || request.session_id.is_empty()
        || request.session_id.len() > 128
        || uuid::Uuid::parse_str(&request.cli_session_id).is_err()
        || request.cwd.is_empty()
        || request.cwd.len() > 4096
        || request.before.is_some_and(|n| n > 10_000_000)
        || request.revision.as_ref().is_some_and(|s| s.len() > 128)
    {
        return Err("invalid_transcript_request".into());
    }
    let roots = history_roots(
        request.claude_config_dir.clone(),
        request.codex_config_dir.clone(),
        None,
    );
    let key = serde_json::to_string(&(
        &request.session_id,
        &request.cli_session_id,
        &request.source,
        &request.cwd,
        roots.cache_key(),
    ))
    .unwrap();
    let cached = ENTRIES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "transcript_cache_poisoned")?
        .get(&key)
        .cloned();
    let entry = if let Some(entry) = cached {
        entry
    } else {
        let (path, base) = locate(&roots, &request)?;
        let entry = Arc::new(Entry {
            path,
            base,
            reader: Mutex::new(Reader::new(&request.cli_session_id, &request.cwd)),
            touched: AtomicU64::new(now()),
        });
        let mut entries = ENTRIES
            .get()
            .unwrap()
            .lock()
            .map_err(|_| "transcript_cache_poisoned")?;
        if let Some(existing) = entries.get(&key) {
            existing.clone()
        } else {
            while entries.len() >= MAX_ENTRIES {
                let oldest = entries
                    .iter()
                    .min_by_key(|(_, e)| e.touched.load(Ordering::Relaxed))
                    .map(|(key, _)| key.clone())
                    .unwrap();
                entries.remove(&oldest);
            }
            entries.insert(key.clone(), entry.clone());
            let session_id = request.session_id;
            watch(key.clone(), &entry, move || {
                let _ = crate::commands::web_device::publish_transcript_change(&app, &session_id);
            });
            entry
        }
    };
    entry.touched.store(now(), Ordering::Relaxed);
    if history_source_base(&request.source, &roots)?
        .canonicalize()
        .map_err(|_| "history_source_not_found")?
        != entry.base
    {
        return Err("history_source_changed".into());
    }
    let path = checked_path(&entry.path, &entry.base)?;
    if path != entry.path {
        return Err("session_file_changed".into());
    }
    let mut reader = entry
        .reader
        .lock()
        .map_err(|_| "transcript_reader_poisoned")?;
    if let Err(error) = reader.update(&path, None) {
        ENTRIES
            .get()
            .unwrap()
            .lock()
            .map_err(|_| "transcript_cache_poisoned")?
            .remove(&key);
        return Err(error);
    }
    let page = if let Some(before) = request.before {
        reader.older(&path, before, request.include_details.unwrap_or(false))?
    } else {
        reader.page(
            None,
            request.include_details.unwrap_or(false),
            request.revision.as_deref(),
        )
    };
    if checked_path(&entry.path, &entry.base)? != path {
        return Err("session_file_changed".into());
    }
    Ok(page)
}

pub async fn history_read_live_transcript(
    app: AppHandle,
    request: TranscriptRequest,
) -> Result<TranscriptPage, String> {
    let permit = READ_LANES.acquire().await.map_err(|e| e.to_string())?;
    let result = tokio::task::spawn_blocking(move || read(app, request))
        .await
        .map_err(|e| e.to_string())?;
    drop(permit);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_transcript_final_disk_write_notifies_without_pty_and_lease_expires() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("log.jsonl");
        std::fs::write(&path, "header\n").unwrap();
        let entry = Arc::new(Entry {
            path,
            base: temp.path().to_path_buf(),
            reader: Mutex::new(Reader::new("id", "cwd")),
            touched: AtomicU64::new(now()),
        });
        let (send, receive) = std::sync::mpsc::channel();
        watch("test-only".into(), &entry, move || {
            let _ = send.send(());
        });
        std::thread::sleep(Duration::from_millis(150));
        std::fs::write(&entry.path, "header\nfinal reply after PTY is idle\n").unwrap();
        receive
            .recv_timeout(Duration::from_secs(3))
            .expect("late log write must notify without PTY bytes");
        assert!(
            receive.recv_timeout(Duration::from_millis(1200)).is_err(),
            "unchanged files do not produce notifications"
        );
        entry.touched.store(now() - LEASE_MS - 1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(1300));
        std::fs::write(&entry.path, "after hidden/detached lease\n").unwrap();
        assert!(receive.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn live_transcript_locator_rejects_neighbor_ambiguous_id_and_outside_root() {
        let temp = tempfile::TempDir::new().unwrap();
        let config = temp.path().join("claude");
        let root = config.join("projects");
        std::fs::create_dir_all(root.join("project")).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let request = TranscriptRequest {
            session_id: "pty".into(),
            cli_session_id: id.clone(),
            source: "claude".into(),
            cwd: "C:/fixture".into(),
            claude_config_dir: Some(config.to_string_lossy().into()),
            codex_config_dir: None,
            before: None,
            include_details: Some(true),
            revision: None,
        };
        let roots = history_roots(request.claude_config_dir.clone(), None, None);
        std::fs::write(root.join("project/neighbor.jsonl"), "neighbor").unwrap();
        assert!(locate(&roots, &request).is_err());
        let path = root.join("project").join(format!("{id}.jsonl"));
        std::fs::write(&path, "header").unwrap();
        assert_eq!(
            locate(&roots, &request).unwrap().0,
            path.canonicalize().unwrap()
        );
        assert!(checked_path(&temp.path().join("outside.jsonl"), &root).is_err());
        std::fs::create_dir_all(root.join("second")).unwrap();
        std::fs::write(root.join("second").join(format!("{id}.jsonl")), "header").unwrap();
        super::super::discovery::collect_session_files_with_force(Some("claude"), &roots, true);
        assert!(
            locate(&roots, &request).is_err(),
            "ambiguous identities must not choose a neighbor"
        );
    }
}
