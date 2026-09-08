use serde_json::{Map, Value};
use toml_edit::{DocumentMut, Item, Table, Value as TomlValue};

const DEFAULT_PROFILE: &str = "cli_manager";
const DEFAULT_API_BACKEND: &str = "responses";
const DEFAULT_CONTEXT_WINDOW: i64 = 500_000;

#[derive(Debug, Clone, Copy)]
pub(crate) enum CredentialProjection<'a> {
    Preserve,
    Inline(&'a str),
}

// 将供应商设置解析为 JSON 对象；语法错误或非对象根节点统一返回配置无效。
fn parse_settings(raw: &str) -> Result<Map<String, Value>, String> {
    let value =
        serde_json::from_str::<Value>(raw).map_err(|_| "provider_config_invalid".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "provider_config_invalid".to_string())
}

// 将缺失或纯空白配置视为空 TOML 文档，否则解析并返回稳定的配置错误。
fn parse_config(raw: Option<&str>) -> Result<DocumentMut, String> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(DocumentMut::new());
    };
    raw.parse::<DocumentMut>()
        .map_err(|_| "provider_config_invalid".to_string())
}

// 提取 JSON 字符串并裁剪首尾空白；非字符串和空文本返回 None。
fn non_empty_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

// 按候选键顺序返回设置对象中首个非空字符串。
fn top_level_text(settings: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| non_empty_text(settings.get(*key)))
}

// 从可选 TOML 项的指定子键提取非空字符串，不转换其他值类型。
fn item_text(item: Option<&Item>, key: &str) -> Option<String> {
    item.and_then(|item| item.get(key))
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

// 读取 TOML 表中的非空字符串字段，忽略非字符串值。
fn table_text(table: &Table, key: &str) -> Option<String> {
    table
        .get(key)
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

// 依次采用 models.default、设置中的 profile/模型别名、首个 model 表项，最后回退到内置配置名。
fn profile_from_config(document: &DocumentMut, settings: &Map<String, Value>) -> String {
    item_text(document.get("models"), "default")
        .or_else(|| top_level_text(settings, &["profile", "default_model", "defaultModel"]))
        .or_else(|| {
            document
                .get("model")
                .and_then(Item::as_table)
                .and_then(|table| table.iter().next().map(|(name, _)| name.to_string()))
        })
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string())
}

// 设置默认配置名并创建或取得 model 下的配置表；遇到非普通表结构返回错误，先前的内存修改不回滚。
fn ensure_profile<'a>(
    document: &'a mut DocumentMut,
    profile: &str,
) -> Result<&'a mut Table, String> {
    let models = document
        .entry("models")
        .or_insert(toml_edit::table())
        .as_table_mut()
        .ok_or_else(|| "provider_config_invalid:invalid_grok_models".to_string())?;
    models.insert("default", toml_edit::value(profile));

    let model_table = document
        .entry("model")
        .or_insert(toml_edit::table())
        .as_table_mut()
        .ok_or_else(|| "provider_config_invalid:invalid_grok_model".to_string())?;
    model_table
        .entry(profile)
        .or_insert(toml_edit::table())
        .as_table_mut()
        .ok_or_else(|| "provider_config_invalid:invalid_grok_model".to_string())
}

// 按规范化字段名及 token/secret/password/api_key 等后缀识别敏感键；不检测字段值中的秘密。
fn is_secret_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    matches!(
        normalized.as_str(),
        "access_token"
            | "refresh_token"
            | "oauth_token"
            | "authorization"
            | "auth_header"
            | "bearer"
            | "password"
            | "passwd"
            | "secret"
            | "client_secret"
            | "clientsecret"
            | "api_key"
            | "apikey"
    ) || normalized.ends_with("_token")
        || normalized.ends_with("token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("secret")
        || normalized.ends_with("_password")
        || normalized.ends_with("password")
        || normalized.ends_with("_api_key")
        || normalized.ends_with("apikey")
}

// 递归清理 TOML 内联表的敏感键及数组内嵌结构，标量内容本身不做脱敏。
fn remove_secret_value(value: &mut TomlValue) {
    if let Some(table) = value.as_inline_table_mut() {
        let keys = table
            .iter()
            .filter(|(key, _)| is_secret_key(key.as_ref()))
            .map(|(key, _)| key.to_string())
            .collect::<Vec<_>>();
        for key in keys {
            table.remove(&key);
        }
        for (_, child) in table.iter_mut() {
            remove_secret_value(child);
        }
    }
    if let Some(array) = value.as_array_mut() {
        for child in array.iter_mut() {
            remove_secret_value(child);
        }
    }
}

// 按 TOML 项类型分派普通表、表数组及值的敏感字段清理，空项不处理。
fn remove_secret_fields(item: &mut Item) {
    match item {
        Item::Table(table) => remove_secret_fields_from_table(table),
        Item::ArrayOfTables(tables) => {
            for table in tables.iter_mut() {
                remove_secret_fields_from_table(table);
            }
        }
        Item::Value(value) => remove_secret_value(value),
        Item::None => {}
    }
}

// 先删除当前表的敏感键，再递归处理保留字段下的嵌套结构。
fn remove_secret_fields_from_table(table: &mut Table) {
    let keys = table
        .iter()
        .filter(|(key, _)| is_secret_key(key.as_ref()))
        .map(|(key, _)| key.to_string())
        .collect::<Vec<_>>();
    for key in keys {
        table.remove(&key);
    }
    for (_, child) in table.iter_mut() {
        remove_secret_fields(child);
    }
}

// 移除旧式顶层供应商字段及字符串 model；保留正式 model 表以免丢失配置项。
fn remove_legacy_root_fields(document: &mut DocumentMut) {
    for key in [
        "base_url",
        "baseUrl",
        "endpoint",
        "default_model",
        "defaultModel",
        "provider",
        "env_key",
        "api_key",
        "apiKey",
        "api_format",
    ] {
        document.remove(key);
    }
    // Grok Build's official shape owns a top-level `[model]` table.  Only
    // remove the legacy scalar form; deleting the table loses every profile
    // before `apply_fields` can project the selected one.
    if document.get("model").and_then(Item::as_str).is_some() {
        document.remove("model");
    }
}

// 用来源文档替换目标的 models/model 两个所有权字段；来源缺失时删除目标对应字段，其他顶层内容不动。
fn copy_owned_model_config(source: &DocumentMut, target: &mut DocumentMut) {
    for key in ["models", "model"] {
        if let Some(item) = source.get(key) {
            target[key] = item.clone();
        } else {
            target.remove(key);
        }
    }
}

// 遍历普通 model 表下所有配置项并递归清理敏感字段；缺失或非普通表时不处理。
fn remove_model_profile_secrets(document: &mut DocumentMut) {
    let Some(model) = document.get_mut("model").and_then(Item::as_table_mut) else {
        return;
    };
    for (_, profile) in model.iter_mut() {
        remove_secret_fields(profile);
    }
}

// 只返回 model 下指定名称的普通 TOML 表，缺失或其他结构返回 None。
fn selected_table<'a>(document: &'a DocumentMut, profile: &str) -> Option<&'a Table> {
    document
        .get("model")
        .and_then(Item::as_table)
        .and_then(|table| table.get(profile))
        .and_then(Item::as_table)
}

// 合并顶层设置与所选配置的模型字段及默认值，按凭据模式保留或替换密钥；可选校验在内存修改后执行。
fn apply_fields(
    document: &mut DocumentMut,
    settings: &Map<String, Value>,
    credential: CredentialProjection<'_>,
    require_model_fields: bool,
) -> Result<(String, Vec<String>), String> {
    let profile = profile_from_config(document, settings);
    let existing = selected_table(document, &profile);
    let base_url = top_level_text(settings, &["base_url", "baseUrl", "endpoint"])
        .or_else(|| existing.and_then(|table| table_text(table, "base_url")));
    let model = top_level_text(settings, &["model", "default_model", "defaultModel"])
        .or_else(|| existing.and_then(|table| table_text(table, "model")));
    let api_backend = top_level_text(settings, &["api_format", "apiFormat", "format"])
        .or_else(|| existing.and_then(|table| table_text(table, "api_backend")))
        .unwrap_or_else(|| DEFAULT_API_BACKEND.to_string());
    let name = existing
        .and_then(|table| table_text(table, "name"))
        .or_else(|| top_level_text(settings, &["name"]))
        .unwrap_or_else(|| profile.clone());
    let context_window = existing
        .and_then(|table| table.get("context_window"))
        .and_then(Item::as_integer)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW);

    let selected = ensure_profile(document, &profile)?;
    if !matches!(credential, CredentialProjection::Preserve) {
        remove_secret_fields_from_table(selected);
    }
    if let Some(base_url) = base_url.filter(|value| !value.trim().is_empty()) {
        selected.insert("base_url", toml_edit::value(base_url));
    }
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        selected.insert("model", toml_edit::value(model));
    }
    selected.insert("name", toml_edit::value(name));
    selected.insert("api_backend", toml_edit::value(api_backend));
    selected.insert("context_window", toml_edit::value(context_window));
    match credential {
        CredentialProjection::Preserve => {}
        CredentialProjection::Inline(secret) => {
            selected.insert("api_key", toml_edit::value(secret));
            selected.remove("env_key");
        }
    }
    let base_url = table_text(selected, "base_url");
    let model = table_text(selected, "model");
    if require_model_fields && base_url.is_none() {
        return Err("provider_config_invalid:missing_grok_base_url".to_string());
    }
    if require_model_fields && model.is_none() {
        return Err("provider_config_invalid:missing_grok_model".to_string());
    }
    Ok((
        profile.clone(),
        vec!["models".to_string(), format!("model.{profile}")],
    ))
}

// 将显式类型化字段投影到内嵌 TOML 并保留现有凭据，移除指定顶层旧字段后返回 JSON；不写磁盘。
pub(crate) fn apply_typed_fields(
    raw: &str,
    base_url: Option<&str>,
    model: Option<&str>,
    api_format: Option<&str>,
) -> Result<String, String> {
    let mut settings = parse_settings(raw)?;
    let mut typed = settings.clone();
    if let Some(value) = base_url {
        typed.insert("base_url".to_string(), Value::String(value.to_string()));
    }
    if let Some(value) = model {
        typed.insert("model".to_string(), Value::String(value.to_string()));
    }
    if let Some(value) = api_format {
        typed.insert("api_format".to_string(), Value::String(value.to_string()));
    }
    let config = settings
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut document = parse_config(Some(config))?;
    apply_fields(&mut document, &typed, CredentialProjection::Preserve, false)?;
    settings.insert("config".to_string(), Value::String(document.to_string()));
    for key in ["base_url", "baseUrl", "endpoint", "model", "api_format"] {
        settings.remove(key);
    }
    serde_json::to_string(&Value::Object(settings))
        .map_err(|_| "provider_settings_serialize_failed".to_string())
}

// 将给定密钥写入所选 TOML 配置并清理该配置的旧敏感字段及顶层 api_key/apiKey，返回含密钥的 JSON。
pub(crate) fn project_key(raw: &str, secret: &str) -> Result<String, String> {
    let mut settings = parse_settings(raw)?;
    let config = settings
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut document = parse_config(Some(config))?;
    apply_fields(
        &mut document,
        &settings,
        CredentialProjection::Inline(secret),
        false,
    )?;
    settings.insert("config".to_string(), Value::String(document.to_string()));
    for key in ["api_key", "apiKey"] {
        settings.remove(key);
    }
    serde_json::to_string(&Value::Object(settings))
        .map_err(|_| "provider_settings_serialize_failed".to_string())
}

// 在已有配置上替换供应商拥有的模型配置，按凭据模式清理密钥并校验必需模型字段，返回字节及所有权路径，不执行文件写入。
pub(crate) fn materialize(
    before: Option<&[u8]>,
    effective_raw: &Value,
    credential: CredentialProjection<'_>,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let settings = effective_raw
        .as_object()
        .ok_or_else(|| "provider_config_invalid".to_string())?;
    let source = parse_config(settings.get("config").and_then(Value::as_str))?;
    let mut target = match before {
        Some(bytes) if !bytes.iter().all(u8::is_ascii_whitespace) => {
            let raw =
                std::str::from_utf8(bytes).map_err(|_| "provider_config_invalid".to_string())?;
            raw.parse::<DocumentMut>()
                .map_err(|_| "provider_config_invalid".to_string())?
        }
        _ => DocumentMut::new(),
    };
    copy_owned_model_config(&source, &mut target);
    remove_legacy_root_fields(&mut target);
    if !matches!(credential, CredentialProjection::Preserve) {
        remove_model_profile_secrets(&mut target);
    }
    let (profile, owned_fields) = apply_fields(&mut target, settings, credential, true)?;
    let models = target
        .get("models")
        .and_then(Item::as_table)
        .ok_or_else(|| "provider_config_invalid:missing_grok_models".to_string())?;
    if table_text(models, "default").as_deref() != Some(profile.as_str()) {
        return Err("provider_config_invalid:invalid_grok_default_model".to_string());
    }
    Ok((target.to_string().into_bytes(), owned_fields))
}

// 提取端点、模型和协议摘要，优先顶层字段再读取所选 TOML 配置；无效 TOML 回退顶层值，无效 JSON 返回全空。
pub(crate) fn summary(raw: &str) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(settings) = serde_json::from_str::<Value>(raw) else {
        return (None, None, None);
    };
    let Some(settings) = settings.as_object() else {
        return (None, None, None);
    };
    let config = settings
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Ok(document) = parse_config(Some(config)) else {
        return (
            top_level_text(settings, &["base_url", "baseUrl", "endpoint"]),
            top_level_text(settings, &["model", "default_model", "defaultModel"]),
            top_level_text(settings, &["api_format", "apiFormat", "format"]),
        );
    };
    let profile = profile_from_config(&document, settings);
    let selected = selected_table(&document, &profile);
    (
        top_level_text(settings, &["base_url", "baseUrl", "endpoint"])
            .or_else(|| selected.and_then(|table| table_text(table, "base_url"))),
        top_level_text(settings, &["model", "default_model", "defaultModel"])
            .or_else(|| selected.and_then(|table| table_text(table, "model"))),
        top_level_text(settings, &["api_format", "apiFormat", "format"])
            .or_else(|| selected.and_then(|table| table_text(table, "api_backend"))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CONFIG: &str = "# keep\n[cli]\nauto_update = true\n\n[models]\ndefault = \"proxy\"\nweb_search = \"grok-4.5\"\n\n[model.proxy]\nmodel = \"grok-4.5\"\nbase_url = \"https://old.example/v1\"\nname = \"Old\"\napi_key = \"old-secret\"\napi_backend = \"responses\"\ncontext_window = 128000\n\n[mcp_servers.demo]\ncommand = \"demo\"\n";

    #[test]
    // 验证摘要能从 models.default 选中的 Grok 配置读取端点、模型和协议。
    fn summary_reads_selected_grok_model() {
        let raw = json!({"config": CONFIG}).to_string();
        assert_eq!(
            summary(&raw),
            (
                Some("https://old.example/v1".to_string()),
                Some("grok-4.5".to_string()),
                Some("responses".to_string())
            )
        );
    }

    #[test]
    // 验证类型化字段更新嵌套模型配置、保留默认配置选择，并去除顶层 base_url。
    fn typed_fields_update_official_nested_shape() {
        let raw = json!({"config": CONFIG}).to_string();
        let updated = apply_typed_fields(
            &raw,
            Some("https://new.example/v1"),
            Some("grok-new"),
            Some("chat_completions"),
        )
        .unwrap();
        let config = serde_json::from_str::<Value>(&updated).unwrap()["config"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(config.contains("default = \"proxy\""));
        assert!(config.contains("base_url = \"https://new.example/v1\""));
        assert!(config.contains("model = \"grok-new\""));
        assert!(config.contains("api_backend = \"chat_completions\""));
        assert!(!updated.contains("\"base_url\""));
    }

    #[test]
    // 验证新密钥投影到所选配置，旧密钥消失且输出不含 env_key。
    fn project_key_uses_selected_model_table() {
        let raw = json!({"config": CONFIG}).to_string();
        let projected = project_key(&raw, "new-secret").unwrap();
        let projected_value = serde_json::from_str::<Value>(&projected).unwrap();
        let config = projected_value["config"].as_str().unwrap();
        let document = config.parse::<DocumentMut>().unwrap();
        let selected = selected_table(&document, "proxy").unwrap();
        assert_eq!(
            table_text(selected, "api_key").as_deref(),
            Some("new-secret")
        );
        assert!(!config.contains("old-secret"));
        assert!(!config.contains("env_key"));
    }

    #[test]
    // 验证配置生成保留已有非所有权 mcp 段，写入新密钥并清除旧密钥。
    fn global_materializer_writes_inline_secret_and_preserves_unowned_sections() {
        let effective = json!({"config": CONFIG});
        let (bytes, _) = materialize(
            Some(b"[mcp]\nenabled = true\n"),
            &effective,
            CredentialProjection::Inline("new-secret"),
        )
        .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("[mcp]"));
        assert!(text.contains("api_key = \"new-secret\""));
        assert!(!text.contains("old-secret"));
        assert!(!text.contains("env_key"));
    }

    #[test]
    // 验证内联凭据模式也清理未选中配置的密钥，输出仅保留新投影密钥。
    fn global_materializer_removes_secrets_from_unselected_profiles() {
        let effective = json!({
            "config": format!(
                "{CONFIG}\n[model.other]\nmodel = \"other\"\napi_key = \"other-secret\"\n"
            )
        });
        let (bytes, _) =
            materialize(None, &effective, CredentialProjection::Inline("new-secret")).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("api_key = \"new-secret\""));
        assert!(!text.contains("other-secret"));
        assert!(!text.contains("api_key = \"other-secret\""));
    }

    #[test]
    // 验证旧式顶层端点、模型和协议被转换为正式默认模型配置，不再输出 api_format 字段。
    fn legacy_top_level_fields_are_normalized() {
        let effective = json!({
            "base_url": "https://legacy.example/v1",
            "model": "grok-legacy",
            "api_format": "responses",
            "config": "[mcp]\nenabled = true\n"
        });
        let (bytes, _) =
            materialize(None, &effective, CredentialProjection::Inline("secret")).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("default = \"cli_manager\""));
        assert!(text.contains("model = \"grok-legacy\""));
        assert!(text.contains("base_url = \"https://legacy.example/v1\""));
        assert!(text.contains("api_key = \"secret\""));
        assert!(!text.contains("api_format ="));
    }
}
