//! 项目领域的存储记录与只读仓储，字段保持前端数据库契约。
use std::collections::{HashMap, HashSet};

use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub icon: String,
    pub color: String,
    pub bound_path: String,
    pub created_at: String,
}

/// 保留字符串枚举原值，避免新旧宿主并行时丢失未来版本字段值。
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub path_mode: String,
    pub group_name: String,
    pub group_id: Option<String>,
    pub sort_order: i64,
    pub cli_tool: String,
    pub cli_args: String,
    pub startup_cmd: String,
    pub env_vars: String,
    pub shell: String,
    pub provider_overrides: String,
    pub worktree_strategy: String,
    pub worktree_root: String,
    pub worktree_deps_prompt_enabled: i64,
    pub environment_type: String,
    pub ssh_host_id: Option<String>,
    pub remote_path: String,
    pub cli_config_root: String,
    pub icon: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub branch: String,
    pub path: String,
    pub base_branch: String,
    pub deps_prompt_dismissed: i64,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct SessionMeta {
    pub session_key: String,
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub file_path: String,
    pub alias: String,
    pub starred: i64,
    pub tags_json: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct FavoriteSnapshot {
    pub session_key: String,
    pub session_id: String,
    pub source: String,
    pub project_key: String,
    pub file_path: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
    pub branch: Option<String>,
    pub detail_json: String,
    pub snapshot_at: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, FromRow)]
pub struct RequestLogSummary {
    pub request_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct RequestLogBreakdown {
    pub source: String,
    pub model: String,
    pub request_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct RequestLogEntry {
    pub source: String,
    pub session_id: String,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, FromRow)]
pub struct ProjectEfficiency {
    pub request_count: i64,
    pub completed_count: i64,
    pub total_tokens: i64,
    pub average_duration_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectSnapshot {
    pub groups: Vec<Group>,
    pub projects: Vec<Project>,
    pub worktrees: Vec<Worktree>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectTreeRow {
    pub id: String,
    pub label: String,
    pub group: bool,
    pub depth: usize,
}

impl ProjectSnapshot {
    /// 按分组在前、项目在后的深度优先顺序生成树，循环和孤立节点各显示一次。
    pub fn tree_rows(&self) -> Vec<ProjectTreeRow> {
        let known: HashSet<_> = self.groups.iter().map(|group| group.id.as_str()).collect();
        let mut levels: HashMap<Option<&str>, Vec<(i64, &str, bool, &str)>> = HashMap::new();
        for group in &self.groups {
            let parent = group.parent_id.as_deref().filter(|id| known.contains(id));
            levels.entry(parent).or_default().push((
                group.sort_order,
                &group.name,
                true,
                &group.id,
            ));
        }
        for project in &self.projects {
            let parent = project.group_id.as_deref().filter(|id| known.contains(id));
            levels.entry(parent).or_default().push((
                project.sort_order,
                &project.name,
                false,
                &project.id,
            ));
        }
        for values in levels.values_mut() {
            values.sort_by(|a, b| {
                b.2.cmp(&a.2)
                    .then(a.0.cmp(&b.0))
                    .then(a.1.cmp(b.1))
                    .then(a.3.cmp(b.3))
            });
        }
        let mut rows = Vec::new();
        let mut seen = HashSet::new();
        let mut pending = Vec::new();
        if let Some(roots) = levels.get(&None) {
            pending.extend(roots.iter().rev().map(|item| (*item, 0)));
        }
        // 无根循环不会出现在根层；作为最后一批根遍历，保证数据仍可见。
        let mut remaining: Vec<_> = self.groups.iter().collect();
        remaining.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then(a.name.cmp(&b.name))
                .then(a.id.cmp(&b.id))
        });
        let mut remaining = remaining.into_iter();
        loop {
            if pending.is_empty() {
                match remaining.find(|group| !seen.contains(&(true, group.id.as_str()))) {
                    Some(group) => {
                        pending.push(((group.sort_order, &group.name, true, &group.id), 0))
                    }
                    None => break,
                }
            }
            let ((_, label, group, id), depth) = pending.pop().unwrap();
            if !seen.insert((group, id)) {
                continue;
            }
            rows.push(ProjectTreeRow {
                id: id.into(),
                label: label.into(),
                group,
                depth,
            });
            if group {
                if let Some(children) = levels.get(&Some(id)) {
                    pending.extend(children.iter().rev().map(|item| (*item, depth + 1)));
                }
            }
        }
        rows
    }

    /// 与 groupPath.ts 相同：最近非空绑定优先；循环或缺失父组时停止。
    pub fn group_bound_path(&self, group_id: Option<&str>) -> Option<&str> {
        let groups: HashMap<_, _> = self.groups.iter().map(|g| (g.id.as_str(), g)).collect();
        let mut visited = HashSet::new();
        let mut current = group_id;
        while let Some(id) = current.filter(|id| !id.is_empty()) {
            if !visited.insert(id) {
                break;
            }
            let group = groups.get(id)?;
            let path = group.bound_path.trim();
            if !path.is_empty() {
                return Some(path);
            }
            current = group.parent_id.as_deref();
        }
        None
    }

    pub fn project_path<'a>(&'a self, project: &'a Project) -> &'a str {
        if project.path_mode == "inherit" {
            self.group_bound_path(project.group_id.as_deref())
                .unwrap_or(&project.path)
        } else {
            &project.path
        }
    }
}

#[derive(Clone)]
pub struct ProjectRepo {
    reader: SqlitePool,
}

impl ProjectRepo {
    /// 读取现有库，不建库、不迁移、不改变其 journal 配置。
    pub async fn open_read_only(path: impl AsRef<std::path::Path>) -> Result<Self, sqlx::Error> {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(std::time::Duration::from_secs(5));
        let reader = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        Ok(Self::new(reader))
    }

    pub fn new(reader: SqlitePool) -> Self {
        Self { reader }
    }

    pub fn reader(&self) -> &SqlitePool {
        &self.reader
    }

    pub async fn close(&self) {
        self.reader.close().await;
    }

    pub async fn list_projects(&self) -> Result<Vec<Project>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM projects ORDER BY sort_order, name")
            .fetch_all(&self.reader)
            .await
    }

    pub async fn list_groups(&self) -> Result<Vec<Group>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM groups ORDER BY sort_order, name")
            .fetch_all(&self.reader)
            .await
    }

    /// 同一读事务读取两张表，避免并行宿主移动项目时读到不同版本的关系。
    pub async fn snapshot(&self) -> Result<ProjectSnapshot, sqlx::Error> {
        let mut transaction = self.reader.begin().await?;
        let groups = sqlx::query_as("SELECT * FROM groups ORDER BY sort_order, name")
            .fetch_all(&mut *transaction)
            .await?;
        let projects = sqlx::query_as("SELECT * FROM projects ORDER BY sort_order, name")
            .fetch_all(&mut *transaction)
            .await?;
        let worktrees = sqlx::query_as(
            "SELECT id, project_id, name, branch, path, base_branch, deps_prompt_dismissed, status, created_at, updated_at FROM worktrees ORDER BY project_id, name",
        )
        .fetch_all(&mut *transaction)
        .await
        .unwrap_or_default();
        transaction.commit().await?;
        Ok(ProjectSnapshot {
            groups,
            projects,
            worktrees,
        })
    }

    pub async fn find_project(&self, id: &str) -> Result<Option<Project>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM projects WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.reader)
            .await
    }

    pub async fn list_session_meta(&self) -> Result<Vec<SessionMeta>, sqlx::Error> {
        sqlx::query_as(
            "SELECT session_key, session_id, source, project_key, file_path, alias, starred, tags_json, updated_at FROM session_meta ORDER BY updated_at DESC",
        )
        .fetch_all(&self.reader)
        .await
    }

    pub async fn list_favorite_snapshots(&self) -> Result<Vec<FavoriteSnapshot>, sqlx::Error> {
        sqlx::query_as(
            "SELECT s.session_key, s.session_id, s.source, s.project_key, s.file_path, s.title, s.created_at, s.updated_at, s.message_count, s.branch, s.detail_json, s.snapshot_at FROM session_favorite_snapshots s INNER JOIN session_meta m ON m.session_key = s.session_key WHERE m.starred = 1 ORDER BY s.updated_at DESC",
        )
        .fetch_all(&self.reader)
        .await
    }

    pub async fn request_log_summary(
        &self,
        project_key: &str,
    ) -> Result<RequestLogSummary, sqlx::Error> {
        self.request_log_summary_filtered(Some(project_key), None, None).await
    }

    pub async fn request_log_summary_filtered(
        &self,
        project_key: Option<&str>,
        source: Option<&str>,
        since_ms: Option<i64>,
    ) -> Result<RequestLogSummary, sqlx::Error> {
        sqlx::query_as(
            concat!(
                "SELECT COUNT(*) AS request_count, ",
                "COALESCE(SUM(input_tokens), 0) AS input_tokens, ",
                "COALESCE(SUM(output_tokens), 0) AS output_tokens, ",
                "COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, ",
                "COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens ",
                "FROM request_logs WHERE (?1 IS NULL OR (",
                "replace(project_key, char(92), '/') = replace(?1, char(92), '/') ",
                "OR replace(file_path, char(92), '/') = replace(?1, char(92), '/') ",
                "OR replace(file_path, char(92), '/') LIKE ",
                "replace(?1, char(92), '/') || '/%')) ",
                "AND (?2 IS NULL OR source = ?2) AND (?3 IS NULL OR timestamp_ms >= ?3)"
            ),
        )
        .bind(project_key)
        .bind(source)
        .bind(since_ms)
        .fetch_one(&self.reader)
        .await
    }

    pub async fn request_log_breakdown(
        &self,
        project_key: &str,
    ) -> Result<Vec<RequestLogBreakdown>, sqlx::Error> {
        self.request_log_breakdown_filtered(Some(project_key), None, None).await
    }

    pub async fn request_log_breakdown_filtered(
        &self,
        project_key: Option<&str>,
        source: Option<&str>,
        since_ms: Option<i64>,
    ) -> Result<Vec<RequestLogBreakdown>, sqlx::Error> {
        sqlx::query_as(
            concat!(
                "SELECT source, COALESCE(model, '') AS model, ",
                "COUNT(*) AS request_count, ",
                "COALESCE(SUM(input_tokens), 0) AS input_tokens, ",
                "COALESCE(SUM(output_tokens), 0) AS output_tokens ",
                "FROM request_logs WHERE (?1 IS NULL OR (",
                "replace(project_key, char(92), '/') = replace(?1, char(92), '/') ",
                "OR replace(file_path, char(92), '/') = replace(?1, char(92), '/') ",
                "OR replace(file_path, char(92), '/') LIKE ",
                "replace(?1, char(92), '/') || '/%')) ",
                "AND (?2 IS NULL OR source = ?2) AND (?3 IS NULL OR timestamp_ms >= ?3) ",
                "GROUP BY source, model ORDER BY request_count DESC, source, model LIMIT 12"
            ),
        )
        .bind(project_key)
        .bind(source)
        .bind(since_ms)
        .fetch_all(&self.reader)
        .await
    }

    pub async fn request_log_entries(
        &self,
        project_key: &str,
    ) -> Result<Vec<RequestLogEntry>, sqlx::Error> {
        self.request_log_entries_filtered(Some(project_key), None, None).await
    }

    pub async fn request_log_entries_filtered(
        &self,
        project_key: Option<&str>,
        source: Option<&str>,
        since_ms: Option<i64>,
    ) -> Result<Vec<RequestLogEntry>, sqlx::Error> {
        sqlx::query_as(
            concat!(
                "SELECT source, session_id, model, input_tokens, output_tokens, ",
                "cache_read_tokens, cache_creation_tokens, timestamp_ms ",
                "FROM request_logs WHERE (?1 IS NULL OR (",
                "replace(project_key, char(92), '/') = replace(?1, char(92), '/') ",
                "OR replace(file_path, char(92), '/') = replace(?1, char(92), '/') ",
                "OR replace(file_path, char(92), '/') LIKE ",
                "replace(?1, char(92), '/') || '/%')) ",
                "AND (?2 IS NULL OR source = ?2) AND (?3 IS NULL OR timestamp_ms >= ?3) ",
                "ORDER BY timestamp_ms DESC LIMIT 50"
            ),
        )
        .bind(project_key)
        .bind(source)
        .bind(since_ms)
        .fetch_all(&self.reader)
        .await
    }

    pub async fn project_efficiency(
        &self,
        project_key: &str,
    ) -> Result<ProjectEfficiency, sqlx::Error> {
        self.project_efficiency_filtered(Some(project_key), None, None).await
    }

    pub async fn project_efficiency_filtered(
        &self,
        project_key: Option<&str>,
        source: Option<&str>,
        since_ms: Option<i64>,
    ) -> Result<ProjectEfficiency, sqlx::Error> {
        sqlx::query_as(
            concat!(
                "SELECT COUNT(*) AS request_count, ",
                "COALESCE(SUM(CASE WHEN usage_status IN ('complete', 'partial') ",
                "THEN 1 ELSE 0 END), 0) AS completed_count, ",
                "COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS total_tokens, ",
                "CAST(COALESCE(AVG(NULLIF(duration_ms, 0)), 0) AS INTEGER) AS average_duration_ms ",
                "FROM usage_records WHERE (?1 IS NULL OR (",
                "replace(project_key, char(92), '/') = replace(?1, char(92), '/') ",
                "OR replace(project_path, char(92), '/') = replace(?1, char(92), '/') ",
                "OR replace(project_path, char(92), '/') LIKE replace(?1, char(92), '/') || '/%')) ",
                "AND (?2 IS NULL OR source = ?2) AND (?3 IS NULL OR started_at_ms >= ?3)"
            ),
        )
        .bind(project_key)
        .bind(source)
        .bind(since_ms)
        .fetch_one(&self.reader)
        .await
    }
}
