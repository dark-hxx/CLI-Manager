use super::{
    cc_connect_agent_from_cli_tool, single_line, CcConnectAgent, CcConnectProfile, ProviderCatalog,
    ProviderCatalogEntry, RegisteredGroup, RegisteredGroupSegment, RegisteredProject,
    RegisteredProjectRow,
};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

// 读取本机 Claude/Codex Provider 名称和当前项，失败返回空目录。
pub(super) async fn load_provider_catalog() -> ProviderCatalog {
    let Ok(mut connection) = crate::provider::open_connection().await else {
        return ProviderCatalog::default();
    };
    let rows = sqlx::query(
        "SELECT id, app_type, name, is_current FROM providers \
         WHERE app_type IN ('claude', 'codex') \
         ORDER BY app_type ASC, sort_index ASC, name COLLATE NOCASE ASC",
    )
    .fetch_all(&mut connection)
    .await;
    let _ = connection.close().await;
    let Ok(rows) = rows else {
        return ProviderCatalog::default();
    };

    let mut catalog = ProviderCatalog::default();
    for row in rows {
        let (Ok(id), Ok(app_type), Ok(name), Ok(is_current)) = (
            row.try_get::<String, _>("id"),
            row.try_get::<String, _>("app_type"),
            row.try_get::<String, _>("name"),
            row.try_get::<bool, _>("is_current"),
        ) else {
            continue;
        };
        let app_type = app_type.trim().to_ascii_lowercase();
        let name = single_line(&name);
        if app_type.is_empty() || id.trim().is_empty() || name.is_empty() {
            continue;
        }
        catalog
            .names_by_app_and_id
            .insert((app_type.clone(), id.trim().to_string()), name.clone());
        if is_current {
            catalog
                .current_by_app
                .entry(app_type)
                .or_insert(ProviderCatalogEntry {
                    id: id.trim().to_string(),
                    name,
                });
        }
    }
    catalog
}

// 优先采用项目 Provider 覆盖，否则使用目录中的全局当前项。
pub(super) fn project_provider(
    agent: CcConnectAgent,
    provider_overrides: &str,
    catalog: &ProviderCatalog,
) -> (Option<String>, Option<String>, bool) {
    let app_type = match agent {
        CcConnectAgent::Claude => "claude",
        CcConnectAgent::Codex => "codex",
        CcConnectAgent::Pi | CcConnectAgent::Opencode => return (None, None, true),
    };
    let project_override = serde_json::from_str::<serde_json::Value>(provider_overrides)
        .ok()
        .and_then(|value| value.get(app_type).cloned())
        .and_then(|value| value.as_object().cloned())
        .and_then(|value| {
            let provider_id = value
                .get("providerId")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let provider_name = value
                .get("providerName")
                .and_then(serde_json::Value::as_str)
                .map(single_line)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    catalog
                        .names_by_app_and_id
                        .get(&(app_type.to_string(), provider_id.to_string()))
                        .cloned()
                })
                .unwrap_or_else(|| provider_id.to_string());
            Some((provider_id.to_string(), provider_name))
        });
    if let Some((provider_id, provider_name)) = project_override {
        return (Some(provider_id), Some(provider_name), false);
    }
    match catalog.current_by_app.get(app_type) {
        Some(provider) => (Some(provider.id.clone()), Some(provider.name.clone()), true),
        None => (None, None, true),
    }
}

// 按非 ASCII 名称优先、再按小写名称顺序比较。
pub(super) fn compare_display_names(left: &str, right: &str) -> std::cmp::Ordering {
    let left_ascii = left.chars().all(|character| character.is_ascii());
    let right_ascii = right.chars().all(|character| character.is_ascii());
    left_ascii
        .cmp(&right_ascii)
        .then_with(|| left.to_lowercase().cmp(&right.to_lowercase()))
}

// 依次按分组排序值、显示名和标识比较。
pub(super) fn compare_registered_groups(
    left: &RegisteredGroup,
    right: &RegisteredGroup,
) -> std::cmp::Ordering {
    left.sort_order
        .cmp(&right.sort_order)
        .then_with(|| compare_display_names(&left.name, &right.name))
        .then_with(|| left.id.cmp(&right.id))
}

// 依次按项目排序值、显示名和标识比较。
pub(super) fn compare_registered_project_rows(
    left: &RegisteredProjectRow,
    right: &RegisteredProjectRow,
) -> std::cmp::Ordering {
    left.sort_order
        .cmp(&right.sort_order)
        .then_with(|| compare_display_names(&left.name, &right.name))
        .then_with(|| left.id.cmp(&right.id))
}

// 组合分组及 Provider 信息，SSH 项目清除本机 Provider 并回退主机根。
pub(super) fn registered_project_from_row(
    row: &RegisteredProjectRow,
    group_path: &[RegisteredGroupSegment],
    catalog: &ProviderCatalog,
) -> RegisteredProject {
    let remote = row.environment_type == "ssh";
    let (provider_id, provider_name, provider_is_global) = if remote {
        (None, None, true)
    } else {
        project_provider(row.agent, &row.provider_overrides, catalog)
    };
    let codex_provider_id = if remote {
        None
    } else if row.agent == CcConnectAgent::Codex {
        provider_id.clone()
    } else {
        project_provider(CcConnectAgent::Codex, &row.provider_overrides, catalog).0
    };
    RegisteredProject {
        id: row.id.clone(),
        name: row.name.clone(),
        path: row.path.clone(),
        agent: row.agent,
        cli_tool: row.cli_tool.clone(),
        cli_args: row.cli_args.clone(),
        group_path: group_path.to_vec(),
        provider_id,
        codex_provider_id,
        provider_name,
        provider_is_global,
        environment_type: row.environment_type.clone(),
        ssh_host_id: row.ssh_host_id.clone(),
        remote_path: row.remote_path.clone(),
        cli_config_root: if row.cli_config_root.trim().is_empty() {
            row.host_codex_config_root.clone()
        } else {
            row.cli_config_root.clone()
        },
        env_vars: row.env_vars.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
// 去重递归遍历分组，先子组后本组项目并维护分组路径。
pub(super) fn append_registered_group(
    group_id: &str,
    groups_by_id: &HashMap<String, RegisteredGroup>,
    child_group_ids: &HashMap<Option<String>, Vec<String>>,
    project_indices_by_group: &HashMap<Option<String>, Vec<usize>>,
    project_rows: &[RegisteredProjectRow],
    catalog: &ProviderCatalog,
    visited_group_ids: &mut HashSet<String>,
    included_project_indices: &mut HashSet<usize>,
    group_path: &mut Vec<RegisteredGroupSegment>,
    output: &mut Vec<RegisteredProject>,
) {
    if !visited_group_ids.insert(group_id.to_string()) {
        return;
    }
    let Some(group) = groups_by_id.get(group_id) else {
        return;
    };
    group_path.push(RegisteredGroupSegment {
        id: group.id.clone(),
        name: group.name.clone(),
    });
    if let Some(children) = child_group_ids.get(&Some(group_id.to_string())) {
        for child_id in children {
            append_registered_group(
                child_id,
                groups_by_id,
                child_group_ids,
                project_indices_by_group,
                project_rows,
                catalog,
                visited_group_ids,
                included_project_indices,
                group_path,
                output,
            );
        }
    }
    if let Some(project_indices) = project_indices_by_group.get(&Some(group_id.to_string())) {
        for index in project_indices {
            if included_project_indices.insert(*index) {
                output.push(registered_project_from_row(
                    &project_rows[*index],
                    group_path,
                    catalog,
                ));
            }
        }
    }
    group_path.pop();
}

// 整理分组与项目顺序，补收孤立、循环分组及未分组项目。
pub(super) fn order_registered_projects(
    groups: Vec<RegisteredGroup>,
    project_rows: Vec<RegisteredProjectRow>,
    catalog: &ProviderCatalog,
) -> Vec<RegisteredProject> {
    let groups_by_id = groups
        .iter()
        .cloned()
        .map(|group| (group.id.clone(), group))
        .collect::<HashMap<_, _>>();
    let mut child_group_ids = HashMap::<Option<String>, Vec<String>>::new();
    for group in &groups {
        let parent_id = group
            .parent_id
            .as_ref()
            .filter(|parent_id| groups_by_id.contains_key(*parent_id))
            .cloned();
        child_group_ids
            .entry(parent_id)
            .or_default()
            .push(group.id.clone());
    }
    for child_ids in child_group_ids.values_mut() {
        child_ids.sort_by(|left, right| {
            compare_registered_groups(&groups_by_id[left], &groups_by_id[right])
        });
    }

    let mut project_indices_by_group = HashMap::<Option<String>, Vec<usize>>::new();
    for (index, project) in project_rows.iter().enumerate() {
        let group_id = project
            .group_id
            .as_ref()
            .filter(|group_id| groups_by_id.contains_key(*group_id))
            .cloned();
        project_indices_by_group
            .entry(group_id)
            .or_default()
            .push(index);
    }
    for project_indices in project_indices_by_group.values_mut() {
        project_indices.sort_by(|left, right| {
            compare_registered_project_rows(&project_rows[*left], &project_rows[*right])
        });
    }

    let mut output = Vec::with_capacity(project_rows.len());
    let mut visited_group_ids = HashSet::new();
    let mut included_project_indices = HashSet::new();
    let mut group_path = Vec::new();
    if let Some(root_group_ids) = child_group_ids.get(&None) {
        for group_id in root_group_ids {
            append_registered_group(
                group_id,
                &groups_by_id,
                &child_group_ids,
                &project_indices_by_group,
                &project_rows,
                catalog,
                &mut visited_group_ids,
                &mut included_project_indices,
                &mut group_path,
                &mut output,
            );
        }
    }

    let mut remaining_group_ids = groups
        .iter()
        .filter(|group| !visited_group_ids.contains(&group.id))
        .map(|group| group.id.clone())
        .collect::<Vec<_>>();
    remaining_group_ids.sort_by(|left, right| {
        compare_registered_groups(&groups_by_id[left], &groups_by_id[right])
    });
    for group_id in remaining_group_ids {
        append_registered_group(
            &group_id,
            &groups_by_id,
            &child_group_ids,
            &project_indices_by_group,
            &project_rows,
            catalog,
            &mut visited_group_ids,
            &mut included_project_indices,
            &mut group_path,
            &mut output,
        );
    }

    if let Some(project_indices) = project_indices_by_group.get(&None) {
        for index in project_indices {
            if included_project_indices.insert(*index) {
                output.push(registered_project_from_row(
                    &project_rows[*index],
                    &[],
                    catalog,
                ));
            }
        }
    }
    let mut remaining_project_indices = (0..project_rows.len())
        .filter(|index| !included_project_indices.contains(index))
        .collect::<Vec<_>>();
    remaining_project_indices.sort_by(|left, right| {
        compare_registered_project_rows(&project_rows[*left], &project_rows[*right])
    });
    for index in remaining_project_indices {
        output.push(registered_project_from_row(
            &project_rows[index],
            &[],
            catalog,
        ));
    }
    output
}

// 只读加载注册项目和分组，再合并本机 Provider 目录并排序。
pub(super) fn load_registered_projects(
    _profile: Option<&CcConnectProfile>,
) -> Result<Vec<RegisteredProject>, String> {
    let database_path = crate::app_paths::db_path()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("create project query runtime failed: {err}"))?;
    runtime.block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .read_only(true)
            .busy_timeout(Duration::from_secs(3));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|err| format!("open CLI-Manager project database failed: {err}"))?;
        let group_rows = sqlx::query("SELECT id, name, parent_id, sort_order FROM groups")
            .fetch_all(&mut connection)
            .await
            .map_err(|err| format!("query CLI-Manager groups failed: {err}"))?;
        let project_rows = sqlx::query(
            "SELECT p.id, p.name, p.path, p.cli_tool, p.cli_args, p.group_id, p.sort_order, \
                    p.provider_overrides, p.environment_type, p.ssh_host_id, p.remote_path, \
                    p.cli_config_root, p.env_vars, \
                    COALESCE(( \
                      SELECT pref.configured_root FROM ssh_host_tool_preferences AS pref \
                      WHERE pref.host_id = p.ssh_host_id AND pref.source = 'codex' \
                      LIMIT 1 \
                    ), '') AS host_codex_config_root \
             FROM projects AS p",
        )
        .fetch_all(&mut connection)
        .await
        .map_err(|err| format!("query CLI-Manager projects failed: {err}"))?;
        let _ = connection.close().await;

        let groups = group_rows
            .into_iter()
            .map(|row| {
                Ok(RegisteredGroup {
                    id: row
                        .try_get("id")
                        .map_err(|err| format!("read group ID failed: {err}"))?,
                    name: row
                        .try_get("name")
                        .map_err(|err| format!("read group name failed: {err}"))?,
                    parent_id: row
                        .try_get("parent_id")
                        .map_err(|err| format!("read group parent failed: {err}"))?,
                    sort_order: row
                        .try_get("sort_order")
                        .map_err(|err| format!("read group sort order failed: {err}"))?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let projects = project_rows
            .into_iter()
            .map(|row| {
                let cli_tool: String = row
                    .try_get("cli_tool")
                    .map_err(|err| format!("read project CLI tool failed: {err}"))?;
                let Some(agent) = cc_connect_agent_from_cli_tool(&cli_tool) else {
                    return Ok(None);
                };
                Ok(Some(RegisteredProjectRow {
                    id: row
                        .try_get("id")
                        .map_err(|err| format!("read project ID failed: {err}"))?,
                    name: row
                        .try_get("name")
                        .map_err(|err| format!("read project name failed: {err}"))?,
                    path: row
                        .try_get("path")
                        .map_err(|err| format!("read project path failed: {err}"))?,
                    agent,
                    cli_tool,
                    cli_args: row
                        .try_get("cli_args")
                        .map_err(|err| format!("read project CLI arguments failed: {err}"))?,
                    group_id: row
                        .try_get("group_id")
                        .map_err(|err| format!("read project group failed: {err}"))?,
                    sort_order: row
                        .try_get("sort_order")
                        .map_err(|err| format!("read project sort order failed: {err}"))?,
                    provider_overrides: row
                        .try_get("provider_overrides")
                        .map_err(|err| format!("read project provider override failed: {err}"))?,
                    environment_type: row
                        .try_get("environment_type")
                        .map_err(|err| format!("read project environment type failed: {err}"))?,
                    ssh_host_id: row
                        .try_get("ssh_host_id")
                        .map_err(|err| format!("read project SSH host failed: {err}"))?,
                    remote_path: row
                        .try_get("remote_path")
                        .map_err(|err| format!("read project remote path failed: {err}"))?,
                    cli_config_root: row
                        .try_get("cli_config_root")
                        .map_err(|err| format!("read project CLI config root failed: {err}"))?,
                    host_codex_config_root: row
                        .try_get("host_codex_config_root")
                        .map_err(|err| format!("read SSH Codex config root failed: {err}"))?,
                    env_vars: row
                        .try_get("env_vars")
                        .map_err(|err| format!("read project environment failed: {err}"))?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect();
        let provider_catalog = load_provider_catalog().await;
        Ok(order_registered_projects(
            groups,
            projects,
            &provider_catalog,
        ))
    })
}
