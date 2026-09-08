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

// 在 Tauri 异步运行时同步等待服务 Future，原样返回业务结果。
fn block_on<T>(future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tauri::async_runtime::block_on(future)
}

// 将持久化接管项转换为 Home 与 HTTP 投影目标；含冒号且未加括号的主机按 IPv6 形式包裹，不执行地址探测。
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
// 供应商列表 IPC：同步等待仓储按可选类型返回卡片。
pub fn provider_catalog_list(app_type: Option<String>) -> Result<Vec<ProviderCard>, String> {
    block_on(repository::list_providers(app_type))
}

#[tauri::command]
// 供应商详情 IPC：将类型与 ID 转交仓储读取详情。
pub fn provider_catalog_get(
    app_type: String,
    provider_id: String,
) -> Result<ProviderDetail, String> {
    block_on(repository::get_provider(app_type, provider_id))
}

#[tauri::command]
// 模型查询 IPC：等待模型服务处理临时或已保存供应商输入，网络与凭据规则由服务负责。
pub fn provider_fetch_models(input: FetchModelsInput) -> Result<FetchModelsResult, String> {
    block_on(models::fetch(input))
}

#[tauri::command]
// 供应商创建 IPC：将输入交给仓储校验、保存并返回详情。
pub fn provider_catalog_create(input: ProviderCreateInput) -> Result<ProviderDetail, String> {
    block_on(repository::create_provider(input))
}

#[tauri::command]
// 供应商更新 IPC：委托仓储合并字段并保存，不在入口直接操作配置文件。
pub fn provider_catalog_update(input: ProviderUpdateInput) -> Result<ProviderDetail, String> {
    block_on(repository::update_provider(input))
}

#[tauri::command]
// 配置文档更新 IPC：转交仓储执行类型校验与文档替换。
pub fn provider_document_update(
    input: ProviderDocumentUpdateInput,
) -> Result<ProviderDetail, String> {
    block_on(repository::update_provider_document(input))
}

#[tauri::command]
// 供应商复制 IPC：转交来源身份及可选新名称，返回新记录详情。
pub fn provider_catalog_duplicate(
    app_type: String,
    provider_id: String,
    name: Option<String>,
) -> Result<ProviderDetail, String> {
    block_on(repository::duplicate_provider(app_type, provider_id, name))
}

#[tauri::command]
// 供应商删除 IPC：由仓储检查当前状态及引用并执行删除。
pub fn provider_catalog_delete(app_type: String, provider_id: String) -> Result<(), String> {
    block_on(repository::delete_provider(app_type, provider_id))
}

#[tauri::command]
// 供应商启停 IPC：转发目标身份与启用标记，校验由仓储负责。
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
// 供应商排序 IPC：转交完整 ID 顺序并返回更新后的卡片列表。
pub fn provider_catalog_reorder(
    app_type: String,
    provider_ids: Vec<String>,
) -> Result<Vec<ProviderCard>, String> {
    block_on(repository::reorder_providers(app_type, provider_ids))
}

#[tauri::command]
// 密钥列表 IPC：返回仓储生成的密钥摘要列表。
pub fn provider_key_list(
    app_type: String,
    provider_id: String,
) -> Result<Vec<ProviderKeySummary>, String> {
    block_on(repository::list_keys(app_type, provider_id))
}

#[tauri::command]
// 密钥创建 IPC：转发创建及可选激活输入，返回摘要。
pub fn provider_key_create(input: ProviderKeyCreateInput) -> Result<ProviderKeySummary, String> {
    block_on(repository::create_key(input))
}

#[tauri::command]
// 密钥更新 IPC：转发字段更新请求，返回仓储摘要。
pub fn provider_key_update(input: ProviderKeyUpdateInput) -> Result<ProviderKeySummary, String> {
    block_on(repository::update_key(input))
}

#[tauri::command]
// 密钥删除 IPC：转发目标及可选替代密钥，活动项替换规则由仓储处理。
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
// 密钥启停 IPC：转发启用标记，活动项禁用校验由仓储负责。
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
// 密钥激活 IPC：委托仓储切换活动项并投影供应商配置。
pub fn provider_key_activate(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<ProviderKeySummary, String> {
    block_on(repository::activate_key(app_type, provider_id, key_id))
}

#[tauri::command]
// 密钥排序 IPC：转交目标供应商与 ID 顺序，返回排序后的摘要。
pub fn provider_key_reorder(
    app_type: String,
    provider_id: String,
    key_ids: Vec<String>,
) -> Result<Vec<ProviderKeySummary>, String> {
    block_on(repository::reorder_keys(app_type, provider_id, key_ids))
}

#[tauri::command]
// 密钥显示 IPC：返回仓储查询的原始密钥字符串，结果不是脱敏摘要。
pub fn provider_key_reveal(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<String, String> {
    block_on(repository::reveal_key(app_type, provider_id, key_id))
}

#[tauri::command]
// 公共配置读取 IPC：返回供编辑使用的原文与格式标记。
pub fn provider_common_config_get(app_type: String) -> Result<CommonConfigDocument, String> {
    block_on(repository::get_common_config(app_type))
}

#[tauri::command]
// 公共配置保存 IPC：委托仓储格式校验及数据库保存。
pub fn provider_common_config_set(
    input: CommonConfigSetInput,
) -> Result<CommonConfigDocument, String> {
    block_on(repository::set_common_config(input))
}

#[tauri::command]
// 公共配置校验 IPC：直接执行同步格式校验，不保存配置。
pub fn provider_common_config_validate(input: CommonConfigSetInput) -> Result<(), String> {
    repository::validate_common_config(input)
}

#[tauri::command]
// Home 读取 IPC：以自动模式和无显式路径构造输入，交由 Home 服务解析已有选择。
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
// 活动 Home IPC：直接返回 Home 服务的活动状态，不在入口启动异步探测。
pub fn provider_home_active_get() -> Result<ProviderHomeState, String> {
    home::active()
}

#[tauri::command]
// Home 缓存 IPC：按环境身份读取可选缓存状态，缺失返回 None。
pub fn provider_home_cached_get(
    environment_kind: String,
    environment_id: Option<String>,
) -> Option<ProviderHomeState> {
    home::cached(environment_kind, environment_id)
}

#[tauri::command]
// WSL 列表 IPC：委托 Home 服务枚举发行版，不附加 Home 识别步骤。
pub fn provider_wsl_list_distros() -> Result<Vec<String>, String> {
    home::list_wsl_distros()
}

#[tauri::command]
// Home 预览 IPC：同步等待服务处理候选选择并返回预览状态。
pub fn provider_home_preview(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    block_on(home::preview(input))
}

#[tauri::command]
// Home 选择 IPC：转交选择输入，持久化和缓存更新由 Home 服务执行。
pub fn provider_home_select(input: HomeSelectInput) -> Result<ProviderHomeState, String> {
    block_on(home::select(input))
}

#[tauri::command]
// Home 重置 IPC：按环境身份委托服务恢复默认选择。
pub fn provider_home_reset(
    environment_kind: String,
    environment_id: Option<String>,
) -> Result<ProviderHomeState, String> {
    block_on(home::reset(environment_kind, environment_id))
}

#[tauri::command]
// 全局配置预览 IPC：等待服务生成应用预览。
pub fn provider_global_preview(input: GlobalPreviewInput) -> Result<GlobalPreview, String> {
    block_on(global::preview(input))
}

#[tauri::command]
// 全局当前状态 IPC：转交目标类型与 Home 输入并返回服务查询结果。
pub fn provider_global_current(input: GlobalCurrentInput) -> Result<GlobalCurrent, String> {
    block_on(global::current(input))
}

#[tauri::command]
// 无显式投影时尝试对同类型接管 Home 热切换，返回匹配 Home 或首项结果；前置查询未满足条件则回退普通应用，热切换执行错误向上传播。
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
// 环境诊断 IPC：委托服务执行 CLI、配置与目录对齐检查。
pub fn provider_environment_inspect(
    input: EnvironmentInspectInput,
) -> Result<EnvironmentReport, String> {
    block_on(environment::inspect(input))
}

#[tauri::command]
// 诊断目标打开 IPC：转交路径与文件打开选项，平台操作由环境服务负责。
pub fn provider_environment_open_target(
    path: String,
    open_file: Option<bool>,
) -> Result<(), String> {
    block_on(environment::open_target(path, open_file))
}

#[tauri::command]
// 全局修复 IPC：委托服务恢复未完成的应用日志，不在入口扩展恢复范围。
pub fn provider_global_repair() -> Result<RecoveryReport, String> {
    block_on(global::recover_pending())
}

#[tauri::command]
// 作用域解析 IPC：将选择输入交给服务返回解析后的供应商。
pub fn provider_scope_resolve(input: ScopeResolveInput) -> Result<ResolvedProvider, String> {
    block_on(scope::resolve(input))
}

#[tauri::command]
// 作用域准备 IPC：等待服务构建可选启动快照，具体文件与凭据处理由服务负责。
pub fn provider_scope_prepare(
    input: ScopePrepareInput,
) -> Result<Option<ProviderLaunchSnapshot>, String> {
    block_on(scope::prepare(input))
}

#[tauri::command]
// 作用域快照释放 IPC：按快照 ID 委托清理。
pub fn provider_scope_release_snapshot(snapshot_id: String) -> Result<(), String> {
    block_on(scope::release_snapshot(snapshot_id))
}

#[tauri::command]
// 快照回收前补入活动交接快照 ID，排序去重后交给服务；读取活动交接失败时不执行回收。
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
// 供应商导入预览 IPC：将来源输入交给导入服务生成候选结果。
pub fn provider_import_preview(input: ImportSourceInput) -> Result<ImportPreview, String> {
    block_on(import::preview(input))
}

#[tauri::command]
// 供应商导入提交 IPC：转发已选择的导入输入，等待服务完成写入。
pub fn provider_import_commit(input: ImportCommitInput) -> Result<ImportResult, String> {
    block_on(import::commit(input))
}

#[tauri::command]
// 导入问题列表 IPC：返回导入服务查询的待处理问题。
pub fn provider_import_issues() -> Result<Vec<ImportIssue>, String> {
    block_on(import::list_issues())
}

#[tauri::command]
// 导入问题处理 IPC：将问题处理输入交给导入服务执行。
pub fn provider_import_resolve_issue(input: ImportIssueResolveInput) -> Result<(), String> {
    block_on(import::resolve_issue(input))
}
