use super::super::*;
use super::{
    catalog_path_within_roots, open_catalog, seed_from_legacy_if_empty, CATALOG_SEARCH_MIN_CHARS,
};
use log::warn;
use sqlx::sqlite::SqliteRow;
use sqlx::{QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::HashSet;

pub(super) fn project_candidates(project_path: &str) -> (Vec<String>, Vec<String>, Option<String>) {
    let target = normalize_history_path(project_path);
    let mut cwd_candidates = vec![target.clone()];
    if let Some(wsl) = crate::wsl::windows_path_to_wsl(&target) {
        cwd_candidates.push(normalize_history_path(&wsl));
    }
    if let Some((_distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&target) {
        cwd_candidates.push(normalize_history_path(&linux_path));
    }
    cwd_candidates.sort();
    cwd_candidates.dedup();

    let mut claude_keys: Vec<String> = cwd_candidates
        .iter()
        .map(|candidate| claude_project_key_from_path(candidate))
        .collect();
    claude_keys.sort();
    claude_keys.dedup();
    let basename = target
        .trim_end_matches('/')
        .rsplit('/')
        .find(|part| !part.is_empty())
        .map(str::to_lowercase);
    (cwd_candidates, claude_keys, basename)
}

pub(super) fn push_project_filter(builder: &mut QueryBuilder<'_, Sqlite>, project_path: &str) {
    let (cwd_candidates, claude_keys, basename) = project_candidates(project_path);
    builder.push(" AND (");
    if !claude_keys.is_empty() {
        builder.push("(s.source = 'claude' AND lower(s.project_key) IN (");
        let mut separated = builder.separated(", ");
        for key in claude_keys {
            separated.push_bind(key);
        }
        separated.push_unseparated("))");
    } else {
        builder.push("0");
    }
    for candidate in cwd_candidates {
        builder.push(" OR s.cwd_normalized = ");
        builder.push_bind(candidate.clone());
        builder.push(" OR s.cwd_normalized LIKE ");
        builder.push_bind(format!("{candidate}/%"));
    }
    if let Some(basename) = basename {
        builder.push(
            " OR (s.source IN ('codex', 'pi') AND s.cwd_normalized IS NULL AND lower(s.project_key) = ",
        );
        builder.push_bind(basename.clone());
        builder.push(")");
        builder.push(" OR (s.source = 'pi' AND lower(s.project_key) = ");
        builder.push_bind(basename);
        builder.push(")");
    }
    builder.push(")");
}

pub(super) fn merge_fetch_limit(limit: Option<usize>, offset: Option<usize>) -> Option<usize> {
    limit.map(|value| value.saturating_add(offset.unwrap_or(0)))
}

pub(super) fn session_summary_from_row(row: SqliteRow) -> Result<HistorySessionSummary, String> {
    Ok(HistorySessionSummary {
        session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
        source: row.try_get("source").map_err(|err| err.to_string())?,
        project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
        title: row.try_get("title").map_err(|err| err.to_string())?,
        file_path: row.try_get("file_path").map_err(|err| err.to_string())?,
        cwd: row.try_get("cwd").map_err(|err| err.to_string())?,
        created_at: row.try_get("created_at").map_err(|err| err.to_string())?,
        updated_at: row.try_get("updated_at").map_err(|err| err.to_string())?,
        message_count: row
            .try_get::<i64, _>("message_count")
            .map_err(|err| err.to_string())?
            .max(0) as usize,
        branch: row.try_get("branch").map_err(|err| err.to_string())?,
        parent_session_id: row
            .try_get("parent_session_id")
            .map_err(|err| err.to_string())?,
    })
}

pub(super) fn merge_session_summaries(
    primary: Vec<HistorySessionSummary>,
    fallback: Vec<HistorySessionSummary>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Vec<HistorySessionSummary> {
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    for session in primary.into_iter().chain(fallback) {
        if seen.insert((session.source.clone(), session.file_path.clone())) {
            sessions.push(session);
        }
    }
    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.file_path.cmp(&right.file_path))
    });
    let offset = offset.unwrap_or(0);
    let iter = sessions.into_iter().skip(offset);
    if let Some(limit) = limit {
        iter.take(limit).collect()
    } else {
        iter.collect()
    }
}

pub(super) async fn list_sessions_from_v2(
    conn: &mut SqliteConnection,
    _roots: &HistoryRoots,
    source: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path, s.cwd,
                s.created_at, s.updated_at, s.message_count, s.branch,
                s.parent_session_id
         FROM (
            SELECT hs.source_session_id AS session_id, i.source_id AS source,
                   hs.project_key, hs.title,
                   COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                   hs.cwd, hs.cwd_normalized, hs.created_at, hs.updated_at,
                   hs.message_count, hs.branch, hs.parent_session_id
            FROM history_sessions hs
            JOIN history_source_instances i ON i.id = hs.source_instance_id
            WHERE i.activation_state = 'active' AND hs.parse_status = 'ok'
         ) s WHERE 1 = 1",
    );
    if let Some(source) = source
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = project_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        push_project_filter(&mut builder, &project_path);
    }
    if let Some(query) = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND (instr(lower(s.title), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.session_id), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.project_key), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.source), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(COALESCE(s.branch, '')), ");
        builder.push_bind(query);
        builder.push(") > 0)");
    }
    builder.push(" ORDER BY s.updated_at DESC, s.file_path ASC LIMIT ");
    builder.push_bind(limit.unwrap_or(usize::MAX).min(i64::MAX as usize) as i64);
    builder.push(" OFFSET ");
    builder.push_bind(offset.unwrap_or(0).min(i64::MAX as usize) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    rows.into_iter()
        .map(session_summary_from_row)
        .collect::<Result<Vec<_>, String>>()
}

pub(super) async fn list_sessions_from_legacy_catalog(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    source: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    let roots_key = roots.cache_key();
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path, s.cwd,
                s.created_at, s.updated_at, s.message_count, s.branch,
                NULL AS parent_session_id
         FROM history_catalog_sessions s WHERE s.roots_key = ",
    );
    builder.push_bind(&roots_key);
    if let Some(source) = source
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = project_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        push_project_filter(&mut builder, &project_path);
    }
    if let Some(query) = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND (instr(lower(s.title), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.session_id), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.project_key), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(s.source), ");
        builder.push_bind(query.clone());
        builder.push(") > 0 OR instr(lower(COALESCE(s.branch, '')), ");
        builder.push_bind(query);
        builder.push(") > 0)");
    }
    builder.push(" ORDER BY s.updated_at DESC, s.file_path ASC LIMIT ");
    builder.push_bind(limit.unwrap_or(usize::MAX).min(i64::MAX as usize) as i64);
    builder.push(" OFFSET ");
    builder.push_bind(offset.unwrap_or(0).min(i64::MAX as usize) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    let sessions = rows
        .into_iter()
        .map(session_summary_from_row)
        .collect::<Result<Vec<_>, String>>()?;
    Ok(sessions
        .into_iter()
        .filter(|session| catalog_path_within_roots(&session.source, &session.file_path, roots))
        .collect())
}

pub(crate) async fn list_sessions(
    roots: &HistoryRoots,
    source: Option<String>,
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<HistorySessionSummary>, String> {
    let mut conn = open_catalog().await?;
    seed_from_legacy_if_empty(&mut conn, roots).await?;
    let fetch_limit = merge_fetch_limit(limit, offset);
    let v2 = list_sessions_from_v2(
        &mut conn,
        roots,
        source.clone(),
        project_path.clone(),
        query.clone(),
        fetch_limit,
        Some(0),
    )
    .await
    .map_err(|err| {
        warn!("history v2 list fallback: {err}");
        err
    })
    .unwrap_or_default();
    let legacy = list_sessions_from_legacy_catalog(
        &mut conn,
        roots,
        source,
        project_path,
        query,
        fetch_limit,
        Some(0),
    )
    .await?;
    let mut sessions = merge_session_summaries(v2, legacy, limit, offset);
    if sessions.iter().any(|session| session.source == "codex") {
        let roots_for_names = roots.clone();
        if let Ok(index) = tokio::task::spawn_blocking(move || {
            super::super::codex_thread_name_index(&roots_for_names)
        })
        .await
        {
            for session in &mut sessions {
                if session.source == "codex" {
                    if let Some(thread_name) = index.names.get(&session.session_id) {
                        session.title = thread_name.clone();
                    }
                }
            }
        }
    }
    Ok(sessions)
}

pub(super) fn fts_literal(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

pub(super) fn fts_trigram_query(query: &str) -> String {
    let chars: Vec<char> = query.chars().collect();
    chars
        .windows(3)
        .map(|trigram| fts_literal(&trigram.iter().collect::<String>()))
        .collect::<Vec<_>>()
        .join(" AND ")
}

pub(super) fn merge_search_results(
    primary: Vec<HistorySearchResult>,
    fallback: Vec<HistorySearchResult>,
    max_hits: usize,
) -> Vec<HistorySearchResult> {
    let mut seen = HashSet::new();
    let mut hits = Vec::new();
    for hit in primary.into_iter().chain(fallback) {
        let key = (
            hit.source.clone(),
            hit.file_path.clone(),
            hit.role.clone(),
            hit.snippet.clone(),
            hit.timestamp.clone(),
        );
        if seen.insert(key) {
            hits.push(hit);
        }
        if hits.len() >= max_hits {
            break;
        }
    }
    hits
}

pub(super) fn search_result_from_legacy_row(row: SqliteRow) -> Result<HistorySearchResult, String> {
    Ok(HistorySearchResult {
        session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
        source: row.try_get("source").map_err(|err| err.to_string())?,
        project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
        title: row.try_get("title").map_err(|err| err.to_string())?,
        file_path: row.try_get("file_path").map_err(|err| err.to_string())?,
        role: row.try_get("role").map_err(|err| err.to_string())?,
        snippet: row.try_get("snippet").map_err(|err| err.to_string())?,
        timestamp: row.try_get("timestamp").map_err(|err| err.to_string())?,
    })
}

pub(super) fn search_result_from_v2_row(row: SqliteRow) -> Result<HistorySearchResult, String> {
    let timestamp_ms = row
        .try_get::<Option<i64>, _>("timestamp_ms")
        .map_err(|err| err.to_string())?;
    Ok(HistorySearchResult {
        session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
        source: row.try_get("source").map_err(|err| err.to_string())?,
        project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
        title: row.try_get("title").map_err(|err| err.to_string())?,
        file_path: row.try_get("file_path").map_err(|err| err.to_string())?,
        role: row.try_get("role").map_err(|err| err.to_string())?,
        snippet: row.try_get("snippet").map_err(|err| err.to_string())?,
        timestamp: timestamp_ms.and_then(timestamp_millis_to_rfc3339),
    })
}

pub(super) async fn search_sessions_from_legacy_catalog(
    conn: &mut SqliteConnection,
    roots: &HistoryRoots,
    normalized: &str,
    source_filter: Option<&str>,
    project_filter: Option<&str>,
    max_hits: usize,
) -> Result<Vec<HistorySearchResult>, String> {
    let roots_key = roots.cache_key();

    let mut session_builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path,
                'sessionId' AS role, s.session_id AS snippet, NULL AS timestamp
         FROM history_catalog_sessions s
         WHERE s.roots_key = ",
    );
    session_builder.push_bind(&roots_key);
    session_builder.push(" AND instr(lower(s.session_id), ");
    session_builder.push_bind(normalized.to_lowercase());
    session_builder.push(") > 0");
    if let Some(source) = source_filter {
        session_builder.push(" AND s.source = ");
        session_builder.push_bind(source);
    }
    if let Some(project_path) = project_filter {
        push_project_filter(&mut session_builder, project_path);
    }
    session_builder.push(" ORDER BY s.updated_at DESC LIMIT ");
    session_builder.push_bind(max_hits as i64);
    let mut hits: Vec<HistorySearchResult> = session_builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?
        .into_iter()
        .map(search_result_from_legacy_row)
        .collect::<Result<Vec<_>, String>>()?;
    hits.retain(|hit| catalog_path_within_roots(&hit.source, &hit.file_path, roots));
    if hits.len() >= max_hits {
        return Ok(hits);
    }

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path,
                m.role, substr(m.content, 1, 240) AS snippet,
                m.timestamp
         FROM history_catalog_messages_fts
         JOIN history_catalog_messages m ON m.id = history_catalog_messages_fts.rowid
         JOIN history_catalog_sessions s
           ON s.roots_key = m.roots_key AND s.file_path = m.file_path
         WHERE history_catalog_messages_fts MATCH (",
    );
    builder.push_bind(fts_trigram_query(normalized));
    builder.push(")");
    builder.push(" AND instr(lower(m.content), lower(");
    builder.push_bind(normalized);
    builder.push(")) > 0");
    builder.push(" AND s.roots_key = ");
    builder.push_bind(&roots_key);
    if let Some(source) = source_filter {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = project_filter {
        push_project_filter(&mut builder, project_path);
    }
    builder.push(" ORDER BY s.updated_at DESC, m.message_index ASC LIMIT ");
    builder.push_bind((max_hits - hits.len()) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    let message_hits = rows
        .into_iter()
        .map(search_result_from_legacy_row)
        .collect::<Result<Vec<_>, String>>()?;
    hits.extend(
        message_hits
            .into_iter()
            .filter(|hit| catalog_path_within_roots(&hit.source, &hit.file_path, roots)),
    );
    Ok(hits)
}

pub(super) async fn search_sessions_from_v2(
    conn: &mut SqliteConnection,
    _roots: &HistoryRoots,
    normalized: &str,
    source_filter: Option<&str>,
    project_filter: Option<&str>,
    max_hits: usize,
) -> Result<Vec<HistorySearchResult>, String> {
    let mut session_builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path,
                'sessionId' AS role, s.session_id AS snippet, NULL AS timestamp_ms
         FROM (
            SELECT hs.id, hs.source_session_id AS session_id, i.source_id AS source,
                   hs.project_key, hs.title,
                   COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                   hs.cwd_normalized, hs.updated_at
            FROM history_sessions hs
            JOIN history_source_instances i ON i.id = hs.source_instance_id
            WHERE i.activation_state = 'active' AND hs.parse_status = 'ok'
         ) s
         WHERE instr(lower(s.session_id), ",
    );
    session_builder.push_bind(normalized.to_lowercase());
    session_builder.push(") > 0");
    if let Some(source) = source_filter {
        session_builder.push(" AND s.source = ");
        session_builder.push_bind(source);
    }
    if let Some(project_path) = project_filter {
        push_project_filter(&mut session_builder, project_path);
    }
    session_builder.push(" ORDER BY s.updated_at DESC LIMIT ");
    session_builder.push_bind(max_hits as i64);

    let mut hits: Vec<HistorySearchResult> = session_builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?
        .into_iter()
        .map(search_result_from_v2_row)
        .collect::<Result<Vec<_>, String>>()?;
    if hits.len() >= max_hits {
        return Ok(hits);
    }

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT s.session_id, s.source, s.project_key, s.title, s.file_path,
                m.role, substr(m.display_content, 1, 240) AS snippet,
                m.timestamp_ms
         FROM history_messages_fts
         JOIN history_messages m ON m.id = history_messages_fts.rowid
         JOIN (
            SELECT hs.id, hs.source_session_id AS session_id, i.source_id AS source,
                   hs.project_key, hs.title,
                   COALESCE(hs.primary_path, hs.database_path, hs.raw_key, hs.source_session_id) AS file_path,
                   hs.cwd_normalized, hs.updated_at
            FROM history_sessions hs
            JOIN history_source_instances i ON i.id = hs.source_instance_id
            WHERE i.activation_state = 'active' AND hs.parse_status = 'ok'
         ) s ON s.id = m.session_id
         WHERE history_messages_fts MATCH (",
    );
    builder.push_bind(fts_trigram_query(normalized));
    builder.push(")");
    builder.push(" AND instr(lower(m.display_content), lower(");
    builder.push_bind(normalized);
    builder.push(")) > 0");
    if let Some(source) = source_filter {
        builder.push(" AND s.source = ");
        builder.push_bind(source);
    }
    if let Some(project_path) = project_filter {
        push_project_filter(&mut builder, project_path);
    }
    builder.push(" ORDER BY s.updated_at DESC, m.message_index ASC LIMIT ");
    builder.push_bind((max_hits - hits.len()) as i64);

    let rows = builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    let message_hits = rows
        .into_iter()
        .map(search_result_from_v2_row)
        .collect::<Result<Vec<_>, String>>()?;
    hits.extend(message_hits);
    Ok(hits)
}

pub(crate) async fn search_sessions(
    roots: &HistoryRoots,
    query: &str,
    source: Option<String>,
    project_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistorySearchResult>, String> {
    let normalized = query.trim();
    if normalized.chars().count() < CATALOG_SEARCH_MIN_CHARS {
        return Ok(Vec::new());
    }
    let mut conn = open_catalog().await?;
    seed_from_legacy_if_empty(&mut conn, roots).await?;
    let max_hits = limit.unwrap_or(100).max(1).min(i64::MAX as usize);
    let source_filter = source
        .as_deref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let project_filter = project_path
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let v2 = search_sessions_from_v2(
        &mut conn,
        roots,
        normalized,
        source_filter.as_deref(),
        project_filter.as_deref(),
        max_hits,
    )
    .await
    .map_err(|err| {
        warn!("history v2 search fallback: {err}");
        err
    })
    .unwrap_or_default();
    let legacy = search_sessions_from_legacy_catalog(
        &mut conn,
        roots,
        normalized,
        source_filter.as_deref(),
        project_filter.as_deref(),
        max_hits,
    )
    .await?;
    let mut hits = merge_search_results(v2, legacy, max_hits);
    if hits.iter().any(|hit| hit.source == "codex") {
        let roots_for_names = roots.clone();
        if let Ok(index) = tokio::task::spawn_blocking(move || {
            super::super::codex_thread_name_index(&roots_for_names)
        })
        .await
        {
            for hit in &mut hits {
                if hit.source == "codex" {
                    if let Some(thread_name) = index.names.get(&hit.session_id) {
                        hit.title = thread_name.clone();
                    }
                }
            }
        }
    }
    Ok(hits)
}
