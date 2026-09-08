use cli_manager_history_core::{
    apply_jsonl_line, build_summary, parse_detail, path_matches_scope, ParserState,
    RemoteHistorySearchHit, RemoteHistorySessionDetail, RemoteHistorySessionSummary,
    RemoteHistorySyncResult, INDEX_SCHEMA_VERSION, PARSER_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::installer::read_installation_record;
use crate::layout::{resolve_layout, AgentLayout};

const MAX_INDEX_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DETAIL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SCAN_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILE_READ_BYTES: usize = 8 * 1024 * 1024;
const CODEX_THREAD_NAME_INDEX_MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HISTORY_FILES: usize = 100_000;
const MAX_WALK_DEPTH: usize = 32;
const LOCK_STALE_MS: i64 = 60_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryScopeRequest {
    pub source: String,
    pub configured_config_root: String,
    #[serde(default)]
    pub project_paths: Vec<String>,
    #[serde(default)]
    pub cursor: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchRequest {
    #[serde(flatten)]
    pub scope: HistoryScopeRequest,
    pub query: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGetRequest {
    #[serde(flatten)]
    pub scope: HistoryScopeRequest,
    pub source_session_id: String,
    #[serde(default)]
    pub remote_transcript_ref: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResumePreflightRequest {
    pub source: String,
    pub configured_config_root: String,
    pub source_session_id: String,
    pub expected_source_instance_id: String,
    pub expected_remote_machine_id: String,
    pub expected_ssh_user: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResumePreflight {
    pub source: String,
    pub source_session_id: String,
    pub source_instance_id: String,
    pub installation_id: String,
    pub remote_machine_id: String,
    pub ssh_user: String,
    pub canonical_config_root: String,
    pub remote_cwd: String,
    pub cli_command: String,
    pub resume_args: Vec<String>,
    pub environment_overrides: BTreeMap<String, String>,
    pub parser_version: u32,
    pub indexed_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryIndex {
    schema_version: u32,
    parser_version: u32,
    source: String,
    source_instance_id: String,
    canonical_config_root: String,
    config_root_hash: String,
    generation: u64,
    updated_at: i64,
    #[serde(default)]
    discovery_complete: bool,
    #[serde(default = "default_partial")]
    partial: bool,
    #[serde(default)]
    project_paths: BTreeSet<String>,
    #[serde(default)]
    codex_thread_name_fingerprint: String,
    entries: BTreeMap<String, HistoryIndexEntry>,
}

#[derive(Default)]
struct CodexThreadNameIndex {
    names: BTreeMap<String, String>,
    fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryIndexEntry {
    relative_path: String,
    artifact_id: String,
    file_id: String,
    modified_ns: i128,
    size: u64,
    indexed_offset: u64,
    line_count: usize,
    file_generation: u64,
    project_key: String,
    in_scope: bool,
    parser_state: ParserState,
    #[serde(default)]
    skipping_oversized_line: bool,
    summary: Option<RemoteHistorySessionSummary>,
}

struct ResolvedScope {
    source: String,
    configured_root: String,
    canonical_root: PathBuf,
    config_root_hash: String,
    source_instance_id: String,
    installation_id: String,
    remote_machine_id: String,
    ssh_user: String,
    project_paths: Vec<String>,
    index_dir: PathBuf,
}

struct IndexLock {
    path: PathBuf,
}

impl Drop for IndexLock {
    // 释放索引写锁时尽力删除 owner 文件和空锁目录，不传播清理错误。
    fn drop(&mut self) {
        let _ = fs::remove_file(self.path.join("owner"));
        let _ = fs::remove_dir(&self.path);
    }
}

struct WalkResult {
    files: Vec<DiscoveredFile>,
    complete: bool,
    warnings: Vec<String>,
}

struct DiscoveredFile {
    path: PathBuf,
    modified_ns: i128,
}

// 为未指定分页大小的请求提供默认 200 条上限。
fn default_limit() -> usize {
    200
}

// 旧索引缺少 partial 字段时按未完成处理，避免直接复用不明完整性的缓存。
fn default_partial() -> bool {
    true
}

// 仅在未强刷、索引已发布且完整、项目范围已覆盖并且 Codex 名称指纹未变时复用。
// 不扫描转录文件来检查新内容；新文件或追加内容本身不会使此判断失效。
fn can_reuse_published_index(
    force_refresh: bool,
    project_paths: &[String],
    index: &HistoryIndex,
    codex_thread_names: &CodexThreadNameIndex,
) -> bool {
    !force_refresh
        && index.updated_at > 0
        && !index.partial
        && project_paths
            .iter()
            .all(|path| index.project_paths.contains(path))
        && (index.source != "codex"
            || index.codex_thread_name_fingerprint == codex_thread_names.fingerprint)
}

// 按请求项目范围筛选并排序摘要，结合当前代次游标分页；仅第一页附带本次删除标记。
fn sync_result(
    request: &HistoryScopeRequest,
    scope: &ResolvedScope,
    index: &HistoryIndex,
    as_of: i64,
    tombstones: Vec<String>,
    warnings: Vec<String>,
) -> RemoteHistorySyncResult {
    let limit = request.limit.clamp(1, 1_000);
    let mut all_sessions: Vec<_> = index
        .entries
        .values()
        .filter(|entry| entry_matches_scope(entry, &scope.project_paths))
        .filter_map(|entry| entry.summary.clone())
        .collect();
    all_sessions.sort_by(|left, right| {
        right.updated_at.cmp(&left.updated_at).then_with(|| {
            left.session_ref
                .source_session_id
                .cmp(&right.session_ref.source_session_id)
        })
    });
    let total_sessions = all_sessions.len();
    let offset = sync_cursor_offset(&request.cursor, index.generation).min(total_sessions);
    let end = offset.saturating_add(limit).min(total_sessions);
    let sessions = all_sessions[offset..end].to_vec();

    RemoteHistorySyncResult {
        source_instance_id: scope.source_instance_id.clone(),
        source: scope.source.clone(),
        installation_id: scope.installation_id.clone(),
        remote_machine_id: scope.remote_machine_id.clone(),
        ssh_user: scope.ssh_user.clone(),
        configured_config_root: scope.configured_root.clone(),
        canonical_config_root: path_text(&scope.canonical_root),
        config_root_hash: scope.config_root_hash.clone(),
        generation: index.generation,
        cursor: format!("{}:{end}", index.generation),
        has_more: end < total_sessions,
        total_sessions,
        freshness_state: if index.partial { "partial" } else { "fresh" }.to_string(),
        as_of,
        discovery_complete: index.discovery_complete,
        partial: index.partial,
        sessions,
        tombstones: if offset == 0 { tombstones } else { Vec::new() },
        warnings,
    }
}

// 解析范围后优先复用完整索引，否则持锁发现文件并在扫描预算内增量解析、更新摘要和发布索引。
// 项目范围累积合并，只有完整发现且全部解析完成才移除缺失条目；该调用可能创建并写入索引状态。
pub fn sync(request: HistoryScopeRequest) -> Result<RemoteHistorySyncResult, String> {
    let scope = resolve_scope(&request)?;
    let published_codex_thread_names = load_codex_thread_name_index(&scope);
    fs::create_dir_all(&scope.index_dir).map_err(|_| "history_index_dir_failed".to_string())?;
    set_dir_permissions(&scope.index_dir)?;
    let published = load_index(&scope)?;
    if can_reuse_published_index(
        request.force_refresh,
        &scope.project_paths,
        &published,
        &published_codex_thread_names,
    ) {
        return Ok(sync_result(
            &request,
            &scope,
            &published,
            published.updated_at,
            Vec::new(),
            Vec::new(),
        ));
    }

    let _lock = acquire_lock(&scope.index_dir)?;
    let mut index = load_index(&scope)?;
    let codex_thread_names = load_codex_thread_name_index(&scope);
    let previous_project_count = index.project_paths.len();
    // ponytail: scopes accumulate because the protocol has no authoritative cross-client unbind set;
    // replace this union with per-client leases when remote index cleanup needs to be immediate.
    index
        .project_paths
        .extend(scope.project_paths.iter().cloned());
    let indexed_project_paths = index.project_paths.iter().cloned().collect::<Vec<_>>();
    let discovery = discover_files(&scope);
    let seen: BTreeSet<String> = discovery
        .files
        .iter()
        .filter_map(|file| relative_string(&scope.canonical_root, &file.path))
        .collect();
    let mut remaining_bytes = MAX_SCAN_BYTES;
    let codex_thread_name_changed = scope.source == "codex"
        && index.codex_thread_name_fingerprint != codex_thread_names.fingerprint;
    let mut changed =
        index.project_paths.len() != previous_project_count || codex_thread_name_changed;
    let mut fully_indexed = true;
    for file in &discovery.files {
        if remaining_bytes == 0 {
            fully_indexed = false;
            break;
        }
        let relative = relative_string(&scope.canonical_root, &file.path)
            .ok_or_else(|| "history_artifact_outside_root".to_string())?;
        let outcome = update_entry(
            &scope,
            &mut index,
            &file.path,
            &relative,
            &mut remaining_bytes,
            &indexed_project_paths,
        )?;
        changed |= outcome.changed;
        fully_indexed &= outcome.complete;
    }

    let discovery_complete = discovery.complete && fully_indexed;
    let previous_entry_count = index.entries.len();
    let tombstones = remove_missing_entries(&mut index, &seen, discovery_complete);
    changed |= index.entries.len() != previous_entry_count;
    let partial = !discovery_complete;
    let state_changed = index.discovery_complete != discovery_complete || index.partial != partial;
    if changed {
        index.generation = index.generation.saturating_add(1);
        refresh_summaries(&scope, &mut index, &codex_thread_names);
    }
    if scope.source == "codex" {
        index.codex_thread_name_fingerprint = codex_thread_names.fingerprint.clone();
    }
    index.discovery_complete = discovery_complete;
    index.partial = partial;
    let scan_completed_at = now_ms();
    if changed || state_changed {
        index.updated_at = scan_completed_at;
        write_index(&scope, &index)?;
    }

    Ok(sync_result(
        &request,
        &scope,
        &index,
        scan_completed_at,
        tombstones,
        discovery.warnings,
    ))
}

// 仅解析与当前代次一致的 generation:offset 游标，无效格式或旧代次从零开始。
fn sync_cursor_offset(cursor: &str, generation: u64) -> usize {
    let Some((cursor_generation, offset)) = cursor.trim().split_once(':') else {
        return 0;
    };
    if cursor_generation.parse::<u64>().ok() != Some(generation) {
        return 0;
    }
    offset.parse::<usize>().unwrap_or_default()
}

// 查询至少三字符时检索已有索引的范围内摘要与搜索文本，应用 Codex 名称覆盖后返回限量命中。
// 不刷新索引；片段的字节切点若不是字符边界则回退整个搜索文本。
pub fn search(request: HistorySearchRequest) -> Result<Vec<RemoteHistorySearchHit>, String> {
    let query = request.query.trim().to_lowercase();
    if query.chars().count() < 3 {
        return Ok(Vec::new());
    }
    let scope = resolve_scope(&request.scope)?;
    let index = load_index(&scope)?;
    let codex_thread_names = load_codex_thread_name_index(&scope);
    let limit = request.scope.limit.clamp(1, 200);
    let mut hits = Vec::new();
    for entry in index
        .entries
        .values()
        .filter(|entry| entry_matches_scope(entry, &scope.project_paths))
    {
        let Some(summary) = entry.summary.as_ref() else {
            continue;
        };
        let mut title = summary.title.clone();
        apply_codex_thread_name(
            &scope,
            &codex_thread_names,
            &summary.session_ref.source_session_id,
            &mut title,
        );
        let haystack = format!(
            "{}\n{}\n{}\n{}\n{}",
            summary.session_ref.source_session_id,
            summary.project_key,
            title,
            summary.cwd.as_deref().unwrap_or_default(),
            entry.parser_state.search_text,
        )
        .to_lowercase();
        let Some(position) = haystack.find(&query) else {
            continue;
        };
        let start = position.saturating_sub(48);
        let end = (position + query.len() + 96).min(haystack.len());
        let snippet = haystack.get(start..end).unwrap_or(&haystack).to_string();
        hits.push(RemoteHistorySearchHit {
            session_ref: summary.session_ref.clone(),
            project_key: summary.project_key.clone(),
            title,
            role: "remoteIndex".to_string(),
            snippet,
            timestamp: None,
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

// 有显式转录引用时直接读取并校验会话身份与项目范围，否则从已发布索引选择条目解析详情。
// 读取前按元数据检查大小，仅解析完整 JSONL 行；不是并发改写下的文件快照。
pub fn get(request: HistoryGetRequest) -> Result<RemoteHistorySessionDetail, String> {
    let source_session_id = request.source_session_id.trim();
    if source_session_id.is_empty() || source_session_id.len() > 512 {
        return Err("history_session_id_invalid".to_string());
    }
    let scope = resolve_scope(&request.scope)?;
    if !request.remote_transcript_ref.trim().is_empty() {
        let path = safe_transcript_ref(&scope.canonical_root, &request.remote_transcript_ref)?;
        return detail_from_path(&scope, &path, source_session_id, 0);
    }
    let index = load_index(&scope)?;
    let entry = index
        .entries
        .values()
        .find(|entry| {
            entry_matches_scope(entry, &scope.project_paths)
                && entry.summary.as_ref().is_some_and(|summary| {
                    summary.session_ref.source_session_id == source_session_id
                })
        })
        .ok_or_else(|| "history_session_not_found".to_string())?;
    let path = safe_artifact_path(&scope.canonical_root, &entry.relative_path)?;
    let metadata = path
        .metadata()
        .map_err(|_| "history_artifact_unavailable".to_string())?;
    if metadata.len() > MAX_DETAIL_BYTES {
        return Err("history_detail_too_large".to_string());
    }
    let bytes = fs::read(&path).map_err(|_| "history_artifact_read_failed".to_string())?;
    let complete = complete_jsonl_bytes(&bytes);
    let lines = String::from_utf8_lossy(complete)
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut detail = parse_detail(
        &scope.source,
        &scope.source_instance_id,
        &entry.artifact_id,
        source_session_id,
        &entry.project_key,
        file_created_ms(&metadata),
        file_modified_ms(&metadata),
        index.generation,
        lines,
    );
    let codex_thread_names = load_codex_thread_name_index(&scope);
    apply_codex_thread_name(
        &scope,
        &codex_thread_names,
        &detail.summary.session_ref.source_session_id,
        &mut detail.summary.title,
    );
    Ok(detail)
}

// 从已定位文件重建详情和 Codex 标题，再严格比对请求会话 ID 与项目范围；调用方负责路径定位。
fn detail_from_path(
    scope: &ResolvedScope,
    path: &Path,
    source_session_id: &str,
    index_generation: u64,
) -> Result<RemoteHistorySessionDetail, String> {
    let metadata = path
        .metadata()
        .map_err(|_| "history_artifact_unavailable".to_string())?;
    if metadata.len() > MAX_DETAIL_BYTES {
        return Err("history_detail_too_large".to_string());
    }
    let relative = relative_string(&scope.canonical_root, path)
        .ok_or_else(|| "history_artifact_outside_root".to_string())?;
    let bytes = fs::read(path).map_err(|_| "history_artifact_read_failed".to_string())?;
    let complete = complete_jsonl_bytes(&bytes);
    let mut detail = parse_detail(
        &scope.source,
        &scope.source_instance_id,
        &hash_text(&relative),
        Path::new(&relative)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(source_session_id),
        &project_key(scope, &relative),
        file_created_ms(&metadata),
        file_modified_ms(&metadata),
        index_generation,
        String::from_utf8_lossy(complete)
            .lines()
            .map(str::to_string),
    );
    let codex_thread_names = load_codex_thread_name_index(scope);
    apply_codex_thread_name(
        scope,
        &codex_thread_names,
        &detail.summary.session_ref.source_session_id,
        &mut detail.summary.title,
    );
    if detail.summary.session_ref.source_session_id != source_session_id
        || !path_matches_scope(
            detail.summary.cwd.as_deref(),
            &detail.summary.project_key,
            &scope.project_paths,
        )
    {
        return Err("history_session_identity_mismatch".to_string());
    }
    Ok(detail)
}

// 核对远端身份、索引会话文件可打开、工作目录与 PATH 候选后返回结构化恢复参数和配置环境。
// 不刷新索引、不执行 CLI，也不重新解析源文件来核对摘要；可选身份字段为空时按现有规则跳过比较。
pub fn resume_preflight(
    request: HistoryResumePreflightRequest,
) -> Result<HistoryResumePreflight, String> {
    let source = request.source.trim().to_lowercase();
    if !matches!(source.as_str(), "claude" | "codex") {
        return Err("history_resume_source_invalid".to_string());
    }
    let source_session_id = request.source_session_id.trim();
    if source_session_id.is_empty()
        || source_session_id.len() > 512
        || source_session_id.contains(['\0', '\r', '\n', ' '])
    {
        return Err("history_resume_session_id_invalid".to_string());
    }
    let scope = resolve_scope(&HistoryScopeRequest {
        source: source.clone(),
        configured_config_root: request.configured_config_root.clone(),
        project_paths: vec!["/".to_string()],
        cursor: String::new(),
        limit: 1,
        force_refresh: false,
    })?;
    if !request.expected_source_instance_id.trim().is_empty()
        && request.expected_source_instance_id.trim() != scope.source_instance_id
    {
        return Err("history_remote_identity_changed".to_string());
    }
    if request.expected_remote_machine_id.trim() != scope.remote_machine_id
        || (!request.expected_ssh_user.trim().is_empty()
            && request.expected_ssh_user.trim() != scope.ssh_user)
    {
        return Err("history_remote_identity_changed".to_string());
    }
    let index = load_index(&scope)?;
    let entry = index
        .entries
        .values()
        .find(|entry| {
            entry
                .summary
                .as_ref()
                .is_some_and(|summary| summary.session_ref.source_session_id == source_session_id)
        })
        .ok_or_else(|| "remote_session_source_missing".to_string())?;
    let artifact = safe_artifact_path(&scope.canonical_root, &entry.relative_path)
        .map_err(|_| "remote_session_source_missing".to_string())?;
    File::open(artifact).map_err(|_| "remote_session_source_missing".to_string())?;
    let summary = entry
        .summary
        .as_ref()
        .ok_or_else(|| "remote_session_source_missing".to_string())?;
    let remote_cwd = summary
        .cwd
        .as_deref()
        .ok_or_else(|| "remote_session_cwd_missing".to_string())?;
    let remote_cwd = validate_resume_cwd(remote_cwd)?;
    let cli_command = if source == "claude" {
        "claude"
    } else {
        "codex"
    };
    if !command_available(cli_command) {
        return Err("unsupported_resume_tool".to_string());
    }
    let resume_args = build_resume_args(&source, source_session_id);
    let mut environment_overrides = BTreeMap::new();
    environment_overrides.insert(
        if source == "claude" {
            "CLAUDE_CONFIG_DIR".to_string()
        } else {
            "CODEX_HOME".to_string()
        },
        path_text(&scope.canonical_root),
    );
    Ok(HistoryResumePreflight {
        source,
        source_session_id: source_session_id.to_string(),
        source_instance_id: scope.source_instance_id,
        installation_id: scope.installation_id,
        remote_machine_id: scope.remote_machine_id,
        ssh_user: scope.ssh_user,
        canonical_config_root: path_text(&scope.canonical_root),
        remote_cwd,
        cli_command: cli_command.to_string(),
        resume_args,
        environment_overrides,
        parser_version: PARSER_VERSION,
        indexed_at: index.updated_at,
    })
}

// 生成包含命令名的 Claude --resume 或 Codex resume 参数列表，非 claude 按 Codex 分支处理。
fn build_resume_args(source: &str, source_session_id: &str) -> Vec<String> {
    if source == "claude" {
        vec![
            "claude".to_string(),
            "--resume".to_string(),
            source_session_id.to_string(),
        ]
    } else {
        vec![
            "codex".to_string(),
            "resume".to_string(),
            source_session_id.to_string(),
        ]
    }
}

// 拒绝非绝对形式、控制字符和父级段，规范化后要求现存目录；不限制在历史配置根内。
fn validate_resume_cwd(value: &str) -> Result<String, String> {
    let value = value.trim();
    if !value.starts_with('/')
        || value.contains(['\0', '\r', '\n', '\\'])
        || value.split('/').any(|part| part == "..")
    {
        return Err("remote_session_cwd_invalid".to_string());
    }
    let path = Path::new(value);
    let canonical = path
        .canonicalize()
        .map_err(|_| "remote_session_cwd_unavailable".to_string())?;
    if !canonical.is_dir() {
        return Err("remote_session_cwd_unavailable".to_string());
    }
    Ok(path_text(&canonical))
}

// 仅检查 PATH 中是否有同名文件，不验证执行权限、版本或实际可运行性。
fn command_available(command: &str) -> bool {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|path| path.join(command))
        .any(|path| path.is_file())
}

// 校验 Claude/Codex 来源与一至六十四个项目路径，规范化现存配置根并读取安装及 SSH 用户信息。
// 由机器、用户、来源和根哈希形成稳定源身份及索引目录，不在此扫描历史或验证配置目录所有者。
fn resolve_scope(request: &HistoryScopeRequest) -> Result<ResolvedScope, String> {
    let source = request.source.trim().to_lowercase();
    if !matches!(source.as_str(), "claude" | "codex") {
        return Err("history_source_invalid".to_string());
    }
    if request.project_paths.is_empty() || request.project_paths.len() > 64 {
        return Err("history_project_scope_required".to_string());
    }
    let project_paths = request
        .project_paths
        .iter()
        .map(|path| validate_project_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    let layout = resolve_layout().map_err(str::to_string)?;
    let configured_root = request.configured_config_root.trim().to_string();
    let requested_root = resolve_config_root(&layout, &source, &configured_root)?;
    let canonical_root = requested_root
        .canonicalize()
        .map_err(|_| "history_config_root_unavailable".to_string())?;
    if !canonical_root.is_dir() {
        return Err("history_config_root_not_directory".to_string());
    }
    let config_root_hash = hash_path(&canonical_root);
    let installation = read_installation_record(&layout)?
        .ok_or_else(|| "agent_installation_record_missing".to_string())?;
    let ssh_user = std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("LOGNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "history_ssh_user_unavailable".to_string())?;
    let source_instance_id = remote_source_instance_id(
        &installation.remote_machine_id,
        &ssh_user,
        &source,
        &config_root_hash,
    );
    let index_dir = layout
        .state_dir
        .join("history")
        .join(format!("{source}-{config_root_hash}"));
    Ok(ResolvedScope {
        source,
        configured_root,
        canonical_root,
        config_root_hash,
        source_instance_id,
        installation_id: installation.installation_id,
        remote_machine_id: installation.remote_machine_id,
        ssh_user,
        project_paths,
        index_dir,
    })
}

// 选择来源默认根或展开受控 HOME 路径，拒绝变量、反引号、控制字符和父级段；存在性由调用方检查。
fn resolve_config_root(
    layout: &AgentLayout,
    source: &str,
    configured: &str,
) -> Result<PathBuf, String> {
    let value = if configured.is_empty() {
        if source == "claude" {
            "~/.claude"
        } else {
            "~/.codex"
        }
    } else {
        configured
    };
    if value.contains(['\0', '\r', '\n', '\\', '$', '`'])
        || value.split('/').any(|part| part == "..")
    {
        return Err("history_config_root_invalid".to_string());
    }
    if value == "~" {
        return Ok(layout.home.clone());
    }
    if let Some(relative) = value.strip_prefix("~/") {
        return Ok(layout.home.join(relative));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("history_config_root_invalid".to_string());
    }
    Ok(path)
}

// 经共享远端路径归一化后检查绝对形式、控制字符及父级段，不访问项目目录。
fn validate_project_path(value: &str) -> Result<String, String> {
    let value = cli_manager_history_core::normalize_remote_path(value);
    if !value.starts_with('/')
        || value.contains(['\0', '\r', '\n', '\\'])
        || value.split('/').any(|part| part == "..")
    {
        return Err("history_project_path_invalid".to_string());
    }
    Ok(value)
}

struct UpdateOutcome {
    changed: bool,
    complete: bool,
}

// 按文件身份、截断、同大小重写和范围变化决定重建或从偏移续读，消费本轮单文件及总扫描预算。
// 只提交完整行，超长行推进偏移时跳过解析；范围外条目仅保留 cwd 等定位状态，不保存摘要内容。
fn update_entry(
    scope: &ResolvedScope,
    index: &mut HistoryIndex,
    path: &Path,
    relative: &str,
    remaining_bytes: &mut usize,
    indexed_project_paths: &[String],
) -> Result<UpdateOutcome, String> {
    let metadata = path
        .metadata()
        .map_err(|_| "history_artifact_metadata_failed".to_string())?;
    let file_id = file_id(&metadata);
    let modified_ns = file_modified_ns(&metadata);
    let size = metadata.len();
    let project_key = project_key(scope, relative);
    let existing = index.entries.remove(relative);
    let same_size_rewrite = existing.as_ref().is_some_and(|entry| {
        entry.file_id == file_id
            && entry.size == size
            && entry.indexed_offset == entry.size
            && entry.modified_ns != modified_ns
    });
    let scope_became_included = existing.as_ref().is_some_and(|entry| {
        !entry.in_scope
            && path_matches_scope(
                entry.parser_state.cwd.as_deref(),
                &project_key,
                indexed_project_paths,
            )
    });
    let reset = existing.as_ref().is_none_or(|entry| {
        entry.file_id != file_id || size < entry.indexed_offset || entry.project_key != project_key
    }) || same_size_rewrite
        || scope_became_included;
    let mut entry = existing.unwrap_or_else(|| HistoryIndexEntry {
        relative_path: relative.to_string(),
        artifact_id: hash_text(relative),
        file_id: file_id.clone(),
        modified_ns,
        size,
        indexed_offset: 0,
        line_count: 0,
        file_generation: 0,
        project_key: project_key.clone(),
        in_scope: false,
        parser_state: ParserState::default(),
        skipping_oversized_line: false,
        summary: None,
    });
    if reset {
        entry.file_generation = entry.file_generation.saturating_add(1);
        entry.indexed_offset = 0;
        entry.line_count = 0;
        entry.parser_state = ParserState::default();
        entry.skipping_oversized_line = false;
        entry.summary = None;
    }
    let unchanged = !reset
        && entry.file_id == file_id
        && entry.modified_ns == modified_ns
        && entry.size == size
        && entry.indexed_offset == size;
    if unchanged {
        index.entries.insert(relative.to_string(), entry);
        return Ok(UpdateOutcome {
            changed: false,
            complete: true,
        });
    }
    let allowed = (*remaining_bytes).min(MAX_FILE_READ_BYTES);
    if allowed == 0 {
        index.entries.insert(relative.to_string(), entry);
        return Ok(UpdateOutcome {
            changed: false,
            complete: false,
        });
    }
    let mut file = File::open(path).map_err(|_| "history_artifact_read_failed".to_string())?;
    file.seek(SeekFrom::Start(entry.indexed_offset))
        .map_err(|_| "history_artifact_seek_failed".to_string())?;
    let mut bytes = Vec::with_capacity(allowed.min(64 * 1024));
    file.take((allowed + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "history_artifact_read_failed".to_string())?;
    let complete_len = complete_jsonl_bytes(&bytes).len();
    let oversized = entry.skipping_oversized_line
        || complete_len > allowed
        || (complete_len == 0 && bytes.len() > allowed);
    let consumed_len = if oversized {
        if complete_len > 0 {
            entry.skipping_oversized_line = false;
            complete_len
        } else if bytes.len() > allowed {
            entry.skipping_oversized_line = true;
            allowed
        } else {
            0
        }
    } else {
        for line in String::from_utf8_lossy(&bytes[..complete_len]).lines() {
            apply_jsonl_line(
                &mut entry.parser_state,
                &scope.source,
                line,
                entry.line_count,
            );
            entry.line_count = entry.line_count.saturating_add(1);
        }
        complete_len
    };
    if consumed_len > 0 {
        entry.indexed_offset = entry.indexed_offset.saturating_add(consumed_len as u64);
        *remaining_bytes = remaining_bytes.saturating_sub(consumed_len);
    }
    entry.file_id = file_id;
    entry.modified_ns = modified_ns;
    entry.size = size;
    entry.project_key = project_key;
    entry.in_scope = path_matches_scope(
        entry.parser_state.cwd.as_deref(),
        &entry.project_key,
        indexed_project_paths,
    );
    if !entry.in_scope {
        let cwd = entry.parser_state.cwd.take();
        entry.parser_state = ParserState {
            cwd,
            ..ParserState::default()
        };
        entry.summary = None;
    }
    let complete = entry.indexed_offset == size && !entry.skipping_oversized_line;
    index.entries.insert(relative.to_string(), entry);
    Ok(UpdateOutcome {
        changed: reset || consumed_len > 0,
        complete,
    })
}

// 用条目解析出的 cwd 与项目键委托共享规则判断是否落在请求项目范围。
fn entry_matches_scope(entry: &HistoryIndexEntry, project_paths: &[String]) -> bool {
    path_matches_scope(
        entry.parser_state.cwd.as_deref(),
        &entry.project_key,
        project_paths,
    )
}

// 只有扫描完整才移除本轮未发现条目，并为带摘要的删除项返回源会话 ID。
fn remove_missing_entries(
    index: &mut HistoryIndex,
    seen: &BTreeSet<String>,
    discovery_complete: bool,
) -> Vec<String> {
    if !discovery_complete {
        return Vec::new();
    }
    let removed = index
        .entries
        .keys()
        .filter(|relative| !seen.contains(*relative))
        .cloned()
        .collect::<Vec<_>>();
    removed
        .into_iter()
        .filter_map(|relative| index.entries.remove(&relative))
        .filter_map(|entry| entry.summary)
        .map(|summary| summary.session_ref.source_session_id)
        .collect()
}

// 为累计范围内条目按当前索引代次重建摘要，再覆盖 Codex 自定义名称；范围外条目不在此处理。
fn refresh_summaries(
    scope: &ResolvedScope,
    index: &mut HistoryIndex,
    codex_thread_names: &CodexThreadNameIndex,
) {
    for entry in index.entries.values_mut().filter(|entry| entry.in_scope) {
        let fallback = Path::new(&entry.relative_path)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(&entry.artifact_id);
        let mut summary = build_summary(
            &entry.parser_state,
            &scope.source,
            &scope.source_instance_id,
            &entry.artifact_id,
            fallback,
            &entry.project_key,
            file_created_ms_from_path(&scope.canonical_root, &entry.relative_path),
            file_modified_ms_from_path(&scope.canonical_root, &entry.relative_path),
            index.generation,
        );
        apply_codex_thread_name(
            scope,
            codex_thread_names,
            &summary.session_ref.source_session_id,
            &mut summary.title,
        );
        entry.summary = Some(summary);
    }
}

// Codex 读取有大小限制的 session_index.jsonl，按元数据形成名称指纹；缺失或读取失败返回空名称表。
fn load_codex_thread_name_index(scope: &ResolvedScope) -> CodexThreadNameIndex {
    if scope.source != "codex" {
        return CodexThreadNameIndex {
            names: BTreeMap::new(),
            fingerprint: "not-codex".to_string(),
        };
    }
    let path = scope.canonical_root.join("session_index.jsonl");
    let metadata = fs::metadata(&path).ok();
    let fingerprint = metadata
        .as_ref()
        .map(|metadata| {
            format!(
                "{}:{}:{}",
                file_modified_ns(metadata),
                metadata.len(),
                file_created_ms(metadata),
            )
        })
        .unwrap_or_else(|| "missing".to_string());
    let Some(metadata) = metadata else {
        return CodexThreadNameIndex {
            names: BTreeMap::new(),
            fingerprint,
        };
    };
    if metadata.len() > CODEX_THREAD_NAME_INDEX_MAX_BYTES {
        return CodexThreadNameIndex {
            names: BTreeMap::new(),
            fingerprint: format!("{fingerprint}:oversized"),
        };
    }
    let names = fs::read(&path)
        .ok()
        .filter(|bytes| bytes.len() as u64 <= CODEX_THREAD_NAME_INDEX_MAX_BYTES)
        .map(|bytes| parse_codex_thread_name_index(&String::from_utf8_lossy(&bytes)))
        .unwrap_or_default();
    CodexThreadNameIndex { names, fingerprint }
}

// 逐行忽略坏 JSON 或缺失名称，兼容两种 ID/名称字段并限制标题为 240 字符，同 ID 后写覆盖。
fn parse_codex_thread_name_index(text: &str) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let Some(session_id) = value
            .get("id")
            .or_else(|| value.get("session_id"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(thread_name) = value
            .get("thread_name")
            .or_else(|| value.get("threadName"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let title: String = thread_name.chars().take(240).collect();
        if !title.is_empty() {
            names.insert(session_id.to_string(), title);
        }
    }
    names
}

// 仅对 Codex 且名称表含匹配会话时替换标题，否则保留原值。
fn apply_codex_thread_name(
    scope: &ResolvedScope,
    codex_thread_names: &CodexThreadNameIndex,
    session_id: &str,
    title: &mut String,
) {
    if scope.source != "codex" {
        return;
    }
    if let Some(thread_name) = codex_thread_names.names.get(session_id) {
        *title = thread_name.clone();
    }
}

// 选择 Claude projects 或 Codex 当前及归档会话目录，收集 JSONL 后按修改时间降序、路径次序排序。
fn discover_files(scope: &ResolvedScope) -> WalkResult {
    let roots = if scope.source == "claude" {
        vec![scope.canonical_root.join("projects")]
    } else {
        vec![
            scope.canonical_root.join("sessions"),
            scope.canonical_root.join("archived_sessions"),
        ]
    };
    let mut result = WalkResult {
        files: Vec::new(),
        complete: true,
        warnings: Vec::new(),
    };
    for root in roots {
        match fs::metadata(&root) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                result.complete = false;
                result
                    .warnings
                    .push("history_directory_unreadable".to_string());
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                result.complete = false;
                result
                    .warnings
                    .push("history_directory_unreadable".to_string());
                continue;
            }
        }
        walk_jsonl(&root, &scope.canonical_root, 0, &mut result);
    }
    result.files.sort_by(|left, right| {
        right
            .modified_ns
            .cmp(&left.modified_ns)
            .then_with(|| left.path.cmp(&right.path))
    });
    result
}

// 递归发现根内普通 JSONL 文件并跳过枚举到的符号链接，访问失败或深度限制会标记扫描不完整。
// 文件数上限在每次递归入口检查，而非每次追加检查，因此不构成严格的总文件数上限。
fn walk_jsonl(path: &Path, canonical_root: &Path, depth: usize, result: &mut WalkResult) {
    if depth > MAX_WALK_DEPTH || result.files.len() >= MAX_HISTORY_FILES {
        result.complete = false;
        result
            .warnings
            .push("history_scan_limit_reached".to_string());
        return;
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => {
            result.complete = false;
            result
                .warnings
                .push("history_directory_unreadable".to_string());
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            result.complete = false;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            result.complete = false;
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            walk_jsonl(&path, canonical_root, depth + 1, result);
            continue;
        }
        if !kind.is_file() || path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            result.complete = false;
            continue;
        };
        if canonical.starts_with(canonical_root) {
            let Ok(metadata) = canonical.metadata() else {
                result.complete = false;
                continue;
            };
            result.files.push(DiscoveredFile {
                modified_ns: file_modified_ns(&metadata),
                path: canonical,
            });
        } else {
            result.complete = false;
            result
                .warnings
                .push("history_artifact_outside_root".to_string());
        }
    }
}

// 读取派生索引，缺失、过大、解析失败或版本/身份不匹配时重建为空；读取错误仍返回失败。
// 大小检查在整体读取之后进行，不是内存读取硬上限。
fn load_index(scope: &ResolvedScope) -> Result<HistoryIndex, String> {
    let path = scope.index_dir.join("index.json");
    if !path.exists() {
        return Ok(empty_index(scope));
    }
    let bytes = fs::read(&path).map_err(|_| "history_index_read_failed".to_string())?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Ok(empty_index(scope));
    }
    let Ok(index) = serde_json::from_slice::<HistoryIndex>(&bytes) else {
        return Ok(empty_index(scope));
    };
    if index.schema_version != INDEX_SCHEMA_VERSION
        || index.parser_version != PARSER_VERSION
        || index.source != scope.source
        || index.source_instance_id != scope.source_instance_id
        || index.config_root_hash != scope.config_root_hash
    {
        return Ok(empty_index(scope));
    }
    Ok(index)
}

// 按当前源身份构造零代次、未发现完成且 partial 的空派生索引。
fn empty_index(scope: &ResolvedScope) -> HistoryIndex {
    HistoryIndex {
        schema_version: INDEX_SCHEMA_VERSION,
        parser_version: PARSER_VERSION,
        source: scope.source.clone(),
        source_instance_id: scope.source_instance_id.clone(),
        canonical_config_root: path_text(&scope.canonical_root),
        config_root_hash: scope.config_root_hash.clone(),
        generation: 0,
        updated_at: 0,
        discovery_complete: false,
        partial: true,
        project_paths: BTreeSet::new(),
        codex_thread_name_fingerprint: String::new(),
        entries: BTreeMap::new(),
    }
}

// 序列化并检查索引大小，写入按 PID 命名的临时文件、同步后重命名并设置最终权限。
// 调用方负责持锁；发布后权限失败仍返回错误，不统一清理失败时的临时文件。
fn write_index(scope: &ResolvedScope, index: &HistoryIndex) -> Result<(), String> {
    let bytes = serde_json::to_vec(index).map_err(|_| "history_index_encode_failed".to_string())?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err("history_index_quota_exceeded".to_string());
    }
    let path = scope.index_dir.join("index.json");
    let temporary = scope
        .index_dir
        .join(format!(".index-{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "history_index_write_failed".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "history_index_write_failed".to_string())?;
    fs::rename(&temporary, &path).map_err(|_| "history_index_promote_failed".to_string())?;
    set_file_permissions(&path)
}

// 以默认一分钟陈旧阈值委托目录锁申请。
fn acquire_lock(index_dir: &Path) -> Result<IndexLock, String> {
    acquire_lock_with_stale_after(index_dir, LOCK_STALE_MS)
}

// 独占创建 writer.lock；旧锁仅在超过阈值且持有者不存活时尝试删除并递归重试。
// 删除结果被忽略，若陈旧锁持续无法删除，递归重试没有次数上限。
fn acquire_lock_with_stale_after(
    index_dir: &Path,
    stale_after_ms: i64,
) -> Result<IndexLock, String> {
    let path = index_dir.join("writer.lock");
    match fs::create_dir(&path) {
        Ok(()) => initialize_lock_dir(path),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let modified = path
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok());
            let stale = modified
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| {
                    now_ms().saturating_sub(value.as_millis() as i64) > stale_after_ms
                        && !lock_owner_alive(&path)
                })
                .unwrap_or(false);
            if stale {
                let _ = fs::remove_dir_all(&path);
                return acquire_lock_with_stale_after(index_dir, stale_after_ms);
            }
            Err("history_index_busy".to_string())
        }
        Err(_) => Err("history_index_lock_failed".to_string()),
    }
}

// 设置锁目录权限并写入当前 PID/时间，初始化失败时尽力清理目录再返回错误。
fn initialize_lock_dir(path: PathBuf) -> Result<IndexLock, String> {
    let result = set_dir_permissions(&path).and_then(|_| {
        fs::write(
            path.join("owner"),
            format!("{}\n{}", std::process::id(), now_ms()),
        )
        .map_err(|_| "history_index_lock_failed".to_string())
    });
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&path);
        return Err(error);
    }
    Ok(IndexLock { path })
}

// 读取 owner 首行 PID 并按平台存活规则判断，缺失或格式错误视为不存活。
fn lock_owner_alive(lock_path: &Path) -> bool {
    let Some(pid) = fs::read_to_string(lock_path.join("owner"))
        .ok()
        .and_then(|value| value.lines().next()?.trim().parse::<u32>().ok())
    else {
        return false;
    };
    process_is_alive(pid)
}

#[cfg(unix)]
// Unix 上仅凭非零 PID 的 /proc 项存在性判断，不校验进程身份。
fn process_is_alive(pid: u32) -> bool {
    pid > 0 && Path::new("/proc").join(pid.to_string()).exists()
}

#[cfg(not(unix))]
// 非 Unix 仅认为当前进程 PID 存活，不探测其他进程。
fn process_is_alive(pid: u32) -> bool {
    pid == std::process::id()
}

// 返回截至最后一个换行的完整前缀，未换行尾部暂不提交，无换行时返回空。
fn complete_jsonl_bytes(bytes: &[u8]) -> &[u8] {
    bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|position| &bytes[..=position])
        .unwrap_or_default()
}

// Claude projects 路径使用其下一段作为项目键，其他路径退回父目录末段。
fn project_key(scope: &ResolvedScope, relative: &str) -> String {
    if scope.source == "claude" {
        let mut parts = relative.split('/');
        if parts.next() == Some("projects") {
            return parts.next().unwrap_or_default().to_string();
        }
    }
    Path::new(relative)
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

// 拒绝绝对引用、父级段与非法控制字符，规范化相对路径后要求仍在根内且为文件。
fn safe_artifact_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains(['\0', '\r', '\n', '\\'])
        || Path::new(relative).is_absolute()
        || relative.split('/').any(|part| part == "..")
    {
        return Err("history_artifact_ref_invalid".to_string());
    }
    let path = root.join(relative);
    let canonical = path
        .canonicalize()
        .map_err(|_| "history_artifact_unavailable".to_string())?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err("history_artifact_outside_root".to_string());
    }
    Ok(canonical)
}

// 接受绝对或相对转录引用，规范化后要求根内 JSONL 文件；相对形式另走制品路径校验。
fn safe_transcript_ref(root: &Path, reference: &str) -> Result<PathBuf, String> {
    let reference = reference.trim();
    if reference.is_empty() || reference.contains(['\0', '\r', '\n', '\\']) {
        return Err("history_artifact_ref_invalid".to_string());
    }
    let candidate = Path::new(reference);
    let canonical = if candidate.is_absolute() {
        candidate
            .canonicalize()
            .map_err(|_| "history_artifact_unavailable".to_string())?
    } else {
        safe_artifact_path(root, reference)?
    };
    if !canonical.starts_with(root)
        || !canonical.is_file()
        || canonical.extension().and_then(|value| value.to_str()) != Some("jsonl")
    {
        return Err("history_artifact_outside_root".to_string());
    }
    Ok(canonical)
}

// 仅对根路径前缀下的路径返回有损字符串，并统一为正斜杠；不做 canonicalize。
fn relative_string(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

// 通过根内制品路径校验读取创建时间，路径或元数据失败返回零。
fn file_created_ms_from_path(root: &Path, relative: &str) -> i64 {
    safe_artifact_path(root, relative)
        .ok()
        .and_then(|path| path.metadata().ok())
        .map(|metadata| file_created_ms(&metadata))
        .unwrap_or_default()
}

// 通过根内制品路径校验读取修改时间，路径或元数据失败返回零。
fn file_modified_ms_from_path(root: &Path, relative: &str) -> i64 {
    safe_artifact_path(root, relative)
        .ok()
        .and_then(|path| path.metadata().ok())
        .map(|metadata| file_modified_ms(&metadata))
        .unwrap_or_default()
}

// 优先创建时间、不可用则修改时间，转换为纪元毫秒；失败或纪元前时间返回零。
fn file_created_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .created()
        .or_else(|_| metadata.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

// 将修改时间转换为纪元毫秒，缺失或纪元前时间返回零。
fn file_modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

// 将修改时间转换为纪元纳秒用于变化判定，失败或纪元前时间返回零。
fn file_modified_ns(metadata: &fs::Metadata) -> i128 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos() as i128)
        .unwrap_or_default()
}

#[cfg(unix)]
// Unix 使用设备号和 inode 组成文件身份，便于区分替换与追加。
fn file_id(metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
// 非 Unix 用长度和修改时间近似文件身份；内容追加也可能改变该身份。
fn file_id(metadata: &fs::Metadata) -> String {
    format!("{}:{}", metadata.len(), file_modified_ns(metadata))
}

// 对操作系统编码的路径字节计算 SHA-256，不先规范化路径。
fn hash_path(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_os_str().as_encoded_bytes());
    format!("{:x}", hasher.finalize())
}

// 对 UTF-8 文本计算小写十六进制 SHA-256。
fn hash_text(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

// 以 NUL 分隔机器、SSH 用户、来源和根哈希再计算带 ssh- 前缀的稳定源身份，不包含安装 ID。
fn remote_source_instance_id(
    remote_machine_id: &str,
    ssh_user: &str,
    source: &str,
    config_root_hash: &str,
) -> String {
    format!(
        "ssh-{}",
        hash_text(&format!(
            "{remote_machine_id}\0{ssh_user}\0{source}\0{config_root_hash}"
        ))
    )
}

// 将路径有损转换为报告字符串，不执行合法性或范围检查。
fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

// 返回当前 Unix 纪元毫秒，系统时间早于纪元时回退零。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(unix)]
// Unix 将索引或锁目录权限设置为 0700，失败返回权限错误。
fn set_dir_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "history_index_permissions_failed".to_string())
}

#[cfg(not(unix))]
// 非 Unix 不设置目录权限，直接返回成功。
fn set_dir_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
// Unix 将已发布索引文件权限设置为 0600，失败返回权限错误。
fn set_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "history_index_permissions_failed".to_string())
}

#[cfg(not(unix))]
// 非 Unix 不设置文件权限，直接返回成功。
fn set_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests;
