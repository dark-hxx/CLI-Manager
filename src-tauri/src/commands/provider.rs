use crate::provider::environment::{self, EnvironmentInspectInput, EnvironmentReport};
use crate::provider::global::{
    self, GlobalApplyInput, GlobalApplyResult, GlobalCurrent, GlobalCurrentInput, GlobalPreview,
    GlobalPreviewInput, LocalRouteProjection, RecoveryReport,
};
use crate::provider::home::{self, HomeSelectInput, ProviderHomeState};
use crate::provider::import::{
    self, ImportCommitInput, ImportIssue, ImportIssueResolveInput, ImportPreview, ImportResult,
    ImportSourceInput,
};
use crate::provider::models::{self, FetchModelsInput, FetchModelsResult};
use crate::provider::repository::{
    self, CommonConfigDocument, CommonConfigSetInput, ProviderCard, ProviderCreateInput,
    ProviderDetail, ProviderDocumentUpdateInput, ProviderKeyCreateInput, ProviderKeySummary,
    ProviderKeyUpdateInput, ProviderUpdateInput,
};
use crate::provider::routing;
use crate::provider::scope::{
    self, ProviderLaunchSnapshot, ResolvedProvider, ScopePrepareInput, ScopeResolveInput,
};
use std::future::Future;

fn block_on<T>(future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tauri::async_runtime::block_on(future)
}

fn hot_switch_target(
    item: &routing::RoutingTakeoverItem,
) -> Result<global::HotSwitchTarget, String> {
    let host = if item.advertised_host.contains(':') && !item.advertised_host.starts_with('[') {
        format!("[{}]", item.advertised_host)
    } else {
        item.advertised_host.clone()
    };
    Ok(global::HotSwitchTarget {
        home_identity: global::HomeIdentityInput {
            environment_kind: item.home_identity.environment_kind.clone(),
            environment_id: Some(item.home_identity.environment_id.clone()),
        },
        projection: LocalRouteProjection {
            endpoint: format!("http://{host}:{}", item.applied_port),
        },
    })
}

#[tauri::command]
pub fn provider_catalog_list(app_type: Option<String>) -> Result<Vec<ProviderCard>, String> {
    block_on(repository::list_providers(app_type))
}

#[tauri::command]
pub fn provider_catalog_get(
    app_type: String,
    provider_id: String,
) -> Result<ProviderDetail, String> {
    block_on(repository::get_provider(app_type, provider_id))
}

#[tauri::command]
pub fn provider_fetch_models(input: FetchModelsInput) -> Result<FetchModelsResult, String> {
    block_on(models::fetch(input))
}

#[tauri::command]
pub fn provider_catalog_create(input: ProviderCreateInput) -> Result<ProviderDetail, String> {
    block_on(repository::create_provider(input))
}

#[tauri::command]
pub fn provider_catalog_update(input: ProviderUpdateInput) -> Result<ProviderDetail, String> {
    block_on(repository::update_provider(input))
}

#[tauri::command]
pub fn provider_document_update(
    input: ProviderDocumentUpdateInput,
) -> Result<ProviderDetail, String> {
    block_on(repository::update_provider_document(input))
}

#[tauri::command]
pub fn provider_catalog_duplicate(
    app_type: String,
    provider_id: String,
    name: Option<String>,
) -> Result<ProviderDetail, String> {
    block_on(repository::duplicate_provider(app_type, provider_id, name))
}

#[tauri::command]
pub fn provider_catalog_delete(app_type: String, provider_id: String) -> Result<(), String> {
    block_on(repository::delete_provider(app_type, provider_id))
}

#[tauri::command]
pub fn provider_catalog_set_enabled(
    app_type: String,
    provider_id: String,
    enabled: bool,
) -> Result<ProviderDetail, String> {
    block_on(repository::set_provider_enabled(
        app_type,
        provider_id,
        enabled,
    ))
}

#[tauri::command]
pub fn provider_catalog_reorder(
    app_type: String,
    provider_ids: Vec<String>,
) -> Result<Vec<ProviderCard>, String> {
    block_on(repository::reorder_providers(app_type, provider_ids))
}

#[tauri::command]
pub fn provider_key_list(
    app_type: String,
    provider_id: String,
) -> Result<Vec<ProviderKeySummary>, String> {
    block_on(repository::list_keys(app_type, provider_id))
}

#[tauri::command]
pub fn provider_key_create(input: ProviderKeyCreateInput) -> Result<ProviderKeySummary, String> {
    block_on(repository::create_key(input))
}

#[tauri::command]
pub fn provider_key_update(input: ProviderKeyUpdateInput) -> Result<ProviderKeySummary, String> {
    block_on(repository::update_key(input))
}

#[tauri::command]
pub fn provider_key_delete(
    app_type: String,
    provider_id: String,
    key_id: String,
    replacement_key_id: Option<String>,
) -> Result<(), String> {
    block_on(repository::delete_key(
        app_type,
        provider_id,
        key_id,
        replacement_key_id,
    ))
}

#[tauri::command]
pub fn provider_key_set_enabled(
    app_type: String,
    provider_id: String,
    key_id: String,
    enabled: bool,
) -> Result<ProviderKeySummary, String> {
    block_on(repository::set_key_enabled(
        app_type,
        provider_id,
        key_id,
        enabled,
    ))
}

#[tauri::command]
pub fn provider_key_activate(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<ProviderKeySummary, String> {
    block_on(repository::activate_key(app_type, provider_id, key_id))
}

#[tauri::command]
pub fn provider_key_reorder(
    app_type: String,
    provider_id: String,
    key_ids: Vec<String>,
) -> Result<Vec<ProviderKeySummary>, String> {
    block_on(repository::reorder_keys(app_type, provider_id, key_ids))
}

#[tauri::command]
pub fn provider_key_reveal(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<String, String> {
    block_on(repository::reveal_key(app_type, provider_id, key_id))
}

#[tauri::command]
pub fn provider_common_config_get(app_type: String) -> Result<CommonConfigDocument, String> {
    block_on(repository::get_common_config(app_type))
}

#[tauri::command]
pub fn provider_common_config_set(
    input: CommonConfigSetInput,
) -> Result<CommonConfigDocument, String> {
    block_on(repository::set_common_config(input))
}

#[tauri::command]
pub fn provider_common_config_validate(input: CommonConfigSetInput) -> Result<(), String> {
    repository::validate_common_config(input)
}

#[tauri::command]
pub fn provider_home_get(
    environment_kind: String,
    environment_id: Option<String>,
) -> Result<ProviderHomeState, String> {
    block_on(home::get(HomeSelectInput {
        environment_kind,
        environment_id,
        mode: "auto".to_string(),
        home_path: None,
    }))
}

#[tauri::command]
pub fn provider_home_active_get() -> Result<ProviderHomeState, String> {
    home::active()
}

#[tauri::command]
pub fn provider_home_cached_get(
    environment_kind: String,
    environment_id: Option<String>,
) -> Option<ProviderHomeState> {
    home::cached(environment_kind, environment_id)
}

#[tauri::command]
pub fn provider_wsl_list_distros() -> Result<Vec<String>, String> {
    home::list_wsl_distros()
}

#[tauri::command]
pub fn provider_home_preview(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    block_on(home::preview(input))
}

#[tauri::command]
pub fn provider_home_select(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    block_on(home::select(input))
}

#[tauri::command]
pub fn provider_home_reset(
    environment_kind: String,
    environment_id: Option<String>,
) -> Result<ProviderHomeState, String> {
    block_on(home::reset(environment_kind, environment_id))
}

#[tauri::command]
pub fn provider_global_preview(input: GlobalPreviewInput) -> Result<GlobalPreview, String> {
    block_on(global::preview(input))
}

#[tauri::command]
pub fn provider_global_current(input: GlobalCurrentInput) -> Result<GlobalCurrent, String> {
    block_on(global::current(input))
}

#[tauri::command]
pub fn provider_global_apply(input: GlobalApplyInput) -> Result<GlobalApplyResult, String> {
    if input.projection.is_none() {
        if let Ok(app_type) = repository::normalize_app_type(&input.app_type) {
            if let Ok(persisted) = block_on(routing::load_persisted_state()) {
                let targets = persisted
                    .takeovers
                    .iter()
                    .filter(|item| item.app_type == app_type)
                    .map(hot_switch_target)
                    .collect::<Result<Vec<_>, _>>()?;
                if !targets.is_empty() {
                    if let Ok(previous_provider_id) =
                        block_on(routing::current_provider_id(&app_type))
                    {
                        let results = block_on(global::apply_hot_switch(
                            &app_type,
                            &previous_provider_id,
                            &input.provider_id,
                            &targets,
                        ))?;
                        let expected_environment_id = input
                            .home_identity
                            .environment_id
                            .as_deref()
                            .unwrap_or_default();
                        return results
                            .iter()
                            .find(|result| {
                                result.home_identity.environment_kind
                                    == input.home_identity.environment_kind
                                    && result.home_identity.environment_id
                                        == expected_environment_id
                            })
                            .cloned()
                            .or_else(|| results.into_iter().next())
                            .ok_or_else(|| "routing_hot_switch_result_missing".to_string());
                    }
                }
            }
        }
    }
    block_on(global::apply(input))
}

#[tauri::command]
pub fn provider_environment_inspect(
    input: EnvironmentInspectInput,
) -> Result<EnvironmentReport, String> {
    block_on(environment::inspect(input))
}

#[tauri::command]
pub fn provider_environment_open_target(
    path: String,
    open_file: Option<bool>,
) -> Result<(), String> {
    block_on(environment::open_target(path, open_file))
}

#[tauri::command]
pub fn provider_global_repair() -> Result<RecoveryReport, String> {
    block_on(global::recover_pending())
}

#[tauri::command]
pub fn provider_scope_resolve(input: ScopeResolveInput) -> Result<ResolvedProvider, String> {
    block_on(scope::resolve(input))
}

#[tauri::command]
pub fn provider_scope_prepare(
    input: ScopePrepareInput,
) -> Result<Option<ProviderLaunchSnapshot>, String> {
    block_on(scope::prepare(input))
}

#[tauri::command]
pub fn provider_scope_release_snapshot(snapshot_id: String) -> Result<(), String> {
    block_on(scope::release_snapshot(snapshot_id))
}

#[tauri::command]
pub fn provider_scope_gc_snapshots(mut active_snapshot_ids: Vec<String>) -> Result<(), String> {
    if let Some(snapshot_id) = crate::commands::cc_connect::handoff::active_provider_snapshot_id()?
    {
        active_snapshot_ids.push(snapshot_id);
    }
    active_snapshot_ids.sort();
    active_snapshot_ids.dedup();
    block_on(scope::garbage_collect_snapshots(active_snapshot_ids))
}

#[tauri::command]
pub fn provider_import_preview(input: ImportSourceInput) -> Result<ImportPreview, String> {
    block_on(import::preview(input))
}

#[tauri::command]
pub fn provider_import_commit(input: ImportCommitInput) -> Result<ImportResult, String> {
    block_on(import::commit(input))
}

#[tauri::command]
pub fn provider_import_issues() -> Result<Vec<ImportIssue>, String> {
    block_on(import::list_issues())
}

#[tauri::command]
pub fn provider_import_resolve_issue(input: ImportIssueResolveInput) -> Result<(), String> {
    block_on(import::resolve_issue(input))
}
