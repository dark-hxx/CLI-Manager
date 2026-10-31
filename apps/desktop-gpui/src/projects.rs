use cli_manager_core_db::projects::{ProjectRepo, ProjectSnapshot, ProjectTreeRow};
use std::path::PathBuf;

/// 此阶段只读取显式选定的现有库，禁止隐式创建、修复或迁移用户库。
pub async fn load(path: PathBuf) -> Result<ProjectSnapshot, String> {
    let repo = ProjectRepo::open_read_only(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = repo.snapshot().await.map_err(|error| error.to_string());
    repo.close().await;
    result
}

pub async fn load_session_meta(
    path: PathBuf,
) -> Result<Vec<cli_manager_core_db::projects::SessionMeta>, String> {
    let repo = ProjectRepo::open_read_only(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = repo
        .list_session_meta()
        .await
        .map_err(|error| error.to_string());
    repo.close().await;
    result
}

pub async fn load_favorite_snapshots(
    path: PathBuf,
) -> Result<Vec<cli_manager_core_db::projects::FavoriteSnapshot>, String> {
    let repo = ProjectRepo::open_read_only(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = repo
        .list_favorite_snapshots()
        .await
        .map_err(|error| error.to_string());
    repo.close().await;
    result
}

pub async fn load_extension_overview(
    path: PathBuf,
) -> Result<Vec<cli_manager_core_db::extensions::ExtensionOverview>, String> {
    let repo = ProjectRepo::open_read_only(path)
        .await
        .map_err(|error| error.to_string())?;
    let result = cli_manager_core_db::extensions::list_extension_overview(repo.reader())
        .await
        .map_err(|error| error.to_string());
    repo.close().await;
    result
}

pub async fn delete_mcp_extension(path: PathBuf, resource_id: String) -> Result<(), String> {
    cli_manager_core_db::extensions::delete_mcp_resource(path, resource_id).await
}

pub async fn set_mcp_extension_enabled(
    path: PathBuf,
    resource_id: String,
    cli: String,
    enabled: bool,
) -> Result<(), String> {
    cli_manager_core_db::extensions::set_mcp_enabled(path, resource_id, cli, enabled).await
}

pub async fn rename_mcp_extension(
    path: PathBuf,
    resource_id: String,
    name: String,
) -> Result<(), String> {
    cli_manager_core_db::extensions::rename_mcp_resource(path, resource_id, name).await
}

fn filter_since_ms(filter: crate::history::TimeFilter) -> Option<i64> {
    let days = match filter {
        crate::history::TimeFilter::All => return None,
        crate::history::TimeFilter::Recent7 => 7,
        crate::history::TimeFilter::Recent30 => 30,
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    Some(now.saturating_sub(days * 24 * 60 * 60 * 1000))
}

pub async fn load_request_log_filtered(
    path: PathBuf,
    project_key: String,
    source: crate::history::SourceFilter,
    time_filter: crate::history::TimeFilter,
) -> Result<
    (
        cli_manager_core_db::projects::RequestLogSummary,
        Vec<cli_manager_core_db::projects::RequestLogBreakdown>,
        Vec<cli_manager_core_db::projects::RequestLogEntry>,
        cli_manager_core_db::projects::ProjectEfficiency,
    ),
    String,
> {
    let repo = ProjectRepo::open_read_only(path)
        .await
        .map_err(|error| error.to_string())?;
    let source = match source {
        crate::history::SourceFilter::All => None,
        crate::history::SourceFilter::Claude => Some("claude"),
        crate::history::SourceFilter::Codex => Some("codex"),
    };
    let since_ms = filter_since_ms(time_filter);
    let project_key = (!project_key.is_empty()).then_some(project_key.as_str());
    let result = tokio::try_join!(
        repo.request_log_summary_filtered(project_key, source, since_ms),
        repo.request_log_breakdown_filtered(project_key, source, since_ms),
        repo.request_log_entries_filtered(project_key, source, since_ms),
        repo.project_efficiency_filtered(project_key, source, since_ms),
    )
    .map_err(|error| error.to_string());
    repo.close().await;
    result
}

#[derive(Debug)]
pub struct LoadedProjects {
    pub snapshot: ProjectSnapshot,
    pub rows: Vec<ProjectTreeRow>,
}

/// 路径/引导文件解析与数据库访问均在 Tokio 工作线程执行。
pub async fn load_current(explicit: Option<PathBuf>) -> Result<LoadedProjects, String> {
    let configured = explicit.is_some();
    let path = explicit
        .map(Ok)
        .unwrap_or_else(crate::paths::database_path)?;
    let snapshot = if !configured && !path.try_exists().map_err(|error| error.to_string())? {
        ProjectSnapshot::default()
    } else {
        load(path).await?
    };
    let rows = snapshot.tree_rows();
    Ok(LoadedProjects { snapshot, rows })
}

#[derive(Default)]
pub enum ProjectLoad {
    #[default]
    Loading,
    Ready(LoadedProjects),
    Failed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cli_manager_core_db::{pool::DbPool, run_migrations};

    #[test]
    fn background_service_loads_existing_projects_without_migrating() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("main.db");
            let pool = DbPool::open(&path).await.unwrap();
            run_migrations(pool.writer()).await.unwrap();
            sqlx::query("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('p', '项目 α', 'C:/project', '', '')").execute(pool.writer()).await.unwrap();
            let snapshot = tokio::spawn(load(path)).await.unwrap().unwrap();
            assert_eq!(snapshot.projects[0].name, "项目 α");
            assert_eq!(snapshot.project_path(&snapshot.projects[0]), "C:/project");
            pool.close().await;
        });
    }

    #[test]
    fn invalid_database_reports_failure_without_creating_a_file() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing.db");
        assert!(runtime.block_on(load(path.clone())).is_err());
        assert!(!path.exists());
        std::fs::write(&path, b"invalid SQLite content").unwrap();
        assert!(runtime.block_on(load(path.clone())).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"invalid SQLite content");
    }
}
