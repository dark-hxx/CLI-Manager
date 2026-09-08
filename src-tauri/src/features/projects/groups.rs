use crate::app_paths;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Connection, Row};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ID_BATCH_SIZE: usize = 8_000;

#[derive(Debug, Clone)]
struct GroupRecord {
    id: String,
    parent_id: Option<String>,
    bound_path: String,
}

#[derive(Debug, Clone)]
struct ProjectRecord {
    id: String,
    group_id: Option<String>,
    path: String,
    path_mode: String,
}

// 返回 Unix 毫秒时间戳文本，系统时间早于纪元时回退为 0。
fn now_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

// 生成指定数量的 SQL 参数占位符，不拼接参数值。
fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

// 修剪文本并拒绝 NUL，错误码携带字段名。
fn validate_text(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.contains('\0') {
        return Err(format!("{field}_contains_nul"));
    }
    Ok(trimmed.to_string())
}

// 打开现有应用数据库，启用 WAL、外键和繁忙等待，不自动创建数据库。
async fn open_database() -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(app_paths::db_path()?)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(DATABASE_BUSY_TIMEOUT);
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("project_group_database_open_failed: {error}"))
}

// 在当前事务中加载分组记录，将空绑定路径统一为修剪后的空字符串。
async fn load_groups(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<GroupRecord>, String> {
    let rows = sqlx::query(
        "SELECT id, parent_id, TRIM(COALESCE(bound_path, '')) AS bound_path FROM groups",
    )
    .fetch_all(&mut **transaction)
    .await
    .map_err(|error| format!("project_group_load_groups_failed: {error}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(GroupRecord {
                id: row
                    .try_get("id")
                    .map_err(|error| format!("project_group_read_group_id_failed: {error}"))?,
                parent_id: row
                    .try_get("parent_id")
                    .map_err(|error| format!("project_group_read_group_parent_failed: {error}"))?,
                bound_path: row
                    .try_get("bound_path")
                    .map_err(|error| format!("project_group_read_group_path_failed: {error}"))?,
            })
        })
        .collect()
}

// 在当前事务中读取项目的分组、路径及路径继承模式。
async fn load_projects(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<ProjectRecord>, String> {
    let rows = sqlx::query("SELECT id, group_id, path, path_mode FROM projects")
        .fetch_all(&mut **transaction)
        .await
        .map_err(|error| format!("project_group_load_projects_failed: {error}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(ProjectRecord {
                id: row
                    .try_get("id")
                    .map_err(|error| format!("project_group_read_project_id_failed: {error}"))?,
                group_id: row
                    .try_get("group_id")
                    .map_err(|error| format!("project_group_read_project_group_failed: {error}"))?,
                path: row
                    .try_get("path")
                    .map_err(|error| format!("project_group_read_project_path_failed: {error}"))?,
                path_mode: row.try_get("path_mode").map_err(|error| {
                    format!("project_group_read_project_path_mode_failed: {error}")
                })?,
            })
        })
        .collect()
}

// 复制分组记录并按 ID 建立查找表。
fn group_map(groups: &[GroupRecord]) -> HashMap<String, GroupRecord> {
    groups
        .iter()
        .cloned()
        .map(|group| (group.id.clone(), group))
        .collect()
}

// 按父分组 ID 建立子节点索引，无父节点归入空键。
fn child_map(groups: &[GroupRecord]) -> HashMap<String, Vec<String>> {
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for group in groups {
        children
            .entry(group.parent_id.clone().unwrap_or_default())
            .or_default()
            .push(group.id.clone());
    }
    children
}

// 遍历指定分组及后代 ID，使用已访问集合避免环导致重复遍历。
fn collect_subtree_ids(group_id: &str, groups: &[GroupRecord]) -> Vec<String> {
    let children = child_map(groups);
    let mut result = Vec::new();
    let mut pending = vec![group_id.to_string()];
    let mut visited = HashSet::new();

    while let Some(current_id) = pending.pop() {
        if !visited.insert(current_id.clone()) {
            continue;
        }
        result.push(current_id.clone());
        pending.extend(children.get(&current_id).into_iter().flatten().cloned());
    }

    result
}

// 沿祖先链查找最近的非空绑定路径，遇到缺失节点或环时结束。
fn resolve_effective_path(
    group_id: &str,
    groups_by_id: &HashMap<String, GroupRecord>,
) -> Option<String> {
    let mut current = Some(group_id.to_string());
    let mut visited = HashSet::new();
    while let Some(current_id) = current {
        if !visited.insert(current_id.clone()) {
            break;
        }
        let group = groups_by_id.get(&current_id)?;
        if !group.bound_path.is_empty() {
            return Some(group.bound_path.clone());
        }
        current = group.parent_id.clone();
    }
    None
}

// 收集根分组及未自行绑定路径的继承后代，独立绑定的分支不再下探。
fn collect_inherited_group_ids(group_id: &str, groups: &[GroupRecord]) -> Vec<String> {
    let groups_by_id = group_map(groups);
    let children = child_map(groups);
    let mut result = Vec::new();
    let mut pending = vec![group_id.to_string()];
    let mut visited = HashSet::new();

    while let Some(current_id) = pending.pop() {
        if !visited.insert(current_id.clone()) {
            continue;
        }
        result.push(current_id.clone());
        for child_id in children.get(&current_id).into_iter().flatten() {
            let Some(child) = groups_by_id.get(child_id) else {
                continue;
            };
            if child.bound_path.is_empty() {
                pending.push(child.id.clone());
            }
        }
    }

    result
}

// 计算子树各分组的有效路径，子节点独立绑定优先，否则继承父路径。
fn effective_paths_for_subtree(
    group_id: &str,
    groups: &[GroupRecord],
) -> HashMap<String, Option<String>> {
    let groups_by_id = group_map(groups);
    let children = child_map(groups);
    let mut result = HashMap::new();
    let Some(root) = groups_by_id.get(group_id) else {
        return result;
    };
    result.insert(
        root.id.clone(),
        resolve_effective_path(&root.id, &groups_by_id),
    );

    let mut pending = vec![root.id.clone()];
    while let Some(parent_id) = pending.pop() {
        let Some(parent_path) = result.get(&parent_id).cloned() else {
            continue;
        };
        for child_id in children.get(&parent_id).into_iter().flatten() {
            if result.contains_key(child_id) {
                continue;
            }
            let Some(child) = groups_by_id.get(child_id) else {
                continue;
            };
            let child_path = if child.bound_path.is_empty() {
                parent_path.clone()
            } else {
                Some(child.bound_path.clone())
            };
            result.insert(child.id.clone(), child_path);
            pending.push(child.id.clone());
        }
    }

    result
}

// 有指定 shell 和项目 ID 时，在当前事务内分批更新 shell 与更新时间。
async fn update_project_shells(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    project_ids: &[String],
    shell: Option<&str>,
) -> Result<(), String> {
    let Some(shell) = shell else {
        return Ok(());
    };
    if project_ids.is_empty() {
        return Ok(());
    }

    let updated_at = now_millis();
    for chunk in project_ids.chunks(MAX_ID_BATCH_SIZE) {
        let sql = format!(
            "UPDATE projects SET shell = ?, updated_at = ? WHERE id IN ({})",
            placeholders(chunk.len())
        );
        let mut query = sqlx::query(&sql).bind(shell).bind(&updated_at);
        for project_id in chunk {
            query = query.bind(project_id);
        }
        query
            .execute(&mut **transaction)
            .await
            .map_err(|error| format!("project_group_update_shell_failed: {error}"))?;
    }
    Ok(())
}

// 在当前事务中保存路径绑定；清空绑定时固化继承路径，shell 更新限于选中的子树项目。
async fn save_group_binding_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    group_id: &str,
    bound_path: &str,
    shell_project_ids: &[String],
    shell: Option<&str>,
) -> Result<(), String> {
    let groups = load_groups(transaction).await?;
    let Some(group) = groups.iter().find(|group| group.id == group_id) else {
        return Ok(());
    };

    let normalized_path = validate_text(bound_path, "bound_path")?;
    let normalized_shell = shell
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    if normalized_shell.is_none() && !shell_project_ids.is_empty() {
        return Err("project_group_shell_missing".to_string());
    }

    if normalized_path.is_empty() && !group.bound_path.is_empty() {
        let inherited_group_ids = collect_inherited_group_ids(group_id, &groups);
        let updated_at = now_millis();
        for chunk in inherited_group_ids.chunks(MAX_ID_BATCH_SIZE) {
            let sql = format!(
                "UPDATE projects
                 SET path = ?, path_mode = 'custom', updated_at = ?
                 WHERE path_mode = 'inherit' AND group_id IN ({})",
                placeholders(chunk.len())
            );
            let mut query = sqlx::query(&sql).bind(&group.bound_path).bind(&updated_at);
            for inherited_group_id in chunk {
                query = query.bind(inherited_group_id);
            }
            query
                .execute(&mut **transaction)
                .await
                .map_err(|error| format!("project_group_materialize_projects_failed: {error}"))?;
        }

        let descendant_group_ids: Vec<String> = inherited_group_ids
            .into_iter()
            .filter(|id| id != group_id)
            .collect();
        for chunk in descendant_group_ids.chunks(MAX_ID_BATCH_SIZE) {
            let sql = format!(
                "UPDATE groups SET bound_path = ? WHERE id IN ({})",
                placeholders(chunk.len())
            );
            let mut query = sqlx::query(&sql).bind(&group.bound_path);
            for descendant_group_id in chunk {
                query = query.bind(descendant_group_id);
            }
            query
                .execute(&mut **transaction)
                .await
                .map_err(|error| format!("project_group_materialize_groups_failed: {error}"))?;
        }
    }

    let scoped_shell_project_ids = if normalized_shell.is_some() && !shell_project_ids.is_empty() {
        let allowed_group_ids = collect_subtree_ids(group_id, &groups);
        let allowed_group_ids: HashSet<&str> =
            allowed_group_ids.iter().map(String::as_str).collect();
        let requested_project_ids: HashSet<&str> =
            shell_project_ids.iter().map(String::as_str).collect();
        load_projects(transaction)
            .await?
            .into_iter()
            .filter(|project| {
                requested_project_ids.contains(project.id.as_str())
                    && project.group_id.as_deref().is_some_and(|project_group_id| {
                        allowed_group_ids.contains(project_group_id)
                    })
            })
            .map(|project| project.id)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    sqlx::query("UPDATE groups SET bound_path = ? WHERE id = ?")
        .bind(&normalized_path)
        .bind(group_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| format!("project_group_update_binding_failed: {error}"))?;

    update_project_shells(transaction, &scoped_shell_project_ids, normalized_shell).await
}

// 在当前事务中固化继承项目的有效路径、解除项目分组，再分批删除整个分组子树。
async fn delete_group_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    group_id: &str,
) -> Result<(), String> {
    let groups = load_groups(transaction).await?;
    if !groups.iter().any(|group| group.id == group_id) {
        return Ok(());
    }

    let subtree_ids = collect_subtree_ids(group_id, &groups);
    let subtree_set: HashSet<&str> = subtree_ids.iter().map(String::as_str).collect();
    let effective_paths = effective_paths_for_subtree(group_id, &groups);
    let projects = load_projects(transaction).await?;
    let subtree_projects: Vec<ProjectRecord> = projects
        .into_iter()
        .filter(|project| {
            project
                .group_id
                .as_deref()
                .is_some_and(|project_group_id| subtree_set.contains(project_group_id))
        })
        .collect();

    for chunk in subtree_projects.chunks(MAX_ID_BATCH_SIZE) {
        let inherited = chunk
            .iter()
            .filter(|project| project.path_mode == "inherit")
            .collect::<Vec<_>>();
        let path_expression = if inherited.is_empty() {
            "path".to_string()
        } else {
            let mut expression = String::from("CASE id ");
            for _ in &inherited {
                expression.push_str("WHEN ? THEN ? ");
            }
            expression.push_str("ELSE path END");
            expression
        };
        let sql = format!(
            "UPDATE projects
             SET path = {path_expression},
                 path_mode = CASE WHEN path_mode = 'inherit' THEN 'custom' ELSE path_mode END,
                 group_id = NULL,
                 updated_at = CASE WHEN path_mode = 'inherit' THEN ? ELSE updated_at END
             WHERE id IN ({})",
            placeholders(chunk.len())
        );
        let mut query = sqlx::query(&sql);
        for project in &inherited {
            let path = project
                .group_id
                .as_deref()
                .and_then(|project_group_id| effective_paths.get(project_group_id))
                .cloned()
                .flatten()
                .unwrap_or_else(|| project.path.clone());
            query = query.bind(&project.id).bind(path);
        }
        query = query.bind(now_millis());
        for project in chunk {
            query = query.bind(&project.id);
        }
        query
            .execute(&mut **transaction)
            .await
            .map_err(|error| format!("project_group_detach_projects_failed: {error}"))?;
    }

    for chunk in subtree_ids.chunks(MAX_ID_BATCH_SIZE) {
        let sql = format!(
            "DELETE FROM groups WHERE id IN ({})",
            placeholders(chunk.len())
        );
        let mut query = sqlx::query(&sql);
        for group_id in chunk {
            query = query.bind(group_id);
        }
        query
            .execute(&mut **transaction)
            .await
            .map_err(|error| format!("project_group_delete_groups_failed: {error}"))?;
    }

    Ok(())
}

#[tauri::command]
// 校验绑定输入并开启事务，将路径与选中项目 shell 的变更一并提交。
pub async fn project_group_save_binding(
    group_id: String,
    bound_path: String,
    shell_project_ids: Vec<String>,
    shell: Option<String>,
) -> Result<(), String> {
    let group_id = validate_text(&group_id, "group_id")?;
    if group_id.is_empty() {
        return Err("project_group_id_missing".to_string());
    }
    let bound_path = validate_text(&bound_path, "bound_path")?;
    let project_ids: Vec<String> = shell_project_ids
        .into_iter()
        .map(|project_id| validate_text(&project_id, "project_id"))
        .collect::<Result<Vec<String>, String>>()?
        .into_iter()
        .filter(|project_id| !project_id.is_empty())
        .collect();
    let shell = shell
        .map(|value| validate_text(&value, "shell"))
        .transpose()?
        .filter(|value| !value.is_empty());
    if shell.is_none() && !project_ids.is_empty() {
        return Err("project_group_shell_missing".to_string());
    }

    let mut connection = open_database().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| format!("project_group_transaction_begin_failed: {error}"))?;
    save_group_binding_in_transaction(
        &mut transaction,
        &group_id,
        &bound_path,
        &project_ids,
        shell.as_deref(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("project_group_transaction_commit_failed: {error}"))
}

#[tauri::command]
// 校验分组 ID，在同一事务中解除项目关联并删除分组子树。
pub async fn project_group_delete(group_id: String) -> Result<(), String> {
    let group_id = validate_text(&group_id, "group_id")?;
    if group_id.is_empty() {
        return Err("project_group_id_missing".to_string());
    }

    let mut connection = open_database().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| format!("project_group_transaction_begin_failed: {error}"))?;
    delete_group_in_transaction(&mut transaction, &group_id).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("project_group_transaction_commit_failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{delete_group_in_transaction, save_group_binding_in_transaction};
    use sqlx::{Connection, Row, SqliteConnection};

    // 创建启用外键的内存数据库，并建立分组和项目测试表。
    async fn test_connection() -> SqliteConnection {
        let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                parent_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
                bound_path TEXT NOT NULL DEFAULT ''
            )",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
                path TEXT NOT NULL,
                path_mode TEXT NOT NULL,
                shell TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    // 向测试连接插入具有指定父节点及绑定路径的分组。
    async fn insert_group(
        connection: &mut SqliteConnection,
        id: &str,
        parent_id: Option<&str>,
        bound_path: &str,
    ) {
        sqlx::query("INSERT INTO groups (id, parent_id, bound_path) VALUES (?, ?, ?)")
            .bind(id)
            .bind(parent_id)
            .bind(bound_path)
            .execute(connection)
            .await
            .unwrap();
    }

    // 向测试连接插入项目路径模式，并使用固定 shell 与更新时间。
    async fn insert_project(
        connection: &mut SqliteConnection,
        id: &str,
        group_id: Option<&str>,
        path: &str,
        path_mode: &str,
    ) {
        sqlx::query(
            "INSERT INTO projects (id, group_id, path, path_mode, shell, updated_at)
             VALUES (?, ?, ?, ?, 'powershell', '1')",
        )
        .bind(id)
        .bind(group_id)
        .bind(path)
        .bind(path_mode)
        .execute(connection)
        .await
        .unwrap();
    }

    #[tokio::test]
    // 验证清空绑定只固化继承分支，并将 shell 更新限制在指定子树项目。
    async fn clearing_binding_materializes_direct_and_inherited_descendants() {
        let mut connection = test_connection().await;
        insert_group(&mut connection, "root", None, "D:/root").await;
        insert_group(&mut connection, "child", Some("root"), "").await;
        insert_group(&mut connection, "deep", Some("child"), "").await;
        insert_group(&mut connection, "boundary", Some("child"), "D:/other").await;
        insert_group(&mut connection, "boundary-child", Some("boundary"), "").await;
        insert_group(&mut connection, "unrelated", None, "D:/unrelated").await;
        insert_project(
            &mut connection,
            "direct",
            Some("root"),
            "D:/stale",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "child-project",
            Some("child"),
            "D:/stale",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "deep-project",
            Some("deep"),
            "D:/stale",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "boundary-project",
            Some("boundary"),
            "D:/other",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "boundary-child-project",
            Some("boundary-child"),
            "D:/other",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "unrelated-project",
            Some("unrelated"),
            "D:/unrelated",
            "custom",
        )
        .await;

        let mut transaction = connection.begin().await.unwrap();
        save_group_binding_in_transaction(
            &mut transaction,
            "root",
            "",
            &[
                "direct".to_string(),
                "child-project".to_string(),
                "boundary-project".to_string(),
                "unrelated-project".to_string(),
            ],
            Some("pwsh"),
        )
        .await
        .unwrap();
        transaction.commit().await.unwrap();

        let root_path: String =
            sqlx::query_scalar("SELECT bound_path FROM groups WHERE id = 'root'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(root_path, "");
        let child_path: String =
            sqlx::query_scalar("SELECT bound_path FROM groups WHERE id = 'child'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let deep_path: String =
            sqlx::query_scalar("SELECT bound_path FROM groups WHERE id = 'deep'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let boundary_path: String =
            sqlx::query_scalar("SELECT bound_path FROM groups WHERE id = 'boundary'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(child_path, "D:/root");
        assert_eq!(deep_path, "D:/root");
        assert_eq!(boundary_path, "D:/other");

        for project_id in ["direct", "child-project", "deep-project"] {
            let row = sqlx::query("SELECT path, path_mode FROM projects WHERE id = ?")
                .bind(project_id)
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(row.get::<String, _>("path"), "D:/root");
            assert_eq!(row.get::<String, _>("path_mode"), "custom");
        }
        let boundary_mode: String =
            sqlx::query_scalar("SELECT path_mode FROM projects WHERE id = 'boundary-project'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(boundary_mode, "inherit");
        let selected_shell: String =
            sqlx::query_scalar("SELECT shell FROM projects WHERE id = 'boundary-project'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(selected_shell, "pwsh");
        let unrelated_shell: String =
            sqlx::query_scalar("SELECT shell FROM projects WHERE id = 'unrelated-project'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(unrelated_shell, "powershell");
    }

    #[tokio::test]
    // 验证删除分组前固化有效路径，保留项目并解除分组关联。
    async fn deleting_group_materializes_paths_before_detaching_projects() {
        let mut connection = test_connection().await;
        insert_group(&mut connection, "root", None, "D:/root").await;
        insert_group(&mut connection, "child", Some("root"), "").await;
        insert_group(&mut connection, "deep", Some("child"), "").await;
        insert_group(&mut connection, "boundary", Some("child"), "D:/other").await;
        insert_group(&mut connection, "boundary-child", Some("boundary"), "").await;
        insert_group(&mut connection, "unrelated", None, "D:/unrelated").await;
        insert_project(
            &mut connection,
            "direct",
            Some("root"),
            "D:/stale",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "child-project",
            Some("child"),
            "D:/stale",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "deep-project",
            Some("deep"),
            "D:/stale",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "boundary-project",
            Some("boundary"),
            "D:/other",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "boundary-child-project",
            Some("boundary-child"),
            "D:/other",
            "inherit",
        )
        .await;
        insert_project(
            &mut connection,
            "custom-project",
            Some("child"),
            "D:/custom",
            "custom",
        )
        .await;

        let mut transaction = connection.begin().await.unwrap();
        delete_group_in_transaction(&mut transaction, "root")
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        let remaining_groups: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM groups WHERE id IN ('root', 'child', 'deep', 'boundary', 'boundary-child')",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(remaining_groups, 0);

        for (project_id, expected_path) in [
            ("direct", "D:/root"),
            ("child-project", "D:/root"),
            ("deep-project", "D:/root"),
            ("boundary-project", "D:/other"),
            ("boundary-child-project", "D:/other"),
            ("custom-project", "D:/custom"),
        ] {
            let row = sqlx::query("SELECT group_id, path, path_mode FROM projects WHERE id = ?")
                .bind(project_id)
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(row.get::<Option<String>, _>("group_id"), None);
            assert_eq!(row.get::<String, _>("path"), expected_path);
            assert_eq!(row.get::<String, _>("path_mode"), "custom");
        }
    }
}
