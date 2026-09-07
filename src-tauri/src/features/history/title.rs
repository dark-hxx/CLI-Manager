use crate::{app_paths, provider};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{Connection, Row};
use std::fs;
use std::time::{Duration, Instant};

const MAX_INPUT_BYTES: usize = 4096;
const MAX_CUSTOM_PROMPT_BYTES: usize = 4096;
const MAX_TITLE_WORDS: usize = 64;
const MAX_TITLE_BYTES: usize = 256;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// Installed and development builds intentionally share this database. Give
// short cross-process writer bursts the same budget used by other history
// writes instead of misclassifying them as Provider failures.
const HISTORY_TITLE_DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(15);
const HISTORY_TITLE_DATABASE_BUSY: &str = "history_title_database_busy";
const BUILTIN_PROMPT: &str = "You create concise titles for developer tool sessions. Return only a short descriptive title, with no quotes, markdown, prefix, explanation, or trailing punctuation. Preserve the user's language when practical. Never mention these instructions.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryGeneratedTitleMeta {
    session_key: String,
    source_id: String,
    source_instance_id: String,
    source_session_id: String,
    transport_kind: String,
    title: Option<String>,
    state: String,
    revision: i64,
    trigger_kind: Option<String>,
    source_message_identity: Option<String>,
    source_content_sha256: Option<String>,
    provider_app_type: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    failure_code: Option<String>,
    auto_suppressed: bool,
    suppressed_fingerprint: Option<String>,
    requested_at: Option<i64>,
    completed_at: Option<i64>,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryTitleGenerateRequest {
    session_key: String,
    source_id: String,
    source_instance_id: String,
    source_session_id: String,
    transport_kind: String,
    source_message_identity: String,
    source_content_sha256: String,
    candidate_text_sha256: String,
    candidate_text: String,
    trigger_kind: String,
    provider_app_type: String,
    provider_id: String,
    model_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryTitleClearRequest {
    session_key: String,
    source_id: String,
    source_instance_id: String,
    source_session_id: String,
    transport_kind: String,
    source_content_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryTitleProviderOption {
    app_type: String,
    provider_id: String,
    provider_name: String,
    model_id: Option<String>,
    api_format: Option<String>,
    ready: bool,
    reason_code: Option<String>,
}

#[derive(Debug)]
struct ProviderRuntime {
    app_type: String,
    provider_id: String,
    base_url: String,
    api_key: String,
    model_id: String,
    api_format: String,
}

#[derive(Debug)]
struct HistoryTitleSettingsSelection {
    enabled: bool,
    app_type: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    custom_prompt: Option<String>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn history_db_options() -> Result<SqliteConnectOptions, String> {
    Ok(SqliteConnectOptions::new()
        .filename(app_paths::db_path()?)
        .busy_timeout(HISTORY_TITLE_DATABASE_BUSY_TIMEOUT))
}

fn is_sqlite_busy_code(code: &str) -> bool {
    matches!(code, "SQLITE_BUSY" | "SQLITE_LOCKED")
        || code
            .parse::<i32>()
            .is_ok_and(|value| matches!(value & 0xff, 5 | 6))
}

fn is_sqlite_busy_error(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|database_error| database_error.code())
        .is_some_and(|code| is_sqlite_busy_code(code.as_ref()))
        || {
            let message = error.to_string().to_ascii_lowercase();
            message.contains("database is locked")
                || message.contains("database table is locked")
                || message.contains("(code: 5)")
                || message.contains("(code: 6)")
        }
}

fn map_history_database_error(error_code: &str, error: sqlx::Error) -> String {
    if is_sqlite_busy_error(&error) {
        HISTORY_TITLE_DATABASE_BUSY.to_string()
    } else {
        format!("{error_code}: {error}")
    }
}

fn is_history_database_error_code(error: &str) -> bool {
    error == HISTORY_TITLE_DATABASE_BUSY
        || error.starts_with("history_title_database_")
        || error.starts_with("history_title_schema_failed")
}

async fn open_history_connection() -> Result<SqliteConnection, String> {
    SqliteConnection::connect_with(&history_db_options()?)
        .await
        .map_err(|err| map_history_database_error("history_title_database_open_failed", err))
}

async fn ensure_table(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS history_generated_titles (
            session_key             TEXT PRIMARY KEY,
            source_id               TEXT NOT NULL,
            source_instance_id      TEXT NOT NULL DEFAULT '',
            source_session_id       TEXT NOT NULL,
            transport_kind          TEXT NOT NULL DEFAULT 'local',
            generated_title         TEXT,
            generation_state        TEXT NOT NULL DEFAULT 'idle'
                                    CHECK (generation_state IN ('idle','pending','succeeded','failed')),
            generation_revision     INTEGER NOT NULL DEFAULT 0,
            trigger_kind            TEXT
                                    CHECK (trigger_kind IS NULL OR trigger_kind IN ('automatic','manual')),
            source_message_identity TEXT,
            source_content_sha256   TEXT,
            provider_app_type       TEXT,
            provider_id             TEXT,
            model_id                TEXT,
            failure_code            TEXT,
            auto_suppressed         INTEGER NOT NULL DEFAULT 0 CHECK (auto_suppressed IN (0,1)),
            suppressed_fingerprint  TEXT,
            requested_at            INTEGER,
            completed_at            INTEGER,
            updated_at              INTEGER NOT NULL
        )"#,
    )
    .execute(&mut *connection)
    .await
    .map_err(|err| map_history_database_error("history_title_schema_failed", err))?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_history_generated_titles_source_identity ON history_generated_titles(source_id, source_instance_id, source_session_id)",
    )
    .execute(&mut *connection)
    .await
    .map_err(|err| map_history_database_error("history_title_schema_failed", err))?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_history_generated_titles_state ON history_generated_titles(generation_state, updated_at DESC)",
    )
    .execute(&mut *connection)
    .await
    .map_err(|err| map_history_database_error("history_title_schema_failed", err))?;
    Ok(())
}

fn row_meta(row: &SqliteRow) -> Result<HistoryGeneratedTitleMeta, String> {
    Ok(HistoryGeneratedTitleMeta {
        session_key: row
            .try_get("session_key")
            .map_err(|_| "history_title_database_row_invalid")?,
        source_id: row
            .try_get("source_id")
            .map_err(|_| "history_title_database_row_invalid")?,
        source_instance_id: row
            .try_get("source_instance_id")
            .map_err(|_| "history_title_database_row_invalid")?,
        source_session_id: row
            .try_get("source_session_id")
            .map_err(|_| "history_title_database_row_invalid")?,
        transport_kind: row
            .try_get("transport_kind")
            .map_err(|_| "history_title_database_row_invalid")?,
        title: row
            .try_get("generated_title")
            .map_err(|_| "history_title_database_row_invalid")?,
        state: row
            .try_get("generation_state")
            .map_err(|_| "history_title_database_row_invalid")?,
        revision: row
            .try_get("generation_revision")
            .map_err(|_| "history_title_database_row_invalid")?,
        trigger_kind: row
            .try_get("trigger_kind")
            .map_err(|_| "history_title_database_row_invalid")?,
        source_message_identity: row
            .try_get("source_message_identity")
            .map_err(|_| "history_title_database_row_invalid")?,
        source_content_sha256: row
            .try_get("source_content_sha256")
            .map_err(|_| "history_title_database_row_invalid")?,
        provider_app_type: row
            .try_get("provider_app_type")
            .map_err(|_| "history_title_database_row_invalid")?,
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "history_title_database_row_invalid")?,
        model_id: row
            .try_get("model_id")
            .map_err(|_| "history_title_database_row_invalid")?,
        failure_code: row
            .try_get("failure_code")
            .map_err(|_| "history_title_database_row_invalid")?,
        auto_suppressed: row
            .try_get::<i64, _>("auto_suppressed")
            .map_err(|_| "history_title_database_row_invalid")?
            != 0,
        suppressed_fingerprint: row
            .try_get("suppressed_fingerprint")
            .map_err(|_| "history_title_database_row_invalid")?,
        requested_at: row
            .try_get("requested_at")
            .map_err(|_| "history_title_database_row_invalid")?,
        completed_at: row
            .try_get("completed_at")
            .map_err(|_| "history_title_database_row_invalid")?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|_| "history_title_database_row_invalid")?,
    })
}

async fn select_meta(
    connection: &mut SqliteConnection,
    session_key: &str,
) -> Result<Option<HistoryGeneratedTitleMeta>, String> {
    let row = sqlx::query("SELECT * FROM history_generated_titles WHERE session_key = ?1")
        .bind(session_key)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|err| map_history_database_error("history_title_database_read_failed", err))?;
    row.map(|value| row_meta(&value)).transpose()
}

fn validate_text(value: &str, max_bytes: usize, error_code: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.as_bytes().len() > max_bytes || value.contains('\0') {
        return Err(error_code.to_string());
    }
    Ok(value.to_string())
}

fn normalize_custom_prompt(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.as_bytes().len() > MAX_CUSTOM_PROMPT_BYTES || value.contains('\0')
    {
        return None;
    }
    Some(value.to_string())
}

fn effective_prompt(selection: Option<&HistoryTitleSettingsSelection>) -> &str {
    selection
        .and_then(|selection| selection.custom_prompt.as_deref())
        .unwrap_or(BUILTIN_PROMPT)
}

fn validate_generate_request(request: &HistoryTitleGenerateRequest) -> Result<(), String> {
    validate_text(
        &request.session_key,
        512,
        "history_title_session_key_invalid",
    )?;
    validate_text(&request.source_id, 64, "history_title_source_invalid")?;
    validate_text(
        &request.source_instance_id,
        2048,
        "history_title_source_instance_invalid",
    )?;
    validate_text(
        &request.source_session_id,
        512,
        "history_title_source_session_invalid",
    )?;
    validate_text(
        &request.source_message_identity,
        4096,
        "history_title_message_identity_invalid",
    )?;
    validate_text(
        &request.source_content_sha256,
        128,
        "history_title_content_hash_invalid",
    )?;
    validate_text(
        &request.candidate_text_sha256,
        128,
        "history_title_candidate_hash_invalid",
    )?;
    validate_text(
        &request.candidate_text,
        MAX_INPUT_BYTES,
        "history_title_candidate_invalid",
    )?;
    validate_text(
        &request.provider_app_type,
        32,
        "history_title_provider_invalid",
    )?;
    validate_text(&request.provider_id, 512, "history_title_provider_invalid")?;
    validate_text(&request.model_id, 512, "history_title_model_invalid")?;
    if request.transport_kind != "local"
        && request.transport_kind != "wsl"
        && request.transport_kind != "ssh"
    {
        return Err("history_title_transport_not_supported".to_string());
    }
    if request.trigger_kind != "automatic" && request.trigger_kind != "manual" {
        return Err("history_title_trigger_invalid".to_string());
    }
    let source_hash = request.source_content_sha256.trim();
    if source_hash.len() != 64 || !source_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("history_title_content_hash_invalid".to_string());
    }
    let input_hash = format!("{:x}", Sha256::digest(request.candidate_text.as_bytes()));
    if !input_hash.eq_ignore_ascii_case(request.candidate_text_sha256.trim()) {
        return Err("history_title_candidate_changed".to_string());
    }
    Ok(())
}

fn valid_app_type(value: &str) -> bool {
    matches!(value, "claude" | "codex" | "grokbuild")
}

fn supported_api_format(app_type: &str, api_format: Option<&str>) -> bool {
    let format = api_format.unwrap_or_default().trim().to_ascii_lowercase();
    match app_type {
        "claude" => {
            format.is_empty()
                || matches!(
                    format.as_str(),
                    "anthropic"
                        | "messages"
                        | "anthropic_messages"
                        | "openai_chat"
                        | "chat"
                        | "chat_completions"
                        | "openai_responses"
                        | "responses"
                )
        }
        "codex" | "grokbuild" => {
            format.is_empty()
                || matches!(
                    format.as_str(),
                    "responses" | "openai_responses" | "chat" | "chat_completions" | "openai_chat"
                )
        }
        _ => false,
    }
}

fn protocol_for_format(app_type: &str, api_format: &str) -> Result<&'static str, String> {
    let format = api_format.trim().to_ascii_lowercase();
    if app_type == "claude"
        && matches!(
            format.as_str(),
            "anthropic" | "messages" | "anthropic_messages"
        )
    {
        return Ok("anthropic");
    }
    if matches!(format.as_str(), "chat" | "chat_completions" | "openai_chat") {
        return Ok("chat");
    }
    if matches!(format.as_str(), "responses" | "openai_responses") {
        return Ok("responses");
    }
    Err("history_title_provider_protocol_unsupported".to_string())
}

fn settings_selection() -> Option<HistoryTitleSettingsSelection> {
    let path = app_paths::cli_manager_data_dir()
        .ok()?
        .join("settings.json");
    let raw = fs::read_to_string(path).ok()?;
    let root = serde_json::from_str::<Value>(&raw).ok()?;
    let settings = root.get("historySmartTitle")?.as_object()?;
    let enabled = settings
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let app_type = settings
        .get("providerAppType")
        .and_then(Value::as_str)
        .map(str::to_string);
    let provider_id = settings
        .get("providerId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let model_id = settings
        .get("modelId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let custom_prompt =
        normalize_custom_prompt(settings.get("customPrompt").and_then(Value::as_str));
    Some(HistoryTitleSettingsSelection {
        enabled,
        app_type,
        provider_id,
        model_id,
        custom_prompt,
    })
}

fn validate_selection(
    selection: Option<&HistoryTitleSettingsSelection>,
    request: &HistoryTitleGenerateRequest,
) -> Result<(), String> {
    let Some(selection) = selection else {
        return Ok(());
    };
    if selection.app_type.as_deref() != Some(request.provider_app_type.trim())
        || selection.provider_id.as_deref() != Some(request.provider_id.trim())
        || selection.model_id.as_deref() != Some(request.model_id.trim())
    {
        return Err("history_title_provider_selection_changed".to_string());
    }
    Ok(())
}

fn validate_automatic_enabled(
    selection: Option<&HistoryTitleSettingsSelection>,
    request: &HistoryTitleGenerateRequest,
) -> Result<(), String> {
    if request.trigger_kind != "automatic" {
        return Ok(());
    }
    let Some(selection) = selection else {
        return Err("history_title_auto_disabled".to_string());
    };
    if selection.enabled {
        Ok(())
    } else {
        Err("history_title_auto_disabled".to_string())
    }
}

async fn load_provider_runtime(
    app_type: &str,
    provider_id: &str,
    model_id: &str,
) -> Result<ProviderRuntime, String> {
    if !valid_app_type(app_type) {
        return Err("history_title_provider_invalid".to_string());
    }
    if app_type == "codex" {
        let runtime = provider::runtime::load_codex_runtime_config(provider_id).await?;
        return Ok(ProviderRuntime {
            app_type: app_type.to_string(),
            provider_id: provider_id.trim().to_string(),
            base_url: runtime.base_url,
            api_key: runtime.secret_value,
            model_id: model_id.to_string(),
            api_format: runtime.wire_api.unwrap_or_else(|| "responses".to_string()),
        });
    }

    let mut connection = provider::open_connection().await?;
    let row =
        sqlx::query("SELECT settings_config, meta FROM providers WHERE id = ?1 AND app_type = ?2")
            .bind(provider_id.trim())
            .bind(app_type)
            .fetch_optional(&mut connection)
            .await
            .map_err(|_| "history_title_provider_database_error".to_string())?
            .ok_or_else(|| "history_title_provider_not_found".to_string())?;
    let settings_config: String = row
        .try_get("settings_config")
        .map_err(|_| "history_title_provider_database_error")?;
    let meta: String = row
        .try_get("meta")
        .map_err(|_| "history_title_provider_database_error")?;
    let meta = provider::repository::parse_meta(&meta);
    if !provider::repository::meta_enabled(&meta) {
        return Err("history_title_provider_disabled".to_string());
    }
    let api_key = sqlx::query_scalar::<_, String>(
        "SELECT api_key FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2 AND is_active = 1 AND enabled = 1
         LIMIT 1",
    )
    .bind(provider_id.trim())
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "history_title_provider_database_error".to_string())?
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| "history_title_provider_key_missing".to_string())?;
    let common_key = format!("common_config_{app_type}");
    let common = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(common_key)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "history_title_provider_database_error".to_string())?
        .unwrap_or_default();
    let merged = if provider::repository::meta_common_config_enabled(&meta) {
        provider::repository::merge_common_into_settings(app_type, &common, &settings_config)?
    } else {
        settings_config
    };
    let projected = provider::repository::project_key_into_settings(app_type, &merged, &api_key)?;
    let value = serde_json::from_str::<Value>(&projected)
        .map_err(|_| "history_title_provider_config_invalid".to_string())?;
    let (base_url, configured_model, api_format) = if app_type == "claude" {
        let env = value.get("env").and_then(Value::as_object);
        let configured_api_format = value
            .get("api_format")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| find_json_text(env, &["ANTHROPIC_API_FORMAT", "api_format", "apiFormat"]));
        (
            find_json_text(env, &["ANTHROPIC_BASE_URL", "base_url", "baseUrl"])
                .unwrap_or_else(|| "https://api.anthropic.com".to_string()),
            find_json_text(env, &["ANTHROPIC_MODEL", "model"]),
            configured_api_format.unwrap_or_else(|| "anthropic".to_string()),
        )
    } else {
        let (base_url, configured_model, api_format) = provider::grok::summary(&projected);
        (
            base_url.ok_or_else(|| "history_title_provider_base_url_missing".to_string())?,
            configured_model,
            api_format.unwrap_or_else(|| "responses".to_string()),
        )
    };
    let model_id = if model_id.trim().is_empty() {
        configured_model.ok_or_else(|| "history_title_provider_model_missing".to_string())?
    } else {
        model_id.trim().to_string()
    };
    if base_url.trim().is_empty() {
        return Err("history_title_provider_base_url_missing".to_string());
    }
    protocol_for_format(app_type, &api_format)?;
    Ok(ProviderRuntime {
        app_type: app_type.to_string(),
        provider_id: provider_id.trim().to_string(),
        base_url,
        api_key,
        model_id,
        api_format,
    })
}

fn find_json_text(object: Option<&Map<String, Value>>, keys: &[&str]) -> Option<String> {
    let object = object?;
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn request_endpoint_path(protocol: &str) -> &'static str {
    match protocol {
        "anthropic" => "v1/messages",
        "chat" => "v1/chat/completions",
        "responses" => "v1/responses",
        _ => "unknown",
    }
}

fn safe_error_code(error: &str) -> String {
    let mut code = String::new();
    for character in error.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            code.push(character);
        } else if !code.is_empty() {
            break;
        }
        if code.len() >= 96 {
            break;
        }
    }
    if code.is_empty() {
        "unknown".to_string()
    } else {
        code
    }
}

fn auxiliary_error_category(error: &provider::auxiliary_text::AuxiliaryTextError) -> &'static str {
    match error {
        provider::auxiliary_text::AuxiliaryTextError::Request(error) if error.is_timeout() => {
            "timeout"
        }
        provider::auxiliary_text::AuxiliaryTextError::Request(error) if error.is_connect() => {
            "connect"
        }
        provider::auxiliary_text::AuxiliaryTextError::Request(_) => "transport",
        provider::auxiliary_text::AuxiliaryTextError::ResponseTooLarge => "response_too_large",
        provider::auxiliary_text::AuxiliaryTextError::ResponseRead(_) => "response_read",
        provider::auxiliary_text::AuxiliaryTextError::ResponseInvalidUtf8 => {
            "response_invalid_utf8"
        }
    }
}

fn provider_error_diagnostics(value: &Value) -> (&'static str, &'static str) {
    let Some(error) = value.get("error") else {
        return ("absent", "unknown");
    };
    let Value::Object(error) = error else {
        return if error.is_string() {
            ("string", "unknown")
        } else if error.is_null() {
            ("null", "unknown")
        } else {
            ("other", "unknown")
        };
    };

    let has_code = error.get("code").and_then(Value::as_str).is_some();
    let has_type = error.get("type").and_then(Value::as_str).is_some();
    let has_message = error.get("message").and_then(Value::as_str).is_some();
    let shape = match (has_code, has_type, has_message) {
        (true, true, true) => "object_code_type_message",
        (true, true, false) => "object_code_type",
        (true, false, true) => "object_code_message",
        (false, true, true) => "object_type_message",
        (true, false, false) => "object_code",
        (false, true, false) => "object_type",
        (false, false, true) => "object_message",
        (false, false, false) => "object",
    };
    let evidence = ["code", "type", "message"]
        .iter()
        .filter_map(|key| error.get(*key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let category = if evidence.contains("api_key")
        || evidence.contains("api key")
        || evidence.contains("authentication")
        || evidence.contains("unauthorized")
        || evidence.contains("invalid_token")
    {
        "authentication"
    } else if evidence.contains("permission")
        || evidence.contains("forbidden")
        || evidence.contains("access_denied")
    {
        "permission"
    } else if evidence.contains("model") {
        "model"
    } else if evidence.contains("quota") || evidence.contains("billing") {
        "quota"
    } else if evidence.contains("rate_limit") || evidence.contains("rate limit") {
        "rate_limit"
    } else {
        "unknown"
    };
    (shape, category)
}

fn provider_error_diagnostics_from_body(body: &str) -> (&'static str, &'static str) {
    serde_json::from_str::<Value>(body)
        .map(|value| provider_error_diagnostics(&value))
        .unwrap_or(("non_json", "unknown"))
}

fn log_title_request_failure(
    runtime: &ProviderRuntime,
    protocol: &str,
    endpoint_path: &str,
    stage: &str,
    code: &str,
    http_status: u16,
    body_bytes: usize,
    error_shape: &str,
    error_category: &str,
    elapsed_ms: u128,
) {
    log::warn!(
        target: "cli_manager::history_title",
        "history.title.request.failure stage={} code={} app_type={} provider_id={} model_id={} api_format={} protocol={} endpoint_path={} http_status={} body_bytes={} provider_error_shape={} provider_error_category={} elapsed_ms={}",
        stage,
        code,
        runtime.app_type,
        runtime.provider_id,
        runtime.model_id,
        runtime.api_format,
        protocol,
        endpoint_path,
        http_status,
        body_bytes,
        error_shape,
        error_category,
        elapsed_ms
    );
}

fn session_key_log_hash(session_key: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(session_key.as_bytes()));
    format!("sha256:{}", &digest[..16])
}

async fn request_title(
    runtime: &ProviderRuntime,
    system_prompt: &str,
    candidate: &str,
) -> Result<String, String> {
    let started = Instant::now();
    let client = provider::network_client::configure_builder(reqwest::Client::builder())?
        .timeout(REQUEST_TIMEOUT)
        .user_agent("CLI-Manager history title")
        .build()
        .map_err(|_| "history_title_http_client_failed".to_string())?;
    let protocol_name = protocol_for_format(&runtime.app_type, &runtime.api_format)?;
    let protocol = match protocol_name {
        "anthropic" => provider::auxiliary_text::AuxiliaryTextProtocol::Anthropic,
        "chat" => provider::auxiliary_text::AuxiliaryTextProtocol::Chat,
        "responses" => provider::auxiliary_text::AuxiliaryTextProtocol::Responses,
        _ => return Err("history_title_provider_protocol_unsupported".to_string()),
    };
    let endpoint_path = request_endpoint_path(protocol_name);
    let auth_scheme = if protocol_name == "anthropic" {
        "x-api-key"
    } else {
        "bearer"
    };
    log::info!(
        target: "cli_manager::history_title",
        "history.title.request.start app_type={} provider_id={} model_id={} api_format={} protocol={} endpoint_path={} auth_scheme={} credential_source=active_provider_key input_bytes={} timeout_ms={}",
        runtime.app_type,
        runtime.provider_id,
        runtime.model_id,
        runtime.api_format,
        protocol_name,
        endpoint_path,
        auth_scheme,
        candidate.len(),
        REQUEST_TIMEOUT.as_millis()
    );
    let response = provider::auxiliary_text::post_text_request(
        &client,
        protocol,
        &runtime.base_url,
        &runtime.api_key,
        &runtime.model_id,
        system_prompt,
        candidate,
        64,
        REQUEST_TIMEOUT,
    )
    .await;
    let (status, body) = match response {
        Ok(response) => response,
        Err(error) => {
            let error_category = auxiliary_error_category(&error);
            let code = map_auxiliary_error(error);
            log_title_request_failure(
                runtime,
                protocol_name,
                endpoint_path,
                "transport",
                &code,
                0,
                0,
                "none",
                error_category,
                started.elapsed().as_millis(),
            );
            return Err(code);
        }
    };
    let elapsed_ms = started.elapsed().as_millis();
    log::info!(
        target: "cli_manager::history_title",
        "history.title.request.response app_type={} provider_id={} model_id={} protocol={} endpoint_path={} http_status={} body_bytes={} elapsed_ms={}",
        runtime.app_type,
        runtime.provider_id,
        runtime.model_id,
        protocol_name,
        endpoint_path,
        status,
        body.len(),
        elapsed_ms
    );
    if status == 429 {
        let (error_shape, error_category) = provider_error_diagnostics_from_body(&body);
        log_title_request_failure(
            runtime,
            protocol_name,
            endpoint_path,
            "http",
            "history_title_request_rate_limited",
            status,
            body.len(),
            error_shape,
            error_category,
            elapsed_ms,
        );
        return Err("history_title_request_rate_limited".to_string());
    }
    if !(200..300).contains(&status) {
        let code = format!("history_title_request_http_{status}");
        let (error_shape, error_category) = provider_error_diagnostics_from_body(&body);
        log_title_request_failure(
            runtime,
            protocol_name,
            endpoint_path,
            "http",
            &code,
            status,
            body.len(),
            error_shape,
            error_category,
            elapsed_ms,
        );
        return Err(code);
    }
    let value = match serde_json::from_str::<Value>(&body) {
        Ok(value) => value,
        Err(_) => {
            log_title_request_failure(
                runtime,
                protocol_name,
                endpoint_path,
                "response_parse",
                "history_title_response_invalid_json",
                status,
                body.len(),
                "non_json",
                "unknown",
                elapsed_ms,
            );
            return Err("history_title_response_invalid_json".to_string());
        }
    };
    if value.get("error").is_some_and(|error| !error.is_null()) {
        let (error_shape, error_category) = provider_error_diagnostics(&value);
        log_title_request_failure(
            runtime,
            protocol_name,
            endpoint_path,
            "provider_error",
            "history_title_provider_error",
            status,
            body.len(),
            error_shape,
            error_category,
            elapsed_ms,
        );
        return Err("history_title_provider_error".to_string());
    }
    if response_contains_tool_call(&value) {
        log_title_request_failure(
            runtime,
            protocol_name,
            endpoint_path,
            "response_validation",
            "history_title_response_tool_call",
            status,
            body.len(),
            "none",
            "tool_call",
            elapsed_ms,
        );
        return Err("history_title_response_tool_call".to_string());
    }
    if response_has_abnormal_finish(&value, protocol_name) {
        log_title_request_failure(
            runtime,
            protocol_name,
            endpoint_path,
            "response_validation",
            "history_title_response_finish_invalid",
            status,
            body.len(),
            "none",
            "abnormal_finish",
            elapsed_ms,
        );
        return Err("history_title_response_finish_invalid".to_string());
    }
    let Some(text) = provider::auxiliary_text::response_text(&value, protocol) else {
        log_title_request_failure(
            runtime,
            protocol_name,
            endpoint_path,
            "response_validation",
            "history_title_empty_response",
            status,
            body.len(),
            "none",
            "empty_text",
            elapsed_ms,
        );
        return Err("history_title_empty_response".to_string());
    };
    match sanitize_title(text) {
        Ok(title) => {
            log::info!(
                target: "cli_manager::history_title",
                "history.title.request.success app_type={} provider_id={} model_id={} protocol={} endpoint_path={} http_status={} body_bytes={} title_bytes={} elapsed_ms={}",
                runtime.app_type,
                runtime.provider_id,
                runtime.model_id,
                protocol_name,
                endpoint_path,
                status,
                body.len(),
                title.len(),
                elapsed_ms
            );
            Ok(title)
        }
        Err(error) => {
            log_title_request_failure(
                runtime,
                protocol_name,
                endpoint_path,
                "title_sanitize",
                &safe_error_code(&error),
                status,
                body.len(),
                "none",
                "invalid_title",
                elapsed_ms,
            );
            Err(error)
        }
    }
}

fn map_auxiliary_error(error: provider::auxiliary_text::AuxiliaryTextError) -> String {
    match error {
        provider::auxiliary_text::AuxiliaryTextError::Request(error) => {
            if error.is_timeout() {
                "history_title_request_timeout".to_string()
            } else {
                "history_title_request_failed".to_string()
            }
        }
        provider::auxiliary_text::AuxiliaryTextError::ResponseTooLarge => {
            "history_title_response_too_large".to_string()
        }
        provider::auxiliary_text::AuxiliaryTextError::ResponseRead(_) => {
            "history_title_response_read_failed".to_string()
        }
        provider::auxiliary_text::AuxiliaryTextError::ResponseInvalidUtf8 => {
            "history_title_response_invalid_utf8".to_string()
        }
    }
}

fn response_contains_tool_call(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(response_contains_tool_call),
        Value::Object(object) => object.iter().any(|(key, child)| {
            let normalized = key.to_ascii_lowercase();
            (matches!(
                normalized.as_str(),
                "tool_calls" | "tool_call" | "function_call" | "function_calls"
            ) && !child.is_null()
                && child != &Value::Array(Vec::new()))
                || (normalized == "type"
                    && child.as_str().is_some_and(|kind| {
                        kind.to_ascii_lowercase().contains("tool")
                            || kind.to_ascii_lowercase().contains("function_call")
                    }))
                || response_contains_tool_call(child)
        }),
        _ => false,
    }
}

fn response_has_abnormal_finish(value: &Value, protocol: &str) -> bool {
    let allowed = match protocol {
        "anthropic" => &["end_turn", "stop_sequence"][..],
        "chat" => &["stop", "end_turn"][..],
        _ => &[][..],
    };
    if protocol == "responses"
        && value
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status != "completed")
    {
        return true;
    }
    let finish = if protocol == "anthropic" {
        value.get("stop_reason").and_then(Value::as_str)
    } else {
        value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("finish_reason"))
            .and_then(Value::as_str)
    };
    finish.is_some_and(|reason| !allowed.contains(&reason))
}

fn strip_terminal_sequences(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut result = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if current == '\u{1b}' || current == '\u{9b}' || current == '\u{9d}' {
            let is_csi =
                current == '\u{9b}' || (current == '\u{1b}' && chars.get(index + 1) == Some(&'['));
            let is_osc =
                current == '\u{9d}' || (current == '\u{1b}' && chars.get(index + 1) == Some(&']'));
            index += if current == '\u{1b}' { 1 } else { 0 };
            if is_csi {
                index += if current == '\u{1b}' { 1 } else { 0 };
                while index < chars.len() {
                    let byte = chars[index] as u32;
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            } else if is_osc {
                index += if current == '\u{1b}' { 1 } else { 0 };
                while index < chars.len() {
                    if chars[index] == '\u{7}' {
                        index += 1;
                        break;
                    }
                    if chars[index] == '\u{1b}' && chars.get(index + 1) == Some(&'\\') {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            } else {
                index = index.saturating_add(1);
            }
            continue;
        }
        let invisible = matches!(current,
            '\u{061c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' |
            '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' |
            '\u{feff}' | '\u{fff9}'..='\u{fffb}');
        if !current.is_control() && !invisible {
            result.push(current);
        }
        index += 1;
    }
    result
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let mut result = String::new();
    let mut used = 0;
    for character in value.chars() {
        let size = character.len_utf8();
        if used + size > max_bytes {
            break;
        }
        result.push(character);
        used += size;
    }
    result
}

fn sanitize_title(value: &str) -> Result<String, String> {
    let mut title = strip_terminal_sequences(value)
        .trim()
        .trim_matches('`')
        .trim_matches(['"', '\''])
        .trim()
        .trim_start_matches(|character: char| {
            character == '#' || character == '-' || character == '*' || character == '+'
        })
        .trim()
        .split_whitespace()
        .take(MAX_TITLE_WORDS)
        .collect::<Vec<_>>()
        .join(" ");
    if title.ends_with('.')
        || title.ends_with('。')
        || title.ends_with('！')
        || title.ends_with('!')
    {
        title.pop();
    }
    title = truncate_utf8(&title, MAX_TITLE_BYTES);
    if title.is_empty() {
        return Err("history_title_empty_response".to_string());
    }
    Ok(title)
}

async fn reserve_request(
    request: &HistoryTitleGenerateRequest,
) -> Result<(i64, Option<HistoryGeneratedTitleMeta>), String> {
    let mut connection = open_history_connection().await?;
    ensure_table(&mut connection).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|err| map_history_database_error("history_title_database_begin_failed", err))?;
    let existing = sqlx::query("SELECT * FROM history_generated_titles WHERE session_key = ?1")
        .bind(request.session_key.trim())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|err| map_history_database_error("history_title_database_read_failed", err))?;
    let existing_meta = existing.as_ref().map(row_meta).transpose()?;
    if request.trigger_kind == "automatic" {
        if let Some(meta) = &existing_meta {
            if meta.auto_suppressed
                && meta.suppressed_fingerprint.as_deref()
                    == Some(request.source_content_sha256.trim())
            {
                return Err("history_title_auto_suppressed".to_string());
            }
            if meta.state == "pending" {
                return Err("history_title_pending".to_string());
            }
            if meta.state == "succeeded"
                && meta.source_content_sha256.as_deref()
                    == Some(request.source_content_sha256.trim())
            {
                return Ok((meta.revision, Some(meta.clone())));
            }
            if meta.state == "failed"
                && meta.source_content_sha256.as_deref()
                    == Some(request.source_content_sha256.trim())
            {
                return Err("history_title_auto_already_attempted".to_string());
            }
        }
        let alias = sqlx::query_scalar::<_, String>(
            "SELECT alias FROM session_meta WHERE session_key = ?1 LIMIT 1",
        )
        .bind(request.session_key.trim())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|err| map_history_database_error("history_title_database_read_failed", err))?;
        if alias.is_some_and(|value| !value.trim().is_empty()) {
            return Err("history_title_alias_pinned".to_string());
        }
    }
    let revision = existing_meta.as_ref().map_or(1, |meta| meta.revision + 1);
    let now = now_ms();
    let preserved_title = existing_meta
        .as_ref()
        .and_then(|meta| meta.title.as_deref());
    sqlx::query(
        "INSERT INTO history_generated_titles
         (session_key, source_id, source_instance_id, source_session_id, transport_kind,
          generated_title, generation_state, generation_revision, trigger_kind,
          source_message_identity, source_content_sha256, provider_app_type, provider_id,
          model_id, failure_code, auto_suppressed, suppressed_fingerprint, requested_at,
          completed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, 0, NULL, ?14, NULL, ?14)
         ON CONFLICT(session_key) DO UPDATE SET
          source_id = excluded.source_id,
          source_instance_id = excluded.source_instance_id,
          source_session_id = excluded.source_session_id,
          transport_kind = excluded.transport_kind,
          generated_title = excluded.generated_title,
          generation_state = 'pending',
          generation_revision = excluded.generation_revision,
          trigger_kind = excluded.trigger_kind,
          source_message_identity = excluded.source_message_identity,
          source_content_sha256 = excluded.source_content_sha256,
          provider_app_type = excluded.provider_app_type,
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          failure_code = NULL,
          auto_suppressed = 0,
          suppressed_fingerprint = NULL,
          requested_at = excluded.requested_at,
          completed_at = NULL,
          updated_at = excluded.updated_at",
    )
    .bind(request.session_key.trim())
    .bind(request.source_id.trim())
    .bind(request.source_instance_id.trim())
    .bind(request.source_session_id.trim())
    .bind(request.transport_kind.trim())
    .bind(preserved_title)
    .bind(revision)
    .bind(request.trigger_kind.trim())
    .bind(request.source_message_identity.trim())
    .bind(request.source_content_sha256.trim().to_ascii_lowercase())
    .bind(request.provider_app_type.trim())
    .bind(request.provider_id.trim())
    .bind(request.model_id.trim())
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|err| map_history_database_error("history_title_database_write_failed", err))?;
    transaction
        .commit()
        .await
        .map_err(|err| map_history_database_error("history_title_database_commit_failed", err))?;
    Ok((revision, None))
}

async fn finish_request(
    request: &HistoryTitleGenerateRequest,
    revision: i64,
    title: Result<String, String>,
) -> Result<HistoryGeneratedTitleMeta, String> {
    let mut connection = open_history_connection().await?;
    ensure_table(&mut connection).await?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|err| map_history_database_error("history_title_database_begin_failed", err))?;
    let now = now_ms();
    let pending = sqlx::query(
        "SELECT 1 FROM history_generated_titles
         WHERE session_key = ?1 AND generation_revision = ?2 AND generation_state = 'pending'
           AND source_message_identity = ?3 AND source_content_sha256 = ?4",
    )
    .bind(request.session_key.trim())
    .bind(revision)
    .bind(request.source_message_identity.trim())
    .bind(request.source_content_sha256.trim().to_ascii_lowercase())
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|err| map_history_database_error("history_title_database_read_failed", err))?;
    if pending.is_none() {
        return Err("history_title_request_cancelled".to_string());
    }

    let selection = settings_selection();
    let mut guard_error = validate_selection(selection.as_ref(), request).err();
    if request.trigger_kind == "automatic" {
        let alias = sqlx::query_scalar::<_, String>(
            "SELECT alias FROM session_meta WHERE session_key = ?1 LIMIT 1",
        )
        .bind(request.session_key.trim())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|err| map_history_database_error("history_title_database_read_failed", err))?;
        if alias.is_some_and(|value| !value.trim().is_empty()) {
            guard_error = Some("history_title_alias_pinned".to_string());
        }
        if !selection
            .as_ref()
            .is_some_and(|selection| selection.enabled)
        {
            guard_error = Some("history_title_auto_disabled".to_string());
        }
    }

    if let Some(error) = guard_error {
        let changed = sqlx::query(
            "UPDATE history_generated_titles
             SET generation_state = 'failed', failure_code = ?1,
                 completed_at = ?2, updated_at = ?2
             WHERE session_key = ?3 AND generation_revision = ?4 AND generation_state = 'pending'
               AND source_message_identity = ?5 AND source_content_sha256 = ?6",
        )
        .bind(&error)
        .bind(now)
        .bind(request.session_key.trim())
        .bind(revision)
        .bind(request.source_message_identity.trim())
        .bind(request.source_content_sha256.trim().to_ascii_lowercase())
        .execute(&mut *transaction)
        .await
        .map_err(|err| map_history_database_error("history_title_database_write_failed", err))?;
        if changed.rows_affected() == 0 {
            return Err("history_title_request_cancelled".to_string());
        }
        transaction.commit().await.map_err(|err| {
            map_history_database_error("history_title_database_commit_failed", err)
        })?;
        return if request.trigger_kind == "automatic" {
            Err("history_title_request_cancelled".to_string())
        } else {
            Err(error)
        };
    }

    match title {
        Ok(title) => {
            let changed = sqlx::query(
                "UPDATE history_generated_titles
                 SET generated_title = ?1, generation_state = 'succeeded', failure_code = NULL,
                     completed_at = ?2, updated_at = ?2
                 WHERE session_key = ?3 AND generation_revision = ?4 AND generation_state = 'pending'
                   AND source_message_identity = ?5 AND source_content_sha256 = ?6",
            )
            .bind(title)
            .bind(now)
            .bind(request.session_key.trim())
            .bind(revision)
            .bind(request.source_message_identity.trim())
            .bind(request.source_content_sha256.trim().to_ascii_lowercase())
            .execute(&mut *transaction)
            .await
            .map_err(|err| map_history_database_error("history_title_database_write_failed", err))?;
            if changed.rows_affected() == 0 {
                return Err("history_title_request_cancelled".to_string());
            }
        }
        Err(error) => {
            let changed = sqlx::query(
                "UPDATE history_generated_titles
                 SET generation_state = 'failed', failure_code = ?1,
                     completed_at = ?2, updated_at = ?2
                 WHERE session_key = ?3 AND generation_revision = ?4 AND generation_state = 'pending'
                   AND source_message_identity = ?5 AND source_content_sha256 = ?6",
            )
            .bind(&error)
            .bind(now)
            .bind(request.session_key.trim())
            .bind(revision)
            .bind(request.source_message_identity.trim())
            .bind(request.source_content_sha256.trim().to_ascii_lowercase())
            .execute(&mut *transaction)
            .await
            .map_err(|err| map_history_database_error("history_title_database_write_failed", err))?;
            if changed.rows_affected() == 0 {
                return Err("history_title_request_cancelled".to_string());
            }
            transaction.commit().await.map_err(|err| {
                map_history_database_error("history_title_database_commit_failed", err)
            })?;
            return Err(error);
        }
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_history_database_error("history_title_database_commit_failed", err))?;
    select_meta(&mut connection, request.session_key.trim())
        .await?
        .ok_or_else(|| "history_title_database_row_missing".to_string())
}

#[tauri::command]
pub(crate) fn history_title_list_providers() -> Result<Vec<HistoryTitleProviderOption>, String> {
    tauri::async_runtime::block_on(history_title_list_providers_async())
}

async fn history_title_list_providers_async() -> Result<Vec<HistoryTitleProviderOption>, String> {
    let providers = provider::repository::list_providers(None).await?;
    Ok(providers
        .into_iter()
        .map(|provider| {
            let reason_code = if !provider.enabled {
                Some("provider_disabled".to_string())
            } else if provider.key_count <= 0 {
                Some("provider_key_missing".to_string())
            } else if !provider.settings_valid {
                Some("provider_config_invalid".to_string())
            } else if !supported_api_format(
                provider.app_type.as_str(),
                provider.api_format.as_deref(),
            ) {
                Some("provider_protocol_unsupported".to_string())
            } else if provider
                .model
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
            {
                Some("provider_model_missing".to_string())
            } else {
                None
            };
            HistoryTitleProviderOption {
                app_type: provider.app_type,
                provider_id: provider.id,
                provider_name: provider.name,
                model_id: provider.model,
                api_format: provider.api_format,
                ready: reason_code.is_none(),
                reason_code,
            }
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn history_title_generate(
    request: HistoryTitleGenerateRequest,
) -> Result<HistoryGeneratedTitleMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(history_title_generate_async(request))
    })
    .await
    .map_err(|error| format!("history_title_task_failed: {error}"))?
}

async fn history_title_generate_async(
    request: HistoryTitleGenerateRequest,
) -> Result<HistoryGeneratedTitleMeta, String> {
    validate_generate_request(&request)?;
    let selection = settings_selection();
    validate_selection(selection.as_ref(), &request)?;
    validate_automatic_enabled(selection.as_ref(), &request)?;
    if !valid_app_type(request.provider_app_type.trim()) {
        return Err("history_title_provider_invalid".to_string());
    }
    let session_key_hash = session_key_log_hash(&request.session_key);
    let (revision, existing) = reserve_request(&request).await.map_err(|error| {
        if is_history_database_error_code(&error) {
            log::warn!(
                target: "cli_manager::history_title",
                "history.title.request.failure stage=reserve session_key_hash={} source={} trigger={} code={}",
                session_key_hash,
                request.source_id,
                request.trigger_kind,
                safe_error_code(&error)
            );
        }
        error
    })?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    let runtime = match load_provider_runtime(
        request.provider_app_type.trim(),
        request.provider_id.trim(),
        request.model_id.trim(),
    )
    .await
    {
        Ok(runtime) => runtime,
        Err(error) => {
            log::warn!(
                target: "cli_manager::history_title",
                "history.title.request.failure stage=runtime session_key_hash={} source={} trigger={} revision={} app_type={} provider_id={} model_id={} code={}",
                session_key_hash,
                request.source_id,
                request.trigger_kind,
                revision,
                request.provider_app_type,
                request.provider_id,
                request.model_id,
                safe_error_code(&error)
            );
            return finish_request(&request, revision, Err(error)).await;
        }
    };
    let title = request_title(
        &runtime,
        effective_prompt(selection.as_ref()),
        request.candidate_text.trim(),
    )
    .await;
    match &title {
        Ok(title) => log::info!(
            target: "cli_manager::history_title",
            "history.title.request.finish session_key_hash={} source={} trigger={} revision={} outcome=succeeded title_bytes={}",
            session_key_hash,
            request.source_id,
            request.trigger_kind,
            revision,
            title.len()
        ),
        Err(error) => log::warn!(
            target: "cli_manager::history_title",
            "history.title.request.finish session_key_hash={} source={} trigger={} revision={} outcome=failed code={}",
            session_key_hash,
            request.source_id,
            request.trigger_kind,
            revision,
            safe_error_code(error)
        ),
    }
    let result = finish_request(&request, revision, title).await;
    if let Err(error) = &result {
        if is_history_database_error_code(error) {
            log::warn!(
                target: "cli_manager::history_title",
                "history.title.request.failure stage=persist session_key_hash={} source={} trigger={} revision={} code={}",
                session_key_hash,
                request.source_id,
                request.trigger_kind,
                revision,
                safe_error_code(error)
            );
        }
    }
    result
}

#[tauri::command]
pub(crate) fn history_title_clear(
    request: HistoryTitleClearRequest,
) -> Result<HistoryGeneratedTitleMeta, String> {
    tauri::async_runtime::block_on(history_title_clear_async(request))
}

async fn history_title_clear_async(
    request: HistoryTitleClearRequest,
) -> Result<HistoryGeneratedTitleMeta, String> {
    let session_key = validate_text(
        &request.session_key,
        512,
        "history_title_session_key_invalid",
    )?;
    let source_id = validate_text(&request.source_id, 64, "history_title_source_invalid")?;
    let source_instance_id = validate_text(
        &request.source_instance_id,
        2048,
        "history_title_source_instance_invalid",
    )?;
    let source_session_id = validate_text(
        &request.source_session_id,
        512,
        "history_title_source_session_invalid",
    )?;
    if request.transport_kind != "local"
        && request.transport_kind != "wsl"
        && request.transport_kind != "ssh"
    {
        return Err("history_title_transport_not_supported".to_string());
    }
    let mut connection = open_history_connection().await?;
    ensure_table(&mut connection).await?;
    let existing = select_meta(&mut connection, &session_key).await?;
    let revision = existing.as_ref().map_or(1, |meta| meta.revision + 1);
    let fingerprint = existing
        .as_ref()
        .and_then(|meta| meta.source_content_sha256.clone());
    let fingerprint = request
        .source_content_sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .or(fingerprint);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO history_generated_titles
         (session_key, source_id, source_instance_id, source_session_id, transport_kind,
          generated_title, generation_state, generation_revision, trigger_kind,
          source_message_identity, source_content_sha256, failure_code, auto_suppressed,
          suppressed_fingerprint, requested_at, completed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'idle', ?6, NULL, NULL, ?7, NULL, 1, ?7, NULL, ?8, ?8)
         ON CONFLICT(session_key) DO UPDATE SET
          source_id = excluded.source_id,
          source_instance_id = excluded.source_instance_id,
          source_session_id = excluded.source_session_id,
          transport_kind = excluded.transport_kind,
          generated_title = NULL,
          generation_state = 'idle',
          generation_revision = excluded.generation_revision,
          trigger_kind = NULL,
          failure_code = NULL,
          auto_suppressed = 1,
          suppressed_fingerprint = excluded.suppressed_fingerprint,
          requested_at = NULL,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at",
    )
    .bind(&session_key)
    .bind(source_id)
    .bind(source_instance_id)
    .bind(source_session_id)
    .bind(request.transport_kind.trim())
    .bind(revision)
    .bind(fingerprint)
    .bind(now)
    .execute(&mut connection)
    .await
    .map_err(|err| map_history_database_error("history_title_database_write_failed", err))?;
    select_meta(&mut connection, &session_key)
        .await?
        .ok_or_else(|| "history_title_database_row_missing".to_string())
}

#[tauri::command]
pub(crate) fn history_title_cancel(session_key: String) -> Result<(), String> {
    tauri::async_runtime::block_on(history_title_cancel_async(session_key))
}

async fn history_title_cancel_async(session_key: String) -> Result<(), String> {
    let session_key = validate_text(&session_key, 512, "history_title_session_key_invalid")?;
    let mut connection = open_history_connection().await?;
    ensure_table(&mut connection).await?;
    sqlx::query(
        "UPDATE history_generated_titles
         SET generation_state = 'failed', trigger_kind = NULL, generation_revision = generation_revision + 1,
             failure_code = 'cancelled', requested_at = NULL, completed_at = ?1, updated_at = ?1
         WHERE session_key = ?2 AND generation_state = 'pending'",
    )
    .bind(now_ms())
    .bind(session_key)
    .execute(&mut connection)
    .await
    .map_err(|err| map_history_database_error("history_title_database_write_failed", err))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        effective_prompt, is_sqlite_busy_code, normalize_custom_prompt, provider_error_diagnostics,
        response_contains_tool_call, response_has_abnormal_finish, safe_error_code, sanitize_title,
        HistoryTitleSettingsSelection, BUILTIN_PROMPT, HISTORY_TITLE_DATABASE_BUSY_TIMEOUT,
        MAX_CUSTOM_PROMPT_BYTES,
    };
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn title_sanitizer_removes_fences_and_caps_words() {
        assert_eq!(
            sanitize_title("``` Fix the login flow. ```").unwrap(),
            "Fix the login flow"
        );
    }

    #[test]
    fn title_sanitizer_rejects_empty_output() {
        assert!(sanitize_title(" \n ").is_err());
    }

    #[test]
    fn title_sanitizer_removes_terminal_and_invisible_controls() {
        assert_eq!(
            sanitize_title("\u{1b}[31m\u{200b}修复登录\u{1b}[0m\n").unwrap(),
            "修复登录"
        );
    }

    #[test]
    fn custom_prompt_normalization_trims_and_rejects_invalid_values() {
        assert_eq!(
            normalize_custom_prompt(Some("  Use imperative task titles.  ")).as_deref(),
            Some("Use imperative task titles.")
        );
        assert_eq!(normalize_custom_prompt(Some("   ")), None);
        assert_eq!(normalize_custom_prompt(Some("contains\0nul")), None);
        let max_utf8_prompt = "\u{1f642}".repeat(MAX_CUSTOM_PROMPT_BYTES / 4);
        assert_eq!(
            normalize_custom_prompt(Some(&max_utf8_prompt)).as_deref(),
            Some(max_utf8_prompt.as_str())
        );
        assert_eq!(
            normalize_custom_prompt(Some(&(max_utf8_prompt + "x"))),
            None
        );
    }

    #[test]
    fn effective_prompt_uses_custom_value_or_builtin_fallback() {
        let selection = HistoryTitleSettingsSelection {
            enabled: true,
            app_type: Some("codex".to_string()),
            provider_id: Some("provider".to_string()),
            model_id: Some("model".to_string()),
            custom_prompt: Some("Use terse verbs.".to_string()),
        };
        assert_eq!(effective_prompt(Some(&selection)), "Use terse verbs.");
        assert_eq!(effective_prompt(None), BUILTIN_PROMPT);
    }

    #[test]
    fn response_validation_rejects_tools_and_abnormal_finish() {
        assert!(response_contains_tool_call(&json!({
            "choices": [{"message": {"tool_calls": [{"id": "call-1"}]}}]
        })));
        assert!(response_has_abnormal_finish(
            &json!({"choices": [{"finish_reason": "length"}]}),
            "chat"
        ));
    }

    #[test]
    fn provider_error_diagnostics_classify_without_returning_message_content() {
        assert_eq!(
            provider_error_diagnostics(&json!({
                "error": {
                    "code": "invalid_api_key",
                    "type": "authentication_error",
                    "message": "secret-bearing provider message"
                }
            })),
            ("object_code_type_message", "authentication")
        );
        assert_eq!(
            provider_error_diagnostics(&json!({
                "error": {"code": "model_not_found"}
            })),
            ("object_code", "model")
        );
    }

    #[test]
    fn error_log_code_drops_detail_after_separator() {
        assert_eq!(
            safe_error_code("history_title_request_http_401: provider detail"),
            "history_title_request_http_401"
        );
    }

    #[test]
    fn title_persistence_recognizes_sqlite_busy_codes_and_uses_shared_write_timeout() {
        for code in [
            "5",
            "6",
            "261",
            "262",
            "517",
            "SQLITE_BUSY",
            "SQLITE_LOCKED",
        ] {
            assert!(is_sqlite_busy_code(code), "expected busy code: {code}");
        }
        assert!(!is_sqlite_busy_code("19"));
        assert_eq!(HISTORY_TITLE_DATABASE_BUSY_TIMEOUT, Duration::from_secs(15));
    }
}
