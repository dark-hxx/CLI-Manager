use super::catalog::get_provider;
use super::dto::{ProviderDetail, ProviderDocument, ProviderDocumentUpdateInput};
use super::support::{
    error, is_secret_key, load_provider, map_database_error, normalize_app_type, redact_json,
    redact_settings_config,
};
use crate::provider::database;
use serde_json::{Map, Value as JsonValue};
use toml_edit::{DocumentMut, Item, Table, Value as TomlValue};

const CLAUDE_SETTINGS_DOCUMENT: &str = "claude.settings";
const CODEX_AUTH_DOCUMENT: &str = "codex.auth";
const CODEX_CONFIG_DOCUMENT: &str = "codex.config";
const GROK_CONFIG_DOCUMENT: &str = "grokbuild.config";

// 按 CLI 类型生成带格式、敏感标记和有效性状态的配置文档；委托各格式脱敏器，未知类型返回空列表。
pub(crate) fn documents_from_settings(app_type: &str, raw: &str) -> Vec<ProviderDocument> {
    match app_type {
        "claude" => {
            let (value, has_secret, valid) = redact_settings_config(raw);
            vec![ProviderDocument {
                kind: CLAUDE_SETTINGS_DOCUMENT.to_string(),
                format: "json".to_string(),
                value,
                has_secret,
                valid,
            }]
        }
        "codex" => {
            let Ok(settings) = serde_json::from_str::<JsonValue>(raw) else {
                return vec![invalid_document(CODEX_AUTH_DOCUMENT, "json", raw)];
            };
            let auth = settings
                .get("auth")
                .cloned()
                .unwrap_or_else(|| JsonValue::Object(Map::new()));
            let (auth, auth_has_secret) = redact_json_value(auth);
            let auth_value =
                serde_json::to_string_pretty(&auth).unwrap_or_else(|_| "{}".to_string());
            let config = settings
                .get("config")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            let (config_value, config_has_secret, config_valid) = redact_toml_document(config);
            vec![
                ProviderDocument {
                    kind: CODEX_AUTH_DOCUMENT.to_string(),
                    format: "json".to_string(),
                    value: auth_value,
                    has_secret: auth_has_secret,
                    valid: auth.is_object(),
                },
                ProviderDocument {
                    kind: CODEX_CONFIG_DOCUMENT.to_string(),
                    format: "toml".to_string(),
                    value: config_value,
                    has_secret: config_has_secret,
                    valid: config_valid,
                },
            ]
        }
        "grokbuild" => {
            let Ok(settings) = serde_json::from_str::<JsonValue>(raw) else {
                return vec![invalid_document(GROK_CONFIG_DOCUMENT, "toml", raw)];
            };
            let config = settings
                .get("config")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            let (value, has_secret, valid) = redact_toml_document(config);
            vec![ProviderDocument {
                kind: GROK_CONFIG_DOCUMENT.to_string(),
                format: "toml".to_string(),
                value,
                has_secret,
                valid,
            }]
        }
        _ => Vec::new(),
    }
}

// 用固定占位符代替无效文档原文，敏感标记仅由文本关键词推断。
fn invalid_document(kind: &str, format: &str, raw: &str) -> ProviderDocument {
    let has_secret = [
        "token",
        "key",
        "secret",
        "password",
        "credential",
        "authorization",
    ]
    .iter()
    .any(|marker| raw.to_ascii_lowercase().contains(marker));
    ProviderDocument {
        kind: kind.to_string(),
        format: format.to_string(),
        value: "[INVALID CONFIG DOCUMENT]".to_string(),
        has_secret,
        valid: false,
    }
}

// 对拥有所有权的 JSON 值调用共享脱敏器，返回处理后的值及敏感字段命中标记。
fn redact_json_value(mut value: JsonValue) -> (JsonValue, bool) {
    let has_secret = redact_json(&mut value);
    (value, has_secret)
}

// 解析并按字段名脱敏 TOML；空白有效，解析失败时仅在命中敏感关键词后隐藏全文，否则保留原文。
pub(crate) fn redact_toml_document(raw: &str) -> (String, bool, bool) {
    if raw.trim().is_empty() {
        return (String::new(), false, true);
    }
    let Ok(mut document) = raw.parse::<DocumentMut>() else {
        let lower = raw.to_ascii_lowercase();
        let has_secret = [
            "token",
            "key",
            "secret",
            "password",
            "credential",
            "authorization",
        ]
        .iter()
        .any(|marker| lower.contains(marker));
        return (
            if has_secret {
                "[REDACTED TOML CONFIG]".to_string()
            } else {
                raw.to_string()
            },
            has_secret,
            false,
        );
    };
    let has_secret = redact_toml_item(document.as_item_mut());
    (document.to_string(), has_secret, true)
}

// 递归合并双方均为对象的节点，其他类型由供应商值整体替换，包括数组。
fn merge_json_values(common: &mut JsonValue, provider: JsonValue) {
    if let (Some(common_object), Some(provider_object)) =
        (common.as_object_mut(), provider.as_object())
    {
        for (key, value) in provider_object {
            if let Some(existing) = common_object.get_mut(key) {
                merge_json_values(existing, value.clone());
            } else {
                common_object.insert(key.clone(), value.clone());
            }
        }
    } else {
        *common = provider;
    }
}

#[cfg(test)]
// 测试专用 JSON 文本合并入口，解析后按供应商优先规则合并并格式化输出。
pub(crate) fn merge_json_documents(common: &str, provider: &str) -> Result<String, String> {
    let mut common = serde_json::from_str::<JsonValue>(common)
        .map_err(|_| error("provider_common_config_invalid_json", "common"))?;
    let provider = serde_json::from_str::<JsonValue>(provider)
        .map_err(|_| error("provider_settings_invalid_json", "provider"))?;
    merge_json_values(&mut common, provider);
    serde_json::to_string_pretty(&common).map_err(|_| error("provider_config_merge_failed", ""))
}

// 递归合并普通 TOML 表，其他结构由供应商项整体替换，不逐项合并数组或内联表。
fn merge_toml_items(common: &mut Item, provider: Item) {
    if let (Some(common_table), Some(provider_table)) = (common.as_table_mut(), provider.as_table())
    {
        let entries = provider_table
            .iter()
            .map(|(key, item)| (key.to_string(), item.clone()))
            .collect::<Vec<_>>();
        for (key, item) in entries {
            if let Some(existing) = common_table.get_mut(&key) {
                merge_toml_items(existing, item);
            } else {
                common_table.insert(&key, item);
            }
        }
    } else {
        *common = provider;
    }
}

// 将空白解析为空文档，其他内容按 TOML 语法解析并附上调用方提供的错误位置。
fn parse_toml_document(raw: &str, kind: &str) -> Result<DocumentMut, String> {
    if raw.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    raw.parse::<DocumentMut>()
        .map_err(|_| error("provider_common_config_invalid_toml", kind))
}

// 判断 TOML 语法解析是否成功，接受空白文档，不校验 CLI 字段语义。
pub(crate) fn is_valid_toml_document(raw: &str) -> bool {
    parse_toml_document(raw, "value").is_ok()
}

// 要求供应商设置为 JSON 对象；Claude 直接深合并，其余类型合并内嵌 TOML 配置，供应商值优先。
pub(crate) fn merge_common_into_settings(
    app_type: &str,
    common: &str,
    provider: &str,
) -> Result<String, String> {
    let mut settings = serde_json::from_str::<JsonValue>(provider)
        .map_err(|_| error("provider_settings_invalid_json", "provider"))?;
    if !settings.is_object() {
        return Err(error("provider_settings_must_be_object", "provider"));
    }
    if app_type == "claude" {
        let mut common = serde_json::from_str::<JsonValue>(common)
            .map_err(|_| error("provider_common_config_invalid_json", "common"))?;
        let provider = settings.clone();
        merge_json_values(&mut common, provider);
        return serde_json::to_string_pretty(&common)
            .map_err(|_| error("provider_config_merge_failed", app_type));
    }

    let mut common = parse_toml_document(common, "common")?;
    let provider_config = settings
        .get("config")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let provider_config = parse_toml_document(provider_config, "provider")?;
    merge_toml_items(common.as_item_mut(), provider_config.into_item());
    settings
        .as_object_mut()
        .expect("validated settings object")
        .insert("config".to_string(), JsonValue::String(common.to_string()));
    serde_json::to_string_pretty(&settings)
        .map_err(|_| error("provider_config_merge_failed", app_type))
}

// 仅投影生效视图的 Codex 模型，不改存储文档；无效文档保持原状供原有修复界面展示。
pub(super) fn project_effective_model(app_type: &str, raw: &str) -> String {
    if app_type != "codex" {
        return raw.to_string();
    }
    let Ok(mut settings) = serde_json::from_str::<JsonValue>(raw) else {
        return raw.to_string();
    };
    if !settings.is_object() {
        return raw.to_string();
    }
    let config = settings
        .get("config")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let Ok(mut document) = config.parse::<DocumentMut>() else {
        return raw.to_string();
    };
    crate::provider::global::project_codex_model(&settings, &mut document);
    settings["config"] = JsonValue::String(document.to_string());
    settings.to_string()
}

// 按项类型分派脱敏；表数组使用 any，首个返回 true 的表之后不会继续遍历。
fn redact_toml_item(item: &mut Item) -> bool {
    match item {
        Item::Table(table) => redact_toml_table(table),
        Item::ArrayOfTables(tables) => {
            let mut found_secret = false;
            for table in tables.iter_mut() {
                if redact_toml_table(table) {
                    found_secret = true;
                }
            }
            found_secret
        }
        Item::Value(value) => redact_toml_value(value),
        Item::None => false,
    }
}

// 遍历普通表，将敏感键对应整项替换为占位符，其他字段递归处理并累计命中状态。
fn redact_toml_table(table: &mut Table) -> bool {
    let mut found_secret = false;
    for (key, item) in table.iter_mut() {
        if is_secret_key(key.get()) {
            *item = Item::Value(TomlValue::from("[REDACTED]"));
            found_secret = true;
        } else if redact_toml_item(item) {
            found_secret = true;
        }
    }
    found_secret
}

// 遍历内联表和普通数组清理敏感字段，标量值不按内容扫描。
fn redact_toml_value(value: &mut TomlValue) -> bool {
    let mut found_secret = false;
    if let Some(table) = value.as_inline_table_mut() {
        for (key, child) in table.iter_mut() {
            if is_secret_key(key.get()) {
                *child = TomlValue::from("[REDACTED]");
                found_secret = true;
            } else if redact_toml_value(child) {
                found_secret = true;
            }
        }
    }
    if let Some(array) = value.as_array_mut() {
        for child in array.iter_mut() {
            if redact_toml_value(child) {
                found_secret = true;
            }
        }
    }
    found_secret
}

// 把空字符串、固定星号/脱敏占位符及含省略号字符的字符串视为遮罩值。
fn is_masked_secret(value: &JsonValue) -> bool {
    value
        .as_str()
        .map(|value| {
            value.is_empty() || value == "***" || value == "[REDACTED]" || value.contains('…')
        })
        .unwrap_or(false)
}

// 按对象键和数组位置递归检查新增敏感字段是否已有对应键；已有敏感键的值由后续保留逻辑处理。
fn reject_new_json_secrets(
    existing: Option<&JsonValue>,
    incoming: &JsonValue,
    detail: &str,
) -> Result<(), String> {
    match incoming {
        JsonValue::Object(incoming_object) => {
            let existing_object = existing.and_then(JsonValue::as_object);
            for (key, value) in incoming_object {
                if is_secret_key(key) {
                    if existing_object.and_then(|object| object.get(key)).is_none() {
                        return Err(error(
                            "provider_document_secret_edit_requires_key_manager",
                            detail,
                        ));
                    }
                } else {
                    reject_new_json_secrets(
                        existing_object.and_then(|object| object.get(key)),
                        value,
                        detail,
                    )?;
                }
            }
        }
        JsonValue::Array(incoming_items) => {
            let existing_items = existing.and_then(JsonValue::as_array);
            for (index, value) in incoming_items.iter().enumerate() {
                reject_new_json_secrets(
                    existing_items.and_then(|items| items.get(index)),
                    value,
                    detail,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

// 递归处理双方均为对象的节点，恢复缺失或遮罩敏感值并拒绝修改；不遍历数组或恢复整个缺失的非敏感父节点。
fn preserve_json_secrets(existing: &JsonValue, incoming: &mut JsonValue) -> Result<(), String> {
    match (existing, incoming) {
        (JsonValue::Object(existing_object), JsonValue::Object(incoming_object)) => {
            for (key, existing_value) in existing_object {
                if is_secret_key(key) {
                    match incoming_object.get(key) {
                        None => {
                            incoming_object.insert(key.clone(), existing_value.clone());
                        }
                        Some(value) if is_masked_secret(value) => {
                            incoming_object.insert(key.clone(), existing_value.clone());
                        }
                        Some(value) if value != existing_value => {
                            return Err(error(
                                "provider_document_secret_edit_requires_key_manager",
                                key,
                            ));
                        }
                        _ => {}
                    }
                } else if let Some(incoming_value) = incoming_object.get_mut(key) {
                    preserve_json_secrets(existing_value, incoming_value)?;
                }
            }
        }
        (JsonValue::Array(existing_items), JsonValue::Array(incoming_items)) => {
            for (existing_item, incoming_item) in existing_items.iter().zip(incoming_items) {
                preserve_json_secrets(existing_item, incoming_item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

// 解析对象形式的文档替换值，先拒绝新增敏感键，再按对象递归规则保留已有凭据。
fn patch_json_document(
    existing: &JsonValue,
    value: &str,
    detail: &str,
) -> Result<JsonValue, String> {
    let mut incoming = serde_json::from_str::<JsonValue>(value)
        .map_err(|_| error("provider_config_invalid", detail))?;
    if !incoming.is_object() {
        return Err(error("provider_config_must_be_object", detail));
    }
    reject_new_json_secrets(Some(existing), &incoming, detail)?;
    preserve_json_secrets(existing, &mut incoming)?;
    Ok(incoming)
}

// 拒绝新增已识别的字符串敏感路径，并覆盖仍存在路径的值以保留旧凭据；缺失路径不补回，遍历范围由路径收集器决定。
pub(crate) fn preserve_toml_secrets(
    existing: &str,
    incoming: &mut DocumentMut,
) -> Result<(), String> {
    let Ok(existing_document) = existing.parse::<DocumentMut>() else {
        if toml_item_contains_secret(incoming.as_item()) {
            return Err(error(
                "provider_document_secret_edit_requires_key_manager",
                "toml",
            ));
        }
        return Ok(());
    };
    reject_new_toml_secrets(
        Some(existing_document.as_item()),
        incoming.as_item(),
        "toml",
    )?;
    preserve_toml_item(existing_document.as_item(), incoming.as_item_mut());
    Ok(())
}

fn toml_item_contains_secret(item: &Item) -> bool {
    match item {
        Item::Table(table) => table
            .iter()
            .any(|(key, child)| is_secret_key(key) || toml_item_contains_secret(child)),
        Item::ArrayOfTables(tables) => tables.iter().any(|table| {
            table
                .iter()
                .any(|(key, child)| is_secret_key(key) || toml_item_contains_secret(child))
        }),
        Item::Value(value) => toml_value_contains_secret(value),
        Item::None => false,
    }
}

fn toml_value_contains_secret(value: &TomlValue) -> bool {
    if let Some(table) = value.as_inline_table() {
        return table
            .iter()
            .any(|(key, child)| is_secret_key(key) || toml_value_contains_secret(child));
    }
    value
        .as_array()
        .is_some_and(|array| array.iter().any(toml_value_contains_secret))
}

fn reject_new_toml_secrets(
    existing: Option<&Item>,
    incoming: &Item,
    path: &str,
) -> Result<(), String> {
    match incoming {
        Item::Table(table) => {
            let existing = existing.and_then(Item::as_table);
            for (key, child) in table.iter() {
                let detail = format!("{path}.{key}");
                let existing_child = existing.and_then(|table| table.get(key));
                if (is_secret_key(key) || toml_item_contains_secret(child))
                    && existing_child.is_none()
                {
                    return Err(error(
                        "provider_document_secret_edit_requires_key_manager",
                        detail,
                    ));
                }
                if !is_secret_key(key) {
                    reject_new_toml_secrets(existing_child, child, &detail)?;
                }
            }
        }
        Item::ArrayOfTables(tables) => {
            let existing = existing.and_then(Item::as_array_of_tables);
            for (index, table) in tables.iter().enumerate() {
                let existing_table = existing.and_then(|tables| tables.get(index));
                for (key, child) in table.iter() {
                    let detail = format!("{path}[{index}].{key}");
                    let existing_child = existing_table.and_then(|table| table.get(key));
                    if (is_secret_key(key) || toml_item_contains_secret(child))
                        && existing_child.is_none()
                    {
                        return Err(error(
                            "provider_document_secret_edit_requires_key_manager",
                            detail,
                        ));
                    }
                    if !is_secret_key(key) {
                        reject_new_toml_secrets(existing_child, child, &detail)?;
                    }
                }
            }
        }
        Item::Value(value) => {
            reject_new_toml_value_secrets(existing.and_then(Item::as_value), value, path)?
        }
        Item::None => {}
    }
    Ok(())
}

// 递归检查内联表与普通数组；输入新增任何敏感分支时拒绝由文档编辑器直接写入。
fn reject_new_toml_value_secrets(
    existing: Option<&TomlValue>,
    incoming: &TomlValue,
    path: &str,
) -> Result<(), String> {
    if let Some(table) = incoming.as_inline_table() {
        let existing = existing.and_then(TomlValue::as_inline_table);
        for (key, child) in table.iter() {
            let detail = format!("{path}.{key}");
            let existing_child = existing.and_then(|table| table.get(key));
            if (is_secret_key(key) || toml_value_contains_secret(child)) && existing_child.is_none()
            {
                return Err(error(
                    "provider_document_secret_edit_requires_key_manager",
                    detail,
                ));
            }
            if !is_secret_key(key) {
                reject_new_toml_value_secrets(existing_child, child, &detail)?;
            }
        }
    } else if let Some(array) = incoming.as_array() {
        let existing = existing.and_then(TomlValue::as_array);
        for (index, child) in array.iter().enumerate() {
            let existing_child = existing.and_then(|array| array.get(index));
            if toml_value_contains_secret(child) && existing_child.is_none() {
                return Err(error(
                    "provider_document_secret_edit_requires_key_manager",
                    format!("{path}[{index}]"),
                ));
            }
            reject_new_toml_value_secrets(existing_child, child, &format!("{path}[{index}]"))?;
        }
    }
    Ok(())
}

fn preserve_toml_item(existing: &Item, incoming: &mut Item) {
    match (existing, incoming) {
        (Item::Table(existing), Item::Table(incoming)) => {
            for (key, child) in existing.iter() {
                if is_secret_key(key) {
                    incoming.insert(key, child.clone());
                } else if let Some(target) = incoming.get_mut(key) {
                    preserve_toml_item(child, target);
                } else if toml_item_contains_secret(child) {
                    incoming.insert(key, child.clone());
                }
            }
        }
        (Item::ArrayOfTables(existing), Item::ArrayOfTables(incoming)) => {
            for (index, table) in existing.iter().enumerate() {
                if let Some(target) = incoming.get_mut(index) {
                    preserve_toml_table(table, target);
                } else if table
                    .iter()
                    .any(|(key, child)| is_secret_key(key) || toml_item_contains_secret(child))
                {
                    incoming.push(table.clone());
                }
            }
        }
        (Item::Value(existing), Item::Value(incoming)) => {
            preserve_toml_value(existing, incoming);
        }
        _ => {}
    }
}

// 按表键递归恢复既有敏感值；输入缺失整个敏感子树时复制原节点。
fn preserve_toml_table(existing: &Table, incoming: &mut Table) {
    for (key, child) in existing.iter() {
        if is_secret_key(key) {
            incoming.insert(key, child.clone());
        } else if let Some(target) = incoming.get_mut(key) {
            preserve_toml_item(child, target);
        } else if toml_item_contains_secret(child) {
            incoming.insert(key, child.clone());
        }
    }
}

fn preserve_toml_value(existing: &TomlValue, incoming: &mut TomlValue) {
    if let (Some(existing), Some(incoming)) =
        (existing.as_inline_table(), incoming.as_inline_table_mut())
    {
        for (key, child) in existing.iter() {
            if is_secret_key(key) {
                incoming.insert(key, child.clone());
            } else if let Some(target) = incoming.get_mut(key) {
                preserve_toml_value(child, target);
            } else if toml_value_contains_secret(child) {
                incoming.insert(key, child.clone());
            }
        }
        return;
    }
    if let (Some(existing), Some(incoming)) = (existing.as_array(), incoming.as_array_mut()) {
        for (index, child) in existing.iter().enumerate() {
            if let Some(target) = incoming.get_mut(index) {
                preserve_toml_value(child, target);
            } else if toml_value_contains_secret(child) {
                incoming.push(child.clone());
            }
        }
    }
}

// 按类型与文档种类替换 JSON 设置/auth 或内嵌 TOML，调用各自凭据保留逻辑后序列化，不写数据库。
fn patch_settings_document(
    app_type: &str,
    raw_settings: &str,
    kind: &str,
    value: &str,
) -> Result<String, String> {
    let mut settings = serde_json::from_str::<JsonValue>(raw_settings)
        .map_err(|_| error("provider_config_invalid", "settings_config"))?;
    if !settings.is_object() {
        return Err(error("provider_config_must_be_object", "settings_config"));
    }
    match (app_type, kind) {
        ("claude", CLAUDE_SETTINGS_DOCUMENT) => {
            let existing = settings.clone();
            settings = patch_json_document(&existing, value, kind)?;
        }
        ("codex", CODEX_AUTH_DOCUMENT) => {
            let existing = settings
                .get("auth")
                .cloned()
                .unwrap_or_else(|| JsonValue::Object(Map::new()));
            let auth = patch_json_document(&existing, value, kind)?;
            settings
                .as_object_mut()
                .expect("validated settings object")
                .insert("auth".to_string(), auth);
        }
        ("codex", CODEX_CONFIG_DOCUMENT) | ("grokbuild", GROK_CONFIG_DOCUMENT) => {
            let mut config = value
                .parse::<DocumentMut>()
                .map_err(|_| error("provider_config_invalid", kind))?;
            let existing = settings
                .get("config")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            preserve_toml_secrets(existing, &mut config)?;
            settings
                .as_object_mut()
                .expect("validated settings object")
                .insert("config".to_string(), JsonValue::String(config.to_string()));
        }
        _ => return Err(error("provider_document_kind_invalid", kind)),
    }
    serde_json::to_string(&settings).map_err(|_| error("provider_config_serialize_failed", kind))
}

// 读取供应商并生成更新配置后写库，再另读详情；无跨读取与更新的事务或版本检查，不直接写 CLI Home。
pub(crate) async fn update_provider_document(
    input: ProviderDocumentUpdateInput,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let mut connection = database::open_connection().await?;
    let provider = load_provider(&mut connection, &app_type, input.provider_id.trim()).await?;
    let settings_config = patch_settings_document(
        &app_type,
        &provider.settings_config,
        input.kind.trim(),
        &input.value,
    )?;
    sqlx::query(
        "UPDATE providers SET settings_config = ?1
         WHERE id = ?2 AND app_type = ?3",
    )
    .bind(settings_config)
    .bind(&provider.id)
    .bind(&app_type)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_document_update_failed", err))?;
    drop(connection);
    get_provider(app_type, provider.id).await
}

#[cfg(test)]
mod tests {
    use super::{documents_from_settings, patch_settings_document, redact_toml_document};
    use serde_json::Value;

    // 双模型记录经公共合并和生效投影后，预览必须与实际 materialize 一致且保留未知项。
    #[test]
    fn effective_codex_model_matches_global_materialization() {
        let provider = serde_json::json!({
            "model": "abc/sdf",
            "config": "# provider comment\nmodel = \"old-model\" # model note\ncustom_setting = 42\n"
        })
        .to_string();
        for common in [None, Some("model = \"common-model\"\ncommon_setting = true\n")] {
            let effective = match common {
                Some(common) => super::merge_common_into_settings("codex", common, &provider).unwrap(),
                None => provider.clone(),
            };
            let preview: serde_json::Value =
                serde_json::from_str(&super::project_effective_model("codex", &effective)).unwrap();
            let preview_doc = preview["config"]
                .as_str().unwrap().parse::<toml_edit::DocumentMut>().unwrap();
            let effective: serde_json::Value = serde_json::from_str(&effective).unwrap();
            let (written, _) = crate::provider::global::materialize_codex_config(None, &effective).unwrap();
            let written_doc = String::from_utf8(written)
                .unwrap().parse::<toml_edit::DocumentMut>().unwrap();
            assert_eq!(preview_doc["model"].as_str(), Some("abc/sdf"));
            assert_eq!(preview_doc["model"].as_str(), written_doc["model"].as_str());
            assert_eq!(preview_doc["custom_setting"].as_integer(), Some(42));
            if common.is_some() {
                assert_eq!(preview_doc["common_setting"].as_bool(), Some(true));
            }
            // 公共合并可能已调整文档前导注释；投影只负责保留传入结果中的格式。
            assert_eq!(
                preview["config"].as_str().unwrap().contains("# provider comment"),
                effective["config"].as_str().unwrap().contains("# provider comment")
            );
            assert!(preview["config"].as_str().unwrap().contains("# model note"));
        }
    }

    #[test]
    fn effective_codex_model_keeps_toml_when_explicit_model_is_empty() {
        for model in [serde_json::Value::Null, serde_json::json!(""), serde_json::json!("  ")] {
            let raw = serde_json::json!({"model": model, "config": "model = \"abc/sdf\"\n"}).to_string();
            let preview: serde_json::Value =
                serde_json::from_str(&super::project_effective_model("codex", &raw)).unwrap();
            assert_eq!(preview["config"], "model = \"abc/sdf\"\n");
        }
    }

    #[test]
    fn effective_model_preserves_other_types_and_invalid_drafts() {
        for (app_type, raw) in [
            ("claude", r#"{"model":"abc/sdf"}"#),
            ("grokbuild", r#"{"model":"abc/sdf","config":"model = 'old'"}"#),
            ("codex", r#"{"model":"abc/sdf","config":"model ="}"#),
            ("codex", "not-json"),
            ("codex", "[]"),
        ] {
            assert_eq!(super::project_effective_model(app_type, raw), raw);
        }
    }

    #[test]
    // 验证样例 TOML 脱敏保留注释与端点、移除密钥，并返回有效和敏感命中标记。
    fn redacts_toml_secret_without_dropping_comments() {
        let raw = "# keep this comment\n[provider]\nbase_url = \"https://example.test\"\napi_key = \"sk-secret\"\n";
        let (redacted, has_secret, valid) = redact_toml_document(raw);
        assert!(valid);
        assert!(has_secret);
        assert!(redacted.contains("# keep this comment"));
        assert!(redacted.contains("https://example.test"));
        assert!(!redacted.contains("sk-secret"));
    }

    #[test]
    fn redacts_secrets_from_every_array_of_tables_entry() {
        let raw = r#"[[providers]]
api_key = "first-secret"

[[providers]]
api_key = "second-secret"
"#;
        let (redacted, has_secret, valid) = redact_toml_document(raw);
        assert!(valid);
        assert!(has_secret);
        assert!(!redacted.contains("first-secret"));
        assert!(!redacted.contains("second-secret"));
        assert_eq!(redacted.matches("[REDACTED]").count(), 2);
    }

    #[test]
    // 验证 Codex auth 与 TOML 中的遮罩被还原为原凭据，同时允许模型字段更新。
    fn codex_document_patch_preserves_redacted_credentials() {
        let existing = r##"{
            "auth": {"OPENAI_API_KEY": "sk-secret"},
            "config": "# keep\nmodel = \"gpt-test\"\napi_key = \"toml-secret\"\n"
        }"##;
        let updated_auth = patch_settings_document(
            "codex",
            existing,
            "codex.auth",
            r#"{"OPENAI_API_KEY":"***"}"#,
        )
        .unwrap();
        let updated_auth: Value = serde_json::from_str(&updated_auth).unwrap();
        assert_eq!(updated_auth["auth"]["OPENAI_API_KEY"], "sk-secret");

        let updated_config = patch_settings_document(
            "codex",
            &updated_auth.to_string(),
            "codex.config",
            "# keep\nmodel = \"gpt-new\"\napi_key = \"[REDACTED]\"\n",
        )
        .unwrap();
        let updated_config: Value = serde_json::from_str(&updated_config).unwrap();
        assert!(updated_config["config"]
            .as_str()
            .unwrap()
            .contains("gpt-new"));
        assert!(updated_config["config"]
            .as_str()
            .unwrap()
            .contains("toml-secret"));
    }

    #[test]
    // 验证向 Claude JSON 和 Codex TOML 样例新增敏感字段时要求使用密钥管理入口。
    fn document_patch_rejects_new_secret_fields() {
        let json_error = patch_settings_document(
            "claude",
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.test"}}"#,
            "claude.settings",
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.test","ANTHROPIC_AUTH_TOKEN":"new-secret"}}"#,
        )
        .unwrap_err();
        assert!(json_error.contains("provider_document_secret_edit_requires_key_manager"));

        let toml_error = patch_settings_document(
            "codex",
            r#"{"config":"model = \"gpt-test\"\n"}"#,
            "codex.config",
            "model = \"gpt-test\"\napi_key = \"new-secret\"\n",
        )
        .unwrap_err();
        assert!(toml_error.contains("provider_document_secret_edit_requires_key_manager"));
    }

    #[test]
    fn toml_document_patch_preserves_table_array_and_inline_array_secrets() {
        let existing = r#"{"config":"[[providers]]\nname = \"one\"\napi_key = \"first\"\n\n[[providers]]\nname = \"two\"\napi_key = \"second\"\n\nitems = [{ api_key = \"nested\" }]\n"}"#;
        let incoming = "[[providers]]\nname = \"one-new\"\napi_key = \"[REDACTED]\"\n\n[[providers]]\nname = \"two-new\"\napi_key = \"***\"\n\nitems = [{ api_key = \"[REDACTED]\" }]\n";

        let updated = patch_settings_document("codex", existing, "codex.config", incoming).unwrap();
        let value: Value = serde_json::from_str(&updated).unwrap();
        let config = value["config"].as_str().unwrap();
        assert!(config.contains("api_key = \"first\""));
        assert!(config.contains("api_key = \"second\""));
        assert!(config.contains("api_key = \"nested\""));
        assert!(config.contains("name = \"one-new\""));
    }

    #[test]
    fn toml_document_patch_rejects_a_new_secret_in_an_extra_table_array_entry() {
        let existing = r#"{"config":"[[providers]]\nname = \"one\"\n"}"#;
        let incoming = "[[providers]]\nname = \"one\"\n\n[[providers]]\napi_key = \"new-secret\"\n";

        assert!(
            patch_settings_document("codex", existing, "codex.config", incoming)
                .unwrap_err()
                .contains("provider_document_secret_edit_requires_key_manager")
        );
    }

    #[test]
    fn json_document_patch_preserves_secrets_inside_arrays() {
        let existing = r#"{"items":[{"api_key":"first"},{"api_key":"second"}]}"#;
        let updated = patch_settings_document(
            "claude",
            existing,
            "claude.settings",
            r#"{"items":[{"api_key":"***"},{"api_key":"[REDACTED]"}]}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&updated).unwrap();

        assert_eq!(value["items"][0]["api_key"], "first");
        assert_eq!(value["items"][1]["api_key"], "second");
    }

    #[test]
    // 验证 Codex 文档列表按 auth/config 顺序输出，并标记样例认证敏感值及配置有效性。
    fn document_listing_exposes_type_specific_documents() {
        let documents = documents_from_settings(
            "codex",
            r#"{"auth":{"OPENAI_API_KEY":"secret"},"config":"model = \"gpt-test\"\n"}"#,
        );
        assert_eq!(
            documents
                .iter()
                .map(|document| document.kind.as_str())
                .collect::<Vec<_>>(),
            ["codex.auth", "codex.config",]
        );
        assert!(documents[0].has_secret);
        assert!(documents[1].valid);
    }

    #[test]
    // 验证样例损坏 JSON 的文档展示只返回固定占位符，不包含原始凭据文本。
    fn invalid_provider_document_never_returns_raw_content() {
        let documents = documents_from_settings(
            "codex",
            r#"{"auth":{"OPENAI_API_KEY":"secret"},"config":"not valid json""#,
        );
        assert_eq!(documents[0].value, "[INVALID CONFIG DOCUMENT]");
        assert!(documents[0].has_secret);
        assert!(!documents[0].value.contains("secret"));
    }
}
