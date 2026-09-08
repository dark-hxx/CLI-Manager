#[cfg(target_os = "windows")]
use super::copy_file_atomically_if_changed;
#[cfg(unix)]
use super::write_executable_file_atomically_if_changed;
use super::{
    handoff_session, load_ssh_codex_launch, log_path, output_text, path_string, redact_log_line,
    remote_manager_dir, resolve_proxy_url_if_enabled, single_line, user_home_dir,
    write_file_atomically, CcConnectAgent, CcConnectProfile, CodexModelCatalog,
    CodexModelDiscoveryConfig, RegisteredProject, ResolvedAgentLauncher, ResolvedProxy,
    CODEX_APP_SERVER_PROBE_TIMEOUT, CODEX_MODELS_CACHE_FILE_NAME, CODEX_MODEL_CATALOG_FILE_NAME,
    CODEX_MODEL_DISCOVERY_TIMEOUT, CONFIG_FILE_NAME, LOCAL_PROXY_PORTS,
    MAX_CODEX_MODEL_CACHE_BYTES, MAX_CODEX_MODEL_RESPONSE_BYTES, MAX_MANAGED_CODEX_MODELS,
};
#[cfg(not(target_os = "windows"))]
use crate::codex_app_server_proxy::HELPER_SUBCOMMAND as CODEX_PROXY_SUBCOMMAND;
use crate::codex_app_server_proxy::{
    SshCodexLaunch, CODEX_BASE_URL_OVERRIDE_ENV, CODEX_ENV_KEY_OVERRIDE_ENV,
    CODEX_LAUNCHER_ARGS_ENV, CODEX_LAUNCHER_ENV, CODEX_MODEL_CATALOG_OVERRIDE_ENV,
    CODEX_MODEL_OVERRIDE_ENV, CODEX_MODEL_PROVIDER_ENV, CODEX_PROFILE_NAME_ENV,
    CODEX_PROTOCOL_TRACE_PATH_ENV, CODEX_PROVIDER_NAME_OVERRIDE_ENV, CODEX_SSH_LAUNCH_ENV,
    CODEX_WIRE_API_OVERRIDE_ENV, EXPECTED_SESSION_ID_ENV, PROXY_EXECUTABLE_ENV,
};
use crate::shell_resolver::{output_with_timeout, silent_command};
use std::collections::HashSet;
use std::env;
use std::fs::{self};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub(super) struct RemoteCodexProviderLaunch {
    pub(super) name: String,
    pub(super) profile_name: String,
    pub(super) profile_text: String,
    pub(super) model_provider: String,
    pub(super) provider_name_override: String,
    pub(super) model: Option<String>,
    pub(super) models: Vec<String>,
    pub(super) base_url_override: String,
    pub(super) env_key_override: String,
    pub(super) model_override: Option<String>,
    pub(super) wire_api_override: String,
    pub(super) env_key: String,
    pub(super) secret: String,
}

pub(super) struct RemoteCodexLaunch {
    pub(super) wrapper_dir: PathBuf,
    pub(super) launcher: Option<PathBuf>,
    pub(super) launcher_args: Vec<String>,
    pub(super) proxy_executable: PathBuf,
    pub(super) expected_session_id: Option<String>,
    pub(super) codex_home: Option<PathBuf>,
    pub(super) discovery_codex_home: Option<PathBuf>,
    pub(super) protocol_trace_path: Option<PathBuf>,
    pub(super) provider: Option<RemoteCodexProviderLaunch>,
    pub(super) ssh_launch: Option<SshCodexLaunch>,
}

// 优先使用显式 Codex 配置目录，否则回退用户 .codex。
pub(super) fn codex_config_dir(profile: &CcConnectProfile) -> Result<PathBuf, String> {
    profile
        .codex_config_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| user_home_dir().map(|home| home.join(".codex")))
        .ok_or_else(|| "home_dir_unavailable".to_string())
}

#[cfg(not(target_os = "windows"))]
// 生成非 Windows 的代理路由与 Provider 覆盖包装脚本。
pub(super) fn codex_profile_wrapper_payload() -> String {
    format!(
        "#!/bin/sh\n\
        if [ -n \"${{{CODEX_SSH_LAUNCH_ENV}:-}}\" ]; then\n\
        \x20\x20exec \"${PROXY_EXECUTABLE_ENV}\" {CODEX_PROXY_SUBCOMMAND} \"$@\"\n\
        fi\n\
        if [ \"${{1:-}}\" = \"app-server\" ]; then\n\
        \x20\x20exec \"${PROXY_EXECUTABLE_ENV}\" {CODEX_PROXY_SUBCOMMAND} \"$@\"\n\
        fi\n\
        if [ -n \"${{{CODEX_LAUNCHER_ARGS_ENV}:-}}\" ] && [ \"${CODEX_LAUNCHER_ARGS_ENV}\" != \"[]\" ]; then\n\
        \x20\x20exec \"${PROXY_EXECUTABLE_ENV}\" {CODEX_PROXY_SUBCOMMAND} \"$@\"\n\
        fi\n\
        if [ -z \"${{{CODEX_BASE_URL_OVERRIDE_ENV}:-}}\" ]; then\n\
        \x20\x20exec \"${CODEX_LAUNCHER_ENV}\" \"$@\"\n\
        fi\n\
        if [ -n \"${{{CODEX_MODEL_OVERRIDE_ENV}:-}}\" ]; then\n\
        \x20\x20exec \"${CODEX_LAUNCHER_ENV}\" --profile \"${CODEX_PROFILE_NAME_ENV}\" -c \"${CODEX_BASE_URL_OVERRIDE_ENV}\" -c \"${CODEX_ENV_KEY_OVERRIDE_ENV}\" -c \"${CODEX_WIRE_API_OVERRIDE_ENV}\" -c \"${CODEX_MODEL_CATALOG_OVERRIDE_ENV}\" -c \"${CODEX_MODEL_OVERRIDE_ENV}\" \"$@\"\n\
        else\n\
        \x20\x20exec \"${CODEX_LAUNCHER_ENV}\" --profile \"${CODEX_PROFILE_NAME_ENV}\" -c \"${CODEX_BASE_URL_OVERRIDE_ENV}\" -c \"${CODEX_ENV_KEY_OVERRIDE_ENV}\" -c \"${CODEX_WIRE_API_OVERRIDE_ENV}\" -c \"${CODEX_MODEL_CATALOG_OVERRIDE_ENV}\" \"$@\"\n\
        fi\n\
        "
    )
}

// 拒绝空值及危险命令字符后构造 Codex 配置覆盖赋值。
pub(super) fn codex_wrapper_override(key: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Codex {key} is empty"));
    }
    if value
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '"' | '%' | '!' | '^' | '&' | '|' | '<' | '>'))
    {
        return Err(format!(
            "Codex {key} contains unsupported command characters"
        ));
    }
    Ok(format!("{key}={value}"))
}

// 将 Provider 标识编码为安全的配置键路径片段。
pub(super) fn codex_provider_override_key(
    model_provider: &str,
    field: &str,
) -> Result<String, String> {
    let model_provider = model_provider.trim();
    if model_provider.is_empty() || model_provider.chars().any(char::is_control) {
        return Err("Codex model Provider ID is invalid".to_string());
    }
    let segment = if model_provider
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        model_provider.to_string()
    } else {
        serde_json::to_string(model_provider)
            .map_err(|err| format!("encode Codex model Provider ID failed: {err}"))?
    };
    Ok(format!("model_providers.{segment}.{field}"))
}

// 验证 HTTP(S) 端点后构造 Provider base_url 覆盖。
pub(super) fn codex_base_url_override(model_provider: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    let url =
        reqwest::Url::parse(value).map_err(|_| "Codex Provider base URL is invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Codex Provider base URL must use HTTP or HTTPS".to_string());
    }
    codex_wrapper_override(
        &codex_provider_override_key(model_provider, "base_url")?,
        value,
    )
}

// 校验环境变量名并构造 Provider env_key 覆盖。
pub(super) fn codex_env_key_override(model_provider: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    let mut chars = value.chars();
    if !chars
        .next()
        .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
        || !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
    {
        return Err("Codex Provider environment key is invalid".to_string());
    }
    codex_wrapper_override(
        &codex_provider_override_key(model_provider, "env_key")?,
        value,
    )
}

// 构造 wire_api 覆盖，未配置时使用 responses。
pub(super) fn codex_wire_api_override(
    model_provider: &str,
    value: Option<&str>,
) -> Result<String, String> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("responses");
    codex_wrapper_override(
        &codex_provider_override_key(model_provider, "wire_api")?,
        value,
    )
}

// 将非空模型名转换为可选 model 覆盖赋值。
pub(super) fn codex_model_override(value: Option<&str>) -> Result<Option<String>, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| codex_wrapper_override("model", value))
        .transpose()
}

// 对模型目录路径进行 JSON 引号编码以构造配置覆盖。
pub(super) fn codex_model_catalog_override(directory: &Path) -> Result<String, String> {
    let catalog_path = directory.join(CODEX_MODEL_CATALOG_FILE_NAME);
    let encoded_path = serde_json::to_string(&path_string(&catalog_path))
        .map_err(|err| format!("encode Codex model catalog path failed: {err}"))?;
    Ok(format!("model_catalog_json={encoded_path}"))
}

// 在合法 HTTP(S) Provider 基址下定位 models 端点。
pub(super) fn codex_models_endpoint(base_url: &str) -> Result<reqwest::Url, String> {
    let normalized = format!("{}/", base_url.trim().trim_end_matches('/'));
    let base_url = reqwest::Url::parse(&normalized)
        .map_err(|_| "Codex Provider models URL is invalid".to_string())?;
    if !matches!(base_url.scheme(), "http" | "https") || base_url.host_str().is_none() {
        return Err("Codex Provider models URL must use HTTP or HTTPS".to_string());
    }
    base_url
        .join("models")
        .map_err(|_| "Codex Provider models URL is invalid".to_string())
}

// 优先保留当前模型，过滤非聊天发现项并排序去重限量收集。
pub(super) fn normalize_managed_codex_models(
    current_model: Option<&str>,
    discovered_models: impl IntoIterator<Item = String>,
) -> Vec<String> {
    const NON_CHAT_MARKERS: [&str; 12] = [
        "embedding",
        "whisper",
        "tts",
        "moderation",
        "dall-e",
        "realtime",
        "transcribe",
        "search-preview",
        "image",
        "audio-preview",
        "rerank",
        "speech",
    ];
    let current_model = current_model
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    if let Some(model) = current_model {
        seen.insert(model.to_string());
        models.push(model.to_string());
    }
    let mut discovered = discovered_models
        .into_iter()
        .map(|model| model.trim().to_string())
        .filter(|model| {
            !model.is_empty()
                && model.len() <= 256
                && !model.chars().any(|character| character.is_control())
                && !NON_CHAT_MARKERS
                    .iter()
                    .any(|marker| model.to_ascii_lowercase().contains(marker))
        })
        .collect::<Vec<_>>();
    discovered.sort_by(|left, right| {
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(right))
    });
    for model in discovered {
        if seen.insert(model.clone()) {
            models.push(model);
            if models.len() == MAX_MANAGED_CODEX_MODELS {
                break;
            }
        }
    }
    models
}

// 构造不依赖本机缓存的保守模型能力模板。
pub(super) fn fallback_codex_model_catalog_entry() -> serde_json::Value {
    serde_json::json!({
        "slug": "",
        "display_name": "",
        "description": "",
        "default_reasoning_level": "medium",
        "supported_reasoning_levels": [
            { "effort": "low", "description": "Fast responses with lighter reasoning" },
            { "effort": "medium", "description": "Balances speed and reasoning depth" },
            { "effort": "high", "description": "Greater reasoning depth for complex tasks" },
            { "effort": "xhigh", "description": "Extra reasoning depth for complex tasks" }
        ],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 0,
        "availability_nux": null,
        "upgrade": null,
        "base_instructions": "You are Codex, a coding agent. Follow the user's instructions and work carefully in the provided workspace.",
        "supports_reasoning_summaries": true,
        "default_reasoning_summary": "auto",
        "support_verbosity": false,
        "default_verbosity": null,
        "apply_patch_tool_type": "freeform",
        "truncation_policy": { "mode": "tokens", "limit": 10000 },
        "supports_parallel_tool_calls": true,
        "supports_image_detail_original": true,
        "context_window": 272000,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": ["text", "image"],
        "prefer_websockets": false
    })
}

// 检查模型模板关键字段的基本 JSON 类型。
pub(super) fn is_usable_codex_model_catalog_entry(
    entry: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    [
        "slug",
        "display_name",
        "description",
        "default_reasoning_level",
        "shell_type",
        "visibility",
        "base_instructions",
    ]
    .iter()
    .all(|key| entry.get(*key).is_some_and(serde_json::Value::is_string))
        && entry
            .get("supported_reasoning_levels")
            .is_some_and(serde_json::Value::is_array)
        && entry
            .get("supported_in_api")
            .is_some_and(serde_json::Value::is_boolean)
        && entry
            .get("priority")
            .is_some_and(serde_json::Value::is_number)
        && entry
            .get("input_modalities")
            .is_some_and(serde_json::Value::is_array)
}

// 检查缓存元数据大小并读取其中可用模型模板，失败返回空。
pub(super) fn load_codex_model_catalog_templates(
    codex_home: Option<&Path>,
) -> Vec<serde_json::Map<String, serde_json::Value>> {
    let Some(cache_path) = codex_home.map(|home| home.join(CODEX_MODELS_CACHE_FILE_NAME)) else {
        return Vec::new();
    };
    let Ok(metadata) = fs::metadata(&cache_path) else {
        return Vec::new();
    };
    if !metadata.is_file() || metadata.len() > MAX_CODEX_MODEL_CACHE_BYTES {
        return Vec::new();
    }
    let Ok(payload) = fs::read(cache_path) else {
        return Vec::new();
    };
    let Ok(catalog) = serde_json::from_slice::<serde_json::Value>(&payload) else {
        return Vec::new();
    };
    catalog
        .get("models")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_object)
        .filter(|entry| is_usable_codex_model_catalog_entry(entry))
        .cloned()
        .collect()
}

// 按模型匹配或首选模板生成 Provider 模型能力目录。
pub(super) fn build_codex_model_catalog(
    codex_home: Option<&Path>,
    provider: &RemoteCodexProviderLaunch,
) -> CodexModelCatalog {
    let templates = load_codex_model_catalog_templates(codex_home);
    let preferred_template = provider
        .model
        .as_deref()
        .and_then(|model| {
            templates
                .iter()
                .find(|entry| entry.get("slug").and_then(serde_json::Value::as_str) == Some(model))
        })
        .or_else(|| templates.first());
    let models = provider
        .models
        .iter()
        .enumerate()
        .map(|(priority, model)| {
            let template = templates
                .iter()
                .find(|entry| {
                    entry.get("slug").and_then(serde_json::Value::as_str) == Some(model.as_str())
                })
                .or(preferred_template);
            let mut entry = template
                .cloned()
                .map(serde_json::Value::Object)
                .unwrap_or_else(fallback_codex_model_catalog_entry);
            let object = entry
                .as_object_mut()
                .expect("Codex model catalog template must be an object");
            object.insert("slug".to_string(), model.clone().into());
            object.insert("display_name".to_string(), model.clone().into());
            object.insert("description".to_string(), provider.name.clone().into());
            object.insert("visibility".to_string(), "list".into());
            object.insert("supported_in_api".to_string(), true.into());
            object.insert("priority".to_string(), (priority as u64).into());
            object.insert("availability_nux".to_string(), serde_json::Value::Null);
            object.insert("upgrade".to_string(), serde_json::Value::Null);
            entry
        })
        .collect();
    CodexModelCatalog { models }
}

// 写入隔离发现目录的模型目录、配置及 Provider profile。
pub(super) fn write_codex_model_discovery_home(
    directory: &Path,
    codex_home: Option<&Path>,
    provider: &RemoteCodexProviderLaunch,
) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|err| format!("create Codex model discovery directory failed: {err}"))?;
    let config = toml::to_string_pretty(&CodexModelDiscoveryConfig {
        model_catalog_json: CODEX_MODEL_CATALOG_FILE_NAME,
    })
    .map_err(|err| format!("serialize Codex model discovery config failed: {err}"))?;
    let catalog = build_codex_model_catalog(codex_home, provider);
    let mut catalog = serde_json::to_vec_pretty(&catalog)
        .map_err(|err| format!("serialize Codex model discovery catalog failed: {err}"))?;
    catalog.push(b'\n');
    write_file_atomically(
        &directory.join(CODEX_MODEL_CATALOG_FILE_NAME),
        &catalog,
        "Codex model discovery catalog",
    )?;
    write_file_atomically(
        &directory.join(CONFIG_FILE_NAME),
        config.as_bytes(),
        "Codex model discovery config",
    )?;
    write_file_atomically(
        &directory.join(format!("{}.config.toml", provider.profile_name)),
        provider.profile_text.as_bytes(),
        "Codex model discovery Provider profile",
    )
}

// 从 data 或 models 数组提取字符串或对象中的模型标识。
pub(super) fn parse_codex_models_response(payload: &[u8]) -> Vec<String> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Vec::new();
    };
    let Some(items) = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            item.as_str().map(str::to_string).or_else(|| {
                ["id", "model", "name"]
                    .into_iter()
                    .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
                    .map(str::to_string)
            })
        })
        .collect()
}

// 按代理策略限时请求模型端点并在流式字节上限内解析结果。
pub(super) async fn discover_codex_provider_models(
    base_url: &str,
    secret: &str,
    proxy_enabled: bool,
    proxy: Option<&ResolvedProxy>,
) -> Result<Vec<String>, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(CODEX_MODEL_DISCOVERY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if !proxy_enabled {
        builder = builder.no_proxy();
    } else if let Some(proxy) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(&proxy.url)
                .map_err(|err| format!("configure Codex model proxy failed: {err}"))?,
        );
    }
    let client = builder
        .build()
        .map_err(|err| format!("build Codex model client failed: {err}"))?;
    let mut response = client
        .get(codex_models_endpoint(base_url)?)
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|err| format!("query Codex Provider models failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "query Codex Provider models returned HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CODEX_MODEL_RESPONSE_BYTES as u64)
    {
        return Err("Codex Provider models response is too large".to_string());
    }
    let mut payload = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("read Codex Provider models failed: {err}"))?
    {
        if payload.len().saturating_add(chunk.len()) > MAX_CODEX_MODEL_RESPONSE_BYTES {
            return Err("Codex Provider models response is too large".to_string());
        }
        payload.extend_from_slice(&chunk);
    }
    Ok(parse_codex_models_response(&payload))
}

#[cfg(target_os = "windows")]
// 将随应用提供的 Windows 原生 Codex 代理按摘要复制为包装器。
pub(super) fn write_codex_profile_wrapper() -> Result<PathBuf, String> {
    // cc-connect v1.4.1 hardcodes `codex` for its app-server backend. A native
    // GUI-subsystem shim is required here because a batch shim allocates a console.
    let wrapper_dir = remote_manager_dir()?.join("bin");
    fs::create_dir_all(&wrapper_dir)
        .map_err(|err| format!("create Codex wrapper directory failed: {err}"))?;
    let source = env::current_exe()
        .map_err(|err| format!("resolve CLI-Manager executable failed: {err}"))?
        .with_file_name("cli-manager-codex-proxy.exe");
    if !source.is_file() {
        return Err(format!(
            "bundled Codex app-server proxy is missing: {}",
            path_string(&source)
        ));
    }
    let wrapper_path = wrapper_dir.join("codex.exe");
    copy_file_atomically_if_changed(&source, &wrapper_path, "Codex app-server proxy")?;
    Ok(wrapper_path)
}

#[cfg(not(target_os = "windows"))]
// 写入非 Windows Codex 包装脚本并确保可执行权限。
pub(super) fn write_codex_profile_wrapper() -> Result<PathBuf, String> {
    let wrapper_dir = remote_manager_dir()?.join("bin");
    fs::create_dir_all(&wrapper_dir)
        .map_err(|err| format!("create Codex wrapper directory failed: {err}"))?;
    let wrapper_path = wrapper_dir.join("codex");
    let payload = codex_profile_wrapper_payload();
    write_executable_file_atomically_if_changed(
        &wrapper_path,
        payload.as_bytes(),
        "Codex profile wrapper",
    )?;
    Ok(wrapper_path)
}

// 准备本地 Provider 或 SSH 启动、模型目录、包装器及预期会话绑定。
pub(super) fn prepare_remote_codex_launch(
    profile: &CcConnectProfile,
    project: &RegisteredProject,
    local_launcher: Option<&ResolvedAgentLauncher>,
) -> Result<Option<RemoteCodexLaunch>, String> {
    if profile.agent != CcConnectAgent::Codex {
        return Ok(None);
    }
    let ssh_launch = (project.environment_type == "ssh")
        .then(|| load_ssh_codex_launch(project))
        .transpose()?;
    let codex_home = ssh_launch
        .is_none()
        .then(|| codex_config_dir(profile))
        .transpose()?;
    let provider = match (ssh_launch.is_none(), project.codex_provider_id.as_deref()) {
        (true, Some(provider_id)) => {
            let query_runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|err| format!("create provider query runtime failed: {err}"))?;
            let runtime = query_runtime.block_on(
                crate::provider::runtime::load_codex_runtime_config(provider_id),
            )?;
            crate::provider::runtime::write_codex_profile_to_dir(
                codex_home.as_deref().ok_or_else(|| {
                    "Codex home is unavailable for the registered Provider".to_string()
                })?,
                &runtime.profile,
            )?;
            let proxy = resolve_proxy_url_if_enabled(
                profile.proxy_enabled,
                profile.proxy_url.as_deref(),
                &LOCAL_PROXY_PORTS,
            )?;
            let discovered_models = query_runtime
                .block_on(discover_codex_provider_models(
                    &runtime.base_url,
                    &runtime.secret_value,
                    profile.proxy_enabled,
                    proxy.as_ref(),
                ))
                .unwrap_or_default();
            let model = runtime
                .model
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let profile_name = runtime.profile.profile_name.clone();
            let profile_text = runtime.profile.profile_text.clone();
            let model_provider = runtime.profile.model_provider.clone();
            Some(RemoteCodexProviderLaunch {
                name: project
                    .provider_name
                    .as_deref()
                    .map(single_line)
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| provider_id.to_string()),
                profile_name,
                profile_text,
                model_provider: model_provider.clone(),
                provider_name_override: codex_wrapper_override(
                    &codex_provider_override_key(&model_provider, "name")?,
                    "CLI-Manager remote",
                )?,
                models: normalize_managed_codex_models(model.as_deref(), discovered_models),
                model: model.clone(),
                base_url_override: codex_base_url_override(&model_provider, &runtime.base_url)?,
                env_key_override: codex_env_key_override(&model_provider, &runtime.env_key)?,
                model_override: codex_model_override(model.as_deref())?,
                wire_api_override: codex_wire_api_override(
                    &model_provider,
                    runtime.wire_api.as_deref(),
                )?,
                env_key: runtime.env_key,
                secret: runtime.secret_value,
            })
        }
        _ => None,
    };
    let discovery_codex_home = match provider.as_ref() {
        Some(provider) => {
            let path = remote_manager_dir()?.join("codex-model-discovery");
            write_codex_model_discovery_home(&path, codex_home.as_deref(), provider)?;
            Some(path)
        }
        None => None,
    };
    let wrapper_path = write_codex_profile_wrapper()?;
    let wrapper_dir = wrapper_path
        .parent()
        .ok_or_else(|| "Codex wrapper directory is missing".to_string())?
        .to_path_buf();
    let (launcher, launcher_args) = if ssh_launch.is_some() {
        (None, Vec::new())
    } else {
        let launcher = local_launcher.ok_or_else(|| "handoff_agent_unavailable".to_string())?;
        (Some(launcher.executable.clone()), launcher.args.clone())
    };
    let proxy_executable = env::current_exe()
        .map_err(|err| format!("resolve Codex app-server proxy failed: {err}"))?;
    let expected_session_id =
        handoff_session::load_handoff_record()?.map(|record| record.cli_session_id);
    Ok(Some(RemoteCodexLaunch {
        wrapper_dir,
        launcher,
        launcher_args,
        proxy_executable,
        expected_session_id,
        codex_home,
        discovery_codex_home,
        protocol_trace_path: profile.logging_enabled.then(log_path).transpose()?,
        provider,
        ssh_launch,
    }))
}

// 向子进程注入包装器 PATH、真实 Home 与启动覆盖并清除不适用变量。
pub(super) fn apply_remote_codex_launch_environment(
    command: &mut Command,
    launch: &RemoteCodexLaunch,
) -> Result<(), String> {
    let mut paths = vec![launch.wrapper_dir.clone()];
    if let Some(path_value) = env::var_os("PATH") {
        paths.extend(env::split_paths(&path_value));
    }
    let path_value =
        env::join_paths(paths).map_err(|err| format!("build Codex wrapper PATH failed: {err}"))?;
    command
        .env("PATH", path_value)
        .env(PROXY_EXECUTABLE_ENV, &launch.proxy_executable);
    match launch.launcher.as_ref() {
        Some(launcher) => {
            command.env(CODEX_LAUNCHER_ENV, launcher);
            if launch.launcher_args.is_empty() {
                command.env_remove(CODEX_LAUNCHER_ARGS_ENV);
            } else {
                command.env(
                    CODEX_LAUNCHER_ARGS_ENV,
                    serde_json::to_string(&launch.launcher_args)
                        .map_err(|err| format!("encode Codex launcher arguments failed: {err}"))?,
                );
            }
        }
        None => {
            command.env_remove(CODEX_LAUNCHER_ENV);
            command.env_remove(CODEX_LAUNCHER_ARGS_ENV);
        }
    }
    // The generated catalog directory is not a Codex home: redirecting CODEX_HOME
    // there hides the rollout database needed by thread/resume.
    match launch.codex_home.as_ref() {
        Some(codex_home) => {
            command.env("CODEX_HOME", codex_home);
        }
        None => {
            command.env_remove("CODEX_HOME");
        }
    }
    match launch.ssh_launch.as_ref() {
        Some(ssh_launch) => {
            command.env(CODEX_SSH_LAUNCH_ENV, ssh_launch.encode()?);
        }
        None => {
            command.env_remove(CODEX_SSH_LAUNCH_ENV);
        }
    }
    match launch.expected_session_id.as_ref() {
        Some(session_id) => {
            command.env(EXPECTED_SESSION_ID_ENV, session_id);
        }
        None => {
            command.env_remove(EXPECTED_SESSION_ID_ENV);
        }
    }
    match launch.protocol_trace_path.as_ref() {
        Some(path) => {
            command.env(CODEX_PROTOCOL_TRACE_PATH_ENV, path);
        }
        None => {
            command.env_remove(CODEX_PROTOCOL_TRACE_PATH_ENV);
        }
    }
    match launch.provider.as_ref() {
        Some(provider) => {
            let model_catalog_override = launch
                .discovery_codex_home
                .as_deref()
                .ok_or_else(|| "Codex model discovery directory is missing".to_string())
                .and_then(codex_model_catalog_override)?;
            command
                .env(CODEX_PROFILE_NAME_ENV, &provider.profile_name)
                .env(CODEX_MODEL_PROVIDER_ENV, &provider.model_provider)
                .env(
                    CODEX_PROVIDER_NAME_OVERRIDE_ENV,
                    &provider.provider_name_override,
                )
                .env(CODEX_BASE_URL_OVERRIDE_ENV, &provider.base_url_override)
                .env(CODEX_ENV_KEY_OVERRIDE_ENV, &provider.env_key_override)
                .env(CODEX_MODEL_CATALOG_OVERRIDE_ENV, model_catalog_override)
                .env(CODEX_WIRE_API_OVERRIDE_ENV, &provider.wire_api_override);
            match provider.model_override.as_ref() {
                Some(model_override) => {
                    command.env(CODEX_MODEL_OVERRIDE_ENV, model_override);
                }
                None => {
                    command.env_remove(CODEX_MODEL_OVERRIDE_ENV);
                }
            }
        }
        None => {
            command
                .env_remove(CODEX_PROFILE_NAME_ENV)
                .env_remove(CODEX_MODEL_PROVIDER_ENV)
                .env_remove(CODEX_PROVIDER_NAME_OVERRIDE_ENV)
                .env_remove(CODEX_BASE_URL_OVERRIDE_ENV)
                .env_remove(CODEX_ENV_KEY_OVERRIDE_ENV)
                .env_remove(CODEX_MODEL_CATALOG_OVERRIDE_ENV)
                .env_remove(CODEX_MODEL_OVERRIDE_ENV)
                .env_remove(CODEX_WIRE_API_OVERRIDE_ENV);
        }
    }
    Ok(())
}

// 构造 app-server stdio 探测参数及可选严格配置开关。
pub(super) fn codex_app_server_probe_args(strict_config: bool) -> Vec<&'static str> {
    let mut args = vec!["app-server"];
    if strict_config {
        args.push("--strict-config");
    }
    args.extend(["--listen", "stdio://"]);
    args
}

// 启动受限时长的代理探测，模型目录验证使用隔离 Home。
pub(super) fn probe_remote_codex_app_server(launch: &RemoteCodexLaunch) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = silent_command(&path_string(&launch.wrapper_dir.join("codex.exe")));
    #[cfg(not(target_os = "windows"))]
    let mut command = silent_command(&path_string(&launch.wrapper_dir.join("codex")));
    command.args(codex_app_server_probe_args(
        launch.discovery_codex_home.is_some(),
    ));
    if let Some(provider) = launch.provider.as_ref() {
        command.env(&provider.env_key, &provider.secret);
    }
    apply_remote_codex_launch_environment(&mut command, launch)?;
    if let Some(discovery_home) = launch.discovery_codex_home.as_ref() {
        // Strict validation remains isolated from the user's config. The managed
        // cc-connect process itself keeps the registered CODEX_HOME.
        command.env("CODEX_HOME", discovery_home);
    }
    let probe_timeout = launch
        .ssh_launch
        .as_ref()
        .map(|ssh| Duration::from_secs(ssh.transport.connect_timeout_sec.saturating_add(10)))
        .unwrap_or(CODEX_APP_SERVER_PROBE_TIMEOUT);
    let output = output_with_timeout(command, probe_timeout)
        .map_err(|err| format!("Codex app-server proxy probe failed: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = redact_remote_codex_probe_output(launch, &output.stdout, &output.stderr);
    Err(format!(
        "Codex app-server proxy probe exited with {}: {}",
        output.status,
        if detail.is_empty() {
            "no diagnostic output"
        } else {
            &detail
        }
    ))
}

// 解码探测输出并使用 Provider 秘密执行日志脱敏。
pub(super) fn redact_remote_codex_probe_output(
    launch: &RemoteCodexLaunch,
    stdout: &[u8],
    stderr: &[u8],
) -> String {
    let secrets = launch
        .provider
        .as_ref()
        .map(|provider| vec![provider.secret.clone()])
        .unwrap_or_default();
    redact_log_line(&output_text(stdout, stderr), &secrets)
}
