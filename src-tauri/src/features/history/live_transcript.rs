//! Live Web reads never materialize HistorySessionDetail or hold the history catalog lock.
use super::live_transcript_reader::{Reader, Stamp, TranscriptPage};
use super::scope::history_source_base;
use super::{collect_session_files, history_roots, path_within_history_scope, HistoryRoots};
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
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

// Codex 精确文件名查找绕过目录缓存及其他日志正文，缺失或歧义仍返回不可读。
fn locate(roots: &HistoryRoots, request: &TranscriptRequest) -> Result<(PathBuf, PathBuf), String> {
    let root = history_source_base(&request.source, roots)?;
    let base = root
        .canonicalize()
        .map_err(|_| "history_source_not_found")?;
    let candidates: Vec<PathBuf> = if request.source == "codex" {
        // Keep the original UNC root so WSL still resolves through guest find.
        super::codex_lookup::rollout_candidates(&root, &request.cli_session_id)
    } else {
        let filename = format!("{}.jsonl", request.cli_session_id);
        let matches = |file: &super::SessionFileRef| {
            file.source == request.source
                && file.path.file_name().and_then(|s| s.to_str()) == Some(filename.as_str())
        };
        let mut files: Vec<_> = collect_session_files(Some(&request.source), roots)
            .into_iter()
            .filter(matches)
            .collect();
        if files.is_empty() {
            files = super::discovery::collect_session_files_with_force(
                Some(&request.source),
                roots,
                true,
            )
            .into_iter()
            .filter(matches)
            .collect();
        }
        files.into_iter().map(|file| file.path).collect()
    };
    // Ambiguous IDs must not silently choose a different transcript.
    if candidates.len() != 1 {
        return Err("session_file_not_found".into());
    }
    let path = checked_path(&candidates[0], &base)?;
    Ok((path, base))
}

fn watch(key: String, entry: &Arc<Entry>, changed: impl Fn() + Send + 'static) {
    let weak = Arc::downgrade(entry);
    let path = entry.path.clone();
    std::thread::spawn(move || {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let mut watcher = notify::recommended_watcher(move |_: notify::Result<notify::Event>| {
            let _ = send.try_send(());
        })
        .ok();
        // Parent watch survives atomic file replacement. Metadata fallback also works on WSL.
        if let (Some(watcher), Some(parent)) = (watcher.as_mut(), path.parent()) {
            let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
        }
        let mut previous = std::fs::metadata(&path).ok().map(|m| Stamp::from(&m));
        loop {
            if matches!(
                receive.recv_timeout(Duration::from_millis(1000)),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            ) {
                std::thread::sleep(Duration::from_millis(900));
            }
            std::thread::sleep(Duration::from_millis(100));
            while receive.try_recv().is_ok() {}
            let Some(entry) = weak.upgrade() else {
                break;
            };
            if now().saturating_sub(entry.touched.load(Ordering::Relaxed)) > LEASE_MS {
                if let Ok(mut entries) = ENTRIES.get_or_init(Default::default).lock() {
                    if entries
                        .get(&key)
                        .is_some_and(|current| Arc::ptr_eq(current, &entry))
                    {
                        entries.remove(&key);
                    }
                }
                break;
            }
            let current = std::fs::metadata(&path).ok().map(|m| Stamp::from(&m));
            if current != previous {
                previous = current;
                // Hints contain no text/path and never masquerade as PTY output frames.
                changed();
            }
        }
    });
}

// 旧读取失败或文件消失时，仅移除同一个条目，保留并发请求刚建立的替代定位器。
fn evict_entry(key: &str, entry: &Arc<Entry>) -> Result<(), String> {
    let mut entries = ENTRIES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "transcript_cache_poisoned")?;
    if entries
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, entry))
    {
        entries.remove(key);
    }
    Ok(())
}

// 文件已消失的定位器不能持续续租；条件删除避免清掉另一读请求刚建立的新条目。
fn cached_entry(key: &str) -> Result<Option<Arc<Entry>>, String> {
    let entries = ENTRIES.get_or_init(Default::default);
    let cached = entries
        .lock()
        .map_err(|_| "transcript_cache_poisoned")?
        .get(key)
        .cloned();
    if let Some(entry) = &cached {
        // Metadata I/O stays outside the cache lock, including WSL paths.
        if !entry.path.is_file() {
            evict_entry(key, entry)?;
            return Ok(None);
        }
    }
    Ok(cached)
}

// 按精确身份及来源根隔离缓存，读取后保留 cwd 校验及既有分页预算。
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
    let cached = cached_entry(&key)?;
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
        evict_entry(&key, &entry)?;
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

    // 精确 Codex 日志使用独立临时来源，避免测试污染真实目录及其他缓存键。
    fn codex_fixture() -> (tempfile::TempDir, HistoryRoots, TranscriptRequest, PathBuf) {
        let temp = tempfile::TempDir::new().unwrap();
        let config = temp.path().join("codex");
        let directory = config.join("sessions/2026/11/15");
        std::fs::create_dir_all(&directory).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let path = directory.join(format!("rollout-original-{id}.jsonl"));
        let request = TranscriptRequest {
            session_id: "pty-fixture".into(),
            cli_session_id: id.clone(),
            source: "codex".into(),
            cwd: "C:/fixture".into(),
            claude_config_dir: None,
            codex_config_dir: Some(config.to_string_lossy().into()),
            before: None,
            include_details: Some(true),
            revision: None,
        };
        let rows = [
            serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":request.cwd}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant",
                "content":[{"type":"output_text","text":"Exact reply"}]}}),
        ];
        std::fs::write(&path, rows.map(|row| format!("{row}\n")).concat()).unwrap();
        let roots = history_roots(None, request.codex_config_dir.clone(), None);
        (temp, roots, request, path)
    }

    // 目录缓存还指向旧文件时，同 UUID 的当前日志仍必须可读。
    #[test]
    fn live_transcript_codex_locator_ignores_stale_catalog_after_rollout_moves() {
        let (_temp, roots, request, path) = codex_fixture();
        let cached = collect_session_files(Some("codex"), &roots);
        assert_eq!(cached.len(), 1);
        let moved = path.with_file_name(format!("rollout-moved-{}.jsonl", request.cli_session_id));
        std::fs::rename(&path, &moved).unwrap();
        assert_eq!(collect_session_files(Some("codex"), &roots)[0].path, path);
        let (located, _) = locate(&roots, &request)
            .expect("stale inventory must not block the current exact rollout");
        assert_eq!(located, moved.canonicalize().unwrap());
        let mut reader = Reader::new(&request.cli_session_id, &request.cwd);
        reader.update(&located, None).unwrap();
        assert_eq!(
            reader.page(None, true, None).messages[0].text,
            "Exact reply"
        );
    }

    // 有可见页面持续续租时，消失的缓存路径也应被移除并重新定位。
    #[test]
    fn live_transcript_missing_cached_locator_is_evicted_before_relocation() {
        let (_temp, roots, request, path) = codex_fixture();
        let key = format!("test-codex-{}", request.cli_session_id);
        let entry = Arc::new(Entry {
            path: path.canonicalize().unwrap(),
            base: path.parent().unwrap().canonicalize().unwrap(),
            reader: Mutex::new(Reader::new(&request.cli_session_id, &request.cwd)),
            touched: AtomicU64::new(now()),
        });
        ENTRIES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(key.clone(), entry.clone());
        assert!(Arc::ptr_eq(&cached_entry(&key).unwrap().unwrap(), &entry));
        let moved = path.with_file_name(format!("rollout-moved-{}.jsonl", request.cli_session_id));
        std::fs::rename(&path, &moved).unwrap();
        assert!(cached_entry(&key).unwrap().is_none());
        assert!(!ENTRIES.get().unwrap().lock().unwrap().contains_key(&key));
        assert_eq!(
            locate(&roots, &request).unwrap().0,
            moved.canonicalize().unwrap()
        );
    }

    // 在途旧请求失败时，不应移除另一个请求已经替换的缓存。
    #[test]
    fn live_transcript_stale_locator_does_not_evict_concurrent_replacement() {
        let (_temp, _roots, request, path) = codex_fixture();
        let key = format!("test-replacement-{}", request.cli_session_id);
        let entry = || {
            Arc::new(Entry {
                path: path.clone(),
                base: path.parent().unwrap().to_path_buf(),
                reader: Mutex::new(Reader::new(&request.cli_session_id, &request.cwd)),
                touched: AtomicU64::new(now()),
            })
        };
        let old = entry();
        let replacement = entry();
        ENTRIES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(key.clone(), replacement.clone());
        evict_entry(&key, &old).unwrap();
        assert!(Arc::ptr_eq(
            &cached_entry(&key).unwrap().unwrap(),
            &replacement
        ));
        evict_entry(&key, &replacement).unwrap();
        assert!(cached_entry(&key).unwrap().is_none());
    }

    // 文件名只缩小定位范围，Reader 仍验证日志正文中的 UUID 和 cwd。
    #[test]
    fn live_transcript_codex_exact_filename_does_not_bypass_identity_or_project() {
        for wrong_identity in [true, false] {
            let (_temp, roots, request, path) = codex_fixture();
            let rows = [
                serde_json::json!({"type":"session_meta","payload":{
                    "id": if wrong_identity { "12345678-1234-4234-8234-123456789012" } else { &request.cli_session_id },
                    "cwd": if wrong_identity { &request.cwd } else { "C:/another-project" }}}),
                serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant",
                    "content":[{"type":"output_text","text":"Must not leak"}]}}),
            ];
            std::fs::write(&path, rows.map(|row| format!("{row}\n")).concat()).unwrap();
            let located = locate(&roots, &request).unwrap().0;
            let mut reader = Reader::new(&request.cli_session_id, &request.cwd);
            reader.update(&located, None).unwrap();
            let page = reader.page(None, true, None);
            assert!(!page.available);
            assert!(page.messages.is_empty());
        }
    }

    // 冷读取不建立全局目录缓存；后续出现的歧义也不能被旧快照掩盖。
    #[test]
    fn live_transcript_codex_locator_is_independent_of_catalog_and_rejects_new_duplicates() {
        let (_temp, roots, request, path) = codex_fixture();
        let cache_key = format!("codex|{}", roots.cache_key());
        assert!(!super::super::get_files_cache()
            .lock()
            .unwrap()
            .by_source
            .contains_key(&cache_key));
        assert_eq!(
            locate(&roots, &request).unwrap().0,
            path.canonicalize().unwrap()
        );
        assert!(!super::super::get_files_cache()
            .lock()
            .unwrap()
            .by_source
            .contains_key(&cache_key));
        let copy = path.with_file_name(format!("rollout-copy-{}.jsonl", request.cli_session_id));
        std::fs::copy(&path, &copy).unwrap();
        assert!(
            locate(&roots, &request).is_err(),
            "duplicate exact IDs must not choose one file"
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&copy).unwrap();
        std::fs::write(path.with_file_name("rollout-neighbor.jsonl"), "neighbor").unwrap();
        assert!(
            locate(&roots, &request).is_err(),
            "missing IDs must not borrow a neighbor"
        );
    }

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
