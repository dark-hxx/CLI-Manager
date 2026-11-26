//! Disk identity is (selected environment, source root, native conversation id).
//! History browsing includes the legacy brain; a live binding never does.
use super::*;
use percent_encoding::percent_decode_str;
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use url::Url;

const WORKSPACE_CACHE_MAX_ROOTS: usize = 32;

#[derive(Clone)]
struct CachedWorkspaceMap {
    db_fp: SessionFileFingerprint,
    wal_fp: SessionFileFingerprint,
    history_fp: SessionFileFingerprint,
    by_id: HashMap<String, String>,
}

static ANTIGRAVITY_WORKSPACE_CACHE: OnceLock<Mutex<HashMap<String, CachedWorkspaceMap>>> =
    OnceLock::new();

fn workspace_cache() -> &'static Mutex<HashMap<String, CachedWorkspaceMap>> {
    ANTIGRAVITY_WORKSPACE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn invalidate_workspace_cache() {
    if let Ok(mut cache) = workspace_cache().lock() {
        cache.clear();
    }
}

pub(super) fn parse_workspace_uri(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return None;
    }
    if trimmed
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        let parsed = Url::parse(trimmed).ok()?;
        if !parsed.scheme().eq_ignore_ascii_case("file") {
            return None;
        }
        let decoded = percent_decode_str(parsed.path()).decode_utf8().ok()?;
        if decoded.is_empty()
            || decoded.chars().any(char::is_control)
            || decoded.split('/').any(|seg| seg == "." || seg == "..")
        {
            return None;
        }
        return match parsed.host_str() {
            None => normalize_file_uri_local_path(&decoded),
            Some(host) if host.is_empty() || host.eq_ignore_ascii_case("localhost") => {
                normalize_file_uri_local_path(&decoded)
            }
            Some(host) => Some(format!("//{host}{decoded}")),
        };
    }

    let slash_normalized = trimmed.replace('\\', "/");
    if slash_normalized
        .split('/')
        .any(|seg| seg == "." || seg == "..")
    {
        return None;
    }
    if crate::wsl::parse_wsl_unc_path(&slash_normalized).is_some() {
        return Some(slash_normalized);
    }
    if slash_normalized.starts_with('/') && !slash_normalized.starts_with("//") {
        return Some(trimmed.to_string());
    }
    let bytes = slash_normalized.as_bytes();
    if bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1..3) == Some(b":/") {
        return Some(trimmed.to_string());
    }
    None
}

fn normalize_file_uri_local_path(decoded: &str) -> Option<String> {
    let bytes = decoded.as_bytes();
    if bytes.first() == Some(&b'/')
        && bytes.get(1).is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(2) == Some(&b':')
    {
        let drive_path = &decoded[1..];
        if drive_path.len() == 2 {
            return Some(format!("{drive_path}/"));
        }
        if drive_path.as_bytes().get(2) == Some(&b'/') {
            return Some(drive_path.to_string());
        }
        return None;
    }
    decoded.starts_with('/').then(|| decoded.to_string())
}

fn canonical_workspace_key(raw: &str) -> Option<String> {
    let path = raw.trim().replace('\\', "/");
    if path.is_empty()
        || path.chars().any(char::is_control)
        || path.split('/').any(|c| c == "." || c == "..")
    {
        return None;
    }
    let trimmed = if path == "/" || (path.as_bytes().get(1..) == Some(b":/")) {
        path.as_str()
    } else {
        path.trim_end_matches('/')
    };
    if let Some((distro, linux)) = crate::wsl::parse_wsl_unc_path(trimmed) {
        return Some(format!("//wsl/{}{}", distro.to_ascii_lowercase(), linux));
    }
    let bytes = trimmed.as_bytes();
    if bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1..3) == Some(b":/") {
        return Some(trimmed.to_lowercase());
    }
    if trimmed.starts_with('/') && !trimmed.starts_with("//") {
        return Some(trimmed.to_string());
    }
    None
}

fn read_summaries_db_sync(db_path: &Path) -> Option<(HashMap<String, String>, HashSet<String>)> {
    let db_path = db_path.to_path_buf();
    let read = move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        runtime
            .block_on(read_summaries_db_async(&db_path))
            .ok()
    };

    if tokio::runtime::Handle::try_current().is_ok() {
        std::thread::spawn(read).join().ok().flatten()
    } else {
        read()
    }
}

async fn read_summaries_db_async(
    db_path: &Path,
) -> Result<(HashMap<String, String>, HashSet<String>), String> {
    match query_summaries_db(db_path, false).await {
        Ok(result) => Ok(result),
        Err(_) => query_summaries_db(db_path, true).await,
    }
}

async fn query_summaries_db(
    db_path: &Path,
    immutable: bool,
) -> Result<(HashMap<String, String>, HashSet<String>), String> {
    let mut options = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(1));
    if immutable {
        options = options.immutable(true);
    }
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| err.to_string())?;
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'",
    )
    .fetch_one(&mut conn)
    .await
    .map_err(|err| err.to_string())?;
    if table_exists == 0 {
        return Ok((HashMap::new(), HashSet::new()));
    }

    let rows = sqlx::query(
        "SELECT conversation_id, workspace_uris
         FROM conversation_summaries
         WHERE conversation_id <> ''",
    )
    .fetch_all(&mut conn)
    .await
    .map_err(|err| err.to_string())?;

    let mut by_id: HashMap<String, String> = HashMap::new();
    let mut by_key: HashMap<String, String> = HashMap::new();
    let mut ambiguous: HashSet<String> = HashSet::new();

    for row in rows {
        let conversation_id: String = row
            .try_get("conversation_id")
            .map_err(|err| err.to_string())?;
        let id = conversation_id.trim().to_string();
        if id.is_empty() || ambiguous.contains(&id) {
            continue;
        }
        let uris_raw: String = row
            .try_get("workspace_uris")
            .map_err(|err| err.to_string())?;
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(uris_raw.trim()) else {
            continue;
        };
        let mut unique: HashMap<String, String> = HashMap::new();
        for item in items {
            let Some(uri) = item.as_str() else {
                continue;
            };
            let Some(resolved) = parse_workspace_uri(uri) else {
                continue;
            };
            let key = canonical_workspace_key(&resolved).unwrap_or_else(|| resolved.clone());
            unique.entry(key).or_insert(resolved);
        }
        if unique.len() > 1 {
            by_id.remove(&id);
            by_key.remove(&id);
            ambiguous.insert(id);
            continue;
        }
        if let Some((key, resolved)) = unique.into_iter().next() {
            if let Some(prior_key) = by_key.get(&id) {
                if prior_key != &key {
                    by_id.remove(&id);
                    by_key.remove(&id);
                    ambiguous.insert(id);
                    continue;
                }
            }
            by_key.insert(id.clone(), key);
            by_id.insert(id, resolved);
        }
    }

    Ok((by_id, ambiguous))
}

fn load_history_jsonl_fallback(
    root: &Path,
    by_id: &mut HashMap<String, String>,
    ambiguous: &HashSet<String>,
) {
    let path = root.join("history.jsonl");
    if !root
        .canonicalize()
        .ok()
        .zip(path.canonicalize().ok())
        .is_some_and(|(base, file)| base.join("history.jsonl") == file)
    {
        return;
    }
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut fallback_by_id: HashMap<String, String> = HashMap::new();
    let mut fallback_keys: HashMap<String, String> = HashMap::new();
    let mut fallback_ambiguous: HashSet<String> = HashSet::new();

    for line in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
    {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(id) = value
            .get("conversationId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        if ambiguous.contains(&id) || by_id.contains_key(&id) || fallback_ambiguous.contains(&id) {
            continue;
        }
        let Some(workspace) = value
            .get("workspace")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|ws| !ws.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        let key = canonical_workspace_key(&workspace).unwrap_or_else(|| workspace.clone());
        if fallback_keys
            .insert(id.clone(), key.clone())
            .is_some_and(|prior| prior != key)
        {
            fallback_ambiguous.insert(id);
            continue;
        }
        fallback_by_id.insert(id, workspace);
    }

    for (id, workspace) in fallback_by_id {
        if !fallback_ambiguous.contains(&id) {
            by_id.entry(id).or_insert(workspace);
        }
    }
}

pub(super) fn load_workspace_map(root: &Path) -> HashMap<String, String> {
    let db_path = root.join("conversation_summaries.db");
    let wal_path = root.join("conversation_summaries.db-wal");
    let history_path = root.join("history.jsonl");
    let db_fp = session_file_fingerprint(&db_path);
    let wal_fp = session_file_fingerprint(&wal_path);
    let history_fp = session_file_fingerprint(&history_path);
    let cache_key = path_to_key(root);

    if let Ok(cache) = workspace_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            if cached.db_fp == db_fp
                && cached.wal_fp == wal_fp
                && cached.history_fp == history_fp
            {
                return cached.by_id.clone();
            }
        }
    }

    let (mut by_id, ambiguous) = if root
        .canonicalize()
        .ok()
        .zip(db_path.canonicalize().ok())
        .is_some_and(|(base, file)| base.join("conversation_summaries.db") == file)
    {
        read_summaries_db_sync(&db_path).unwrap_or_default()
    } else {
        (HashMap::new(), HashSet::new())
    };
    load_history_jsonl_fallback(root, &mut by_id, &ambiguous);

    if let Ok(mut cache) = workspace_cache().lock() {
        if cache.len() >= WORKSPACE_CACHE_MAX_ROOTS && !cache.contains_key(&cache_key) {
            cache.clear();
        }
        cache.insert(
            cache_key,
            CachedWorkspaceMap {
                db_fp,
                wal_fp,
                history_fp,
                by_id: by_id.clone(),
            },
        );
    }

    by_id
}

pub(super) fn is_cli_root(root: &Path) -> bool {
    root.ends_with(Path::new(".gemini/antigravity-cli"))
}

pub(super) fn same_root(a: &Path, b: &Path) -> bool {
    match (
        crate::wsl::parse_wsl_unc_path(&a.to_string_lossy()),
        crate::wsl::parse_wsl_unc_path(&b.to_string_lossy()),
    ) {
        (Some((d1, p1)), Some((d2, p2))) => d1.eq_ignore_ascii_case(&d2) && p1 == p2,
        (None, None) => a == b,
        _ => false,
    }
}

pub(super) fn distro(path: &Path) -> Option<String> {
    crate::wsl::parse_wsl_unc_path(&path.to_string_lossy())
        .map(|(name, _)| name.to_ascii_lowercase())
}

pub(super) fn cwd_matches(file: &Path, cwd: &str, target: &str) -> bool {
    let environment = distro(file);
    let key = |raw: &str| -> Option<String> {
        let path = raw.trim().replace('\\', "/");
        if path.chars().any(char::is_control) || path.split('/').any(|c| c == ".." || c == ".") {
            return None;
        }
        let path = if path == "/" || path.as_bytes().get(1..) == Some(b":/") {
            path.as_str()
        } else {
            path.trim_end_matches('/')
        };
        if let Some((distro, linux)) = crate::wsl::parse_wsl_unc_path(path) {
            return (environment.as_deref() == Some(distro.to_ascii_lowercase().as_str()))
                .then_some(linux);
        }
        if path.starts_with("//") {
            return None;
        }
        if environment.is_some() {
            if path.starts_with('/') {
                return Some(path.into());
            }
            return crate::wsl::windows_path_to_wsl(path);
        }
        (path.starts_with('/')
            || (path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && path.as_bytes().get(1..3) == Some(b":/")))
        .then(|| {
            if path.as_bytes().get(1) == Some(&b':') {
                path.to_lowercase()
            } else {
                path.into()
            }
        })
    };
    key(cwd).is_some_and(|cwd| key(target).as_ref() == Some(&cwd))
}

pub(super) fn exact_ref(root: &Path, file: &Path) -> Option<(SessionFileRef, Option<String>)> {
    let (parent, id) = antigravity_path_parts(file)?;
    if !same_root(&parent, root) || !file.is_file() {
        return None;
    }
    let real_root = root.canonicalize().ok()?;
    let real_file = file.canonicalize().ok()?;
    // Reject links into a sibling session (or outside the root), not just traversal strings.
    if real_root.join(file.strip_prefix(&parent).ok()?) != real_file {
        return None;
    }
    if is_cli_root(root) {
        let home = root.parent()?.parent()?.canonicalize().ok()?;
        if home.join(".gemini").join("antigravity-cli") != real_root {
            return None;
        }
    }
    let cwd = antigravity_workspace_from_path(file);
    let project_key = cwd.as_deref().and_then(project_key_from_cwd).unwrap_or(id);
    Some((
        SessionFileRef {
            source: "antigravity".into(),
            project_key,
            path: file.into(),
        },
        cwd,
    ))
}

pub(super) fn bound_summary(
    root: &Path,
    id: &str,
    target: &str,
    expected_distro: &str,
) -> Option<HistorySessionSummary> {
    let uuid = Uuid::parse_str(id).ok()?;
    if uuid.is_nil()
        || !is_cli_root(root)
        || distro(root).as_deref().unwrap_or("") != expected_distro.to_ascii_lowercase()
        || uuid.hyphenated().to_string() != id.to_ascii_lowercase()
    {
        return None;
    }
    let file = root
        .join("brain")
        .join(id)
        .join(".system_generated/logs/transcript.jsonl");
    let (file_ref, cwd) = exact_ref(root, &file)?;
    if !cwd_matches(&file, cwd.as_deref()?, target) {
        return None;
    }
    // The detail reader parses content only when this exact file's mtime or size changed.
    let metadata = std::fs::metadata(&file).ok()?;
    let updated_at = system_time_to_millis(metadata.modified().ok()?);
    Some(HistorySessionSummary {
        session_id: id.into(),
        parent_session_id: None,
        source: file_ref.source,
        project_key: file_ref.project_key,
        title: id.into(),
        file_path: file.to_string_lossy().into_owned(),
        cwd,
        created_at: metadata
            .created()
            .map(system_time_to_millis)
            .unwrap_or(updated_at),
        updated_at,
        file_size: Some(metadata.len()),
        message_count: 0,
        branch: None,
    })
}

pub(super) fn full_transcript_path(path: &Path) -> Option<PathBuf> {
    antigravity_path_parts(path)?;
    let logs_dir = path.parent()?;
    let full_path = logs_dir.join("transcript_full.jsonl");
    let (real_logs, real_full) = logs_dir
        .canonicalize()
        .ok()
        .zip(full_path.canonicalize().ok())?;
    (real_logs.join("transcript_full.jsonl") == real_full && real_full.is_file())
        .then_some(real_full)
}

pub(super) fn catalog_file_fingerprint(path: &Path) -> SessionFileFingerprint {
    let mut fp = session_file_fingerprint(path);
    if !looks_like_antigravity_transcript_file(path) {
        return fp;
    }
    if let Some(full_path) = full_transcript_path(path) {
        if let Ok(meta) = std::fs::metadata(&full_path) {
            let full_updated = meta
                .modified()
                .ok()
                .map(system_time_to_millis)
                .unwrap_or(0);
            fp.updated_at = fp.updated_at.max(full_updated);
            fp.size = fp.size.saturating_add(meta.len());
        }
    }
    fp
}

pub(super) fn instance_matches(locations: &str, roots: &HistoryRoots) -> bool {
    let Some(configured) = instance_root(locations) else {
        return false;
    };
    roots
        .antigravity_config_dir
        .as_ref()
        .is_some_and(|root| same_root(&configured, root))
        || same_root(&configured, &resolve_antigravity_history_root(roots))
}

fn instance_root(locations_json: &str) -> Option<PathBuf> {
    let value: serde_json::Value = serde_json::from_str(locations_json).ok()?;
    Some(PathBuf::from(value.get("configRoot")?.as_str()?))
}
