use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use log::LevelFilter;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    provider::{auxiliary_text, network_client},
    shell_resolver::silent_command,
};

const MODEL_TEST_TIMEOUT_SECS: u64 = 4;
const MODEL_TEST_SLOW_THRESHOLD_MS: u64 = 1500;
const SUGGESTION_TIMEOUT_MS: u64 = 1600;
const MAX_TEXT_FIELD_CHARS: usize = 4_000;
const MAX_CONTEXT_ITEMS: usize = 12;
const PATH_SUGGESTION_DEFAULT_LIMIT: usize = 24;
const PATH_SUGGESTION_MAX_LIMIT: usize = 64;

macro_rules! command_suggestion_debug {
    ($($arg:tt)*) => {{
        if command_suggestion_debug_enabled() {
            log::debug!(
                target: "cli_manager::command_suggestion",
                "[debug] {}",
                format_args!($($arg)*)
            );
        }
    }};
}

#[derive(Debug, Clone, Copy)]
enum CommandSuggestionApiType {
    ChatCompletions,
    Responses,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSuggestionGenerateRequest {
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    input: String,
    cwd: Option<String>,
    previous_command: Option<String>,
    history: Vec<String>,
    templates: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSuggestionPathRequest {
    directory: String,
    prefix: String,
    directories_only: bool,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSuggestionResponse {
    command: Option<String>,
    response_time_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSuggestionPathEntry {
    name: String,
    kind: String,
    is_symlink: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandSuggestionModelStatus {
    Operational,
    Degraded,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSuggestionModelTestResult {
    status: CommandSuggestionModelStatus,
    success: bool,
    message: String,
    response_time_ms: Option<u64>,
    http_status: Option<u16>,
    tested_at: i64,
}

#[tauri::command]
pub async fn command_suggestion_test_model(
    base_url: String,
    api_key: String,
    model: String,
) -> Result<CommandSuggestionModelTestResult, String> {
    validate_config(&base_url, &api_key, &model)?;
    let client = shared_client()?;
    let api_type = detect_api_type(&base_url);
    let started = Instant::now();
    command_suggestion_debug!(
        "model_test start api_type={} endpoint={} model={} timeout_ms={}",
        api_type_label(api_type),
        endpoint_log_label(&base_url, api_type),
        model.trim(),
        MODEL_TEST_TIMEOUT_SECS * 1000
    );
    let result = post_model_request(
        &client,
        api_type,
        &base_url,
        &api_key,
        &model,
        "",
        "ping",
        16,
        Duration::from_secs(MODEL_TEST_TIMEOUT_SECS),
    )
    .await;
    let elapsed = elapsed_ms(started);
    let test_result = build_model_test_result(result, elapsed);
    command_suggestion_debug!(
        "model_test finish status={:?} success={} http_status={:?} response_time_ms={} message={}",
        test_result.status,
        test_result.success,
        test_result.http_status,
        elapsed,
        test_result.message
    );
    Ok(test_result)
}

#[tauri::command]
pub async fn command_suggestion_generate(
    request: CommandSuggestionGenerateRequest,
) -> Result<CommandSuggestionResponse, String> {
    validate_config(&request.base_url, &request.api_key, &request.model)?;
    validate_generation_input(&request)?;
    let client = shared_client()?;
    let api_type = detect_api_type(&request.base_url);
    let started = Instant::now();
    let user_prompt = build_user_prompt(&request);
    command_suggestion_debug!(
        "generate start api_type={} endpoint={} model={} input_chars={} cwd_present={} previous_present={} history_count={} template_count={} timeout_ms={}",
        api_type_label(api_type),
        endpoint_log_label(&request.base_url, api_type),
        request.model.trim(),
        request.input.chars().count(),
        request.cwd.as_deref().is_some_and(|value| !value.trim().is_empty()),
        request
            .previous_command
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        request.history.len(),
        request.templates.len(),
        SUGGESTION_TIMEOUT_MS
    );
    let (status, body) = match post_model_request(
        &client,
        api_type,
        &request.base_url,
        &request.api_key,
        &request.model,
        &request.prompt,
        &user_prompt,
        80,
        Duration::from_millis(SUGGESTION_TIMEOUT_MS),
    )
    .await
    {
        Ok(response) => response,
        Err(message) => {
            command_suggestion_debug!(
                "generate request_error response_time_ms={} message={}",
                elapsed_ms(started),
                message
            );
            return Err(message);
        }
    };
    let response_time_ms = elapsed_ms(started);
    command_suggestion_debug!(
        "generate response http_status={} response_time_ms={} body_bytes={}",
        status,
        response_time_ms,
        body.len()
    );
    if !(200..300).contains(&status) {
        let message = summarize_http_error(status, &body);
        command_suggestion_debug!(
            "generate rejected reason=http_status status={} message={}",
            status,
            message
        );
        return Err(message);
    }
    let value: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(err) => {
            let message = format!("model_response_parse_failed: {err}");
            command_suggestion_debug!("generate rejected reason=parse_error message={message}");
            return Err(message);
        }
    };
    if let Some(message) = response_error_message(&value) {
        command_suggestion_debug!("generate rejected reason=response_error message={message}");
        return Err(message);
    }
    let extracted_command = extract_command(&value, api_type);
    let command = extracted_command.as_deref().and_then(sanitize_command);
    let usage = value.get("usage").unwrap_or(&Value::Null);
    command_suggestion_debug!(
        "generate finish extracted={} accepted={} command_chars={} input_tokens={:?} output_tokens={:?} total_tokens={:?}",
        extracted_command.is_some(),
        command.is_some(),
        command.as_deref().map(|value| value.chars().count()).unwrap_or(0),
        usage_u64(usage, &["prompt_tokens", "input_tokens"]),
        usage_u64(usage, &["completion_tokens", "output_tokens"]),
        usage_u64(usage, &["total_tokens"])
    );
    Ok(CommandSuggestionResponse {
        command,
        response_time_ms,
        input_tokens: usage_u64(usage, &["prompt_tokens", "input_tokens"]),
        output_tokens: usage_u64(usage, &["completion_tokens", "output_tokens"]),
        total_tokens: usage_u64(usage, &["total_tokens"]),
    })
}

#[tauri::command]
pub async fn command_suggestion_list_path_entries(
    request: CommandSuggestionPathRequest,
) -> Result<Vec<CommandSuggestionPathEntry>, String> {
    validate_path_field(&request.directory, "missing_directory")?;
    validate_optional_path_field(&request.prefix)?;
    tokio::task::spawn_blocking(move || list_path_entries(request))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn command_suggestion_resolve_directory(path: String) -> Result<Option<String>, String> {
    validate_path_field(&path, "missing_path")?;
    tokio::task::spawn_blocking(move || resolve_directory_path(&path))
        .await
        .map_err(|err| err.to_string())?
}

fn validate_config(base_url: &str, api_key: &str, model: &str) -> Result<(), String> {
    if base_url.trim().is_empty() {
        return Err("missing_base_url".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("missing_api_key".to_string());
    }
    if model.trim().is_empty() {
        return Err("missing_model".to_string());
    }
    Ok(())
}

fn validate_generation_input(request: &CommandSuggestionGenerateRequest) -> Result<(), String> {
    if request.input.trim().is_empty() {
        return Err("missing_input".to_string());
    }
    for value in [
        request.prompt.as_str(),
        request.input.as_str(),
        request.cwd.as_deref().unwrap_or_default(),
        request.previous_command.as_deref().unwrap_or_default(),
    ] {
        if value.chars().count() > MAX_TEXT_FIELD_CHARS {
            return Err("input_too_large".to_string());
        }
    }
    Ok(())
}

fn validate_path_field(value: &str, empty_error: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(empty_error.to_string());
    }
    if value.contains('\0') || value.chars().count() > MAX_TEXT_FIELD_CHARS {
        return Err("path_input_too_large".to_string());
    }
    Ok(())
}

fn validate_optional_path_field(value: &str) -> Result<(), String> {
    if value.contains('\0') || value.chars().count() > MAX_TEXT_FIELD_CHARS {
        return Err("path_input_too_large".to_string());
    }
    Ok(())
}

fn path_suggestion_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(PATH_SUGGESTION_DEFAULT_LIMIT)
        .clamp(1, PATH_SUGGESTION_MAX_LIMIT)
}

fn list_path_entries(
    request: CommandSuggestionPathRequest,
) -> Result<Vec<CommandSuggestionPathEntry>, String> {
    let limit = path_suggestion_limit(request.limit);
    if let Some((distro, linux_dir)) = crate::wsl::parse_wsl_unc_path(&request.directory) {
        return list_wsl_path_entries(
            &distro,
            &linux_dir,
            &request.prefix,
            request.directories_only,
            limit,
        );
    }
    list_native_path_entries(
        &request.directory,
        &request.prefix,
        request.directories_only,
        limit,
    )
}

fn list_native_path_entries(
    directory: &str,
    prefix: &str,
    directories_only: bool,
    limit: usize,
) -> Result<Vec<CommandSuggestionPathEntry>, String> {
    let dir = PathBuf::from(directory);
    if !dir.is_absolute() {
        return Err("path_not_absolute".to_string());
    }
    let dir = dir
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    if !dir.is_dir() {
        return Err("not_directory".to_string());
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("read_dir_entry_failed: {err}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry_matches_prefix(&name, prefix) {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|err| format!("file_type_failed: {err}"))?;
        let is_symlink = file_type.is_symlink();
        let is_dir = if is_symlink {
            entry
                .path()
                .metadata()
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false)
        } else {
            file_type.is_dir()
        };
        if directories_only && !is_dir {
            continue;
        }
        if !is_dir && !file_type.is_file() {
            continue;
        }
        entries.push(CommandSuggestionPathEntry {
            name,
            kind: if is_dir { "directory" } else { "file" }.to_string(),
            is_symlink,
        });
    }
    sort_and_limit_path_entries(entries, limit)
}

fn list_wsl_path_entries(
    distro: &str,
    linux_dir: &str,
    prefix: &str,
    directories_only: bool,
    limit: usize,
) -> Result<Vec<CommandSuggestionPathEntry>, String> {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let output = silent_command(&wsl_exe.to_string_lossy())
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("find")
        .arg("-H")
        .arg(linux_dir)
        .args([
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
            "-printf",
            "%f\\0%y\\0%Y\\0",
        ])
        .output()
        .map_err(|err| format!("read_dir_failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("read_dir_failed: {}", stderr.trim()));
    }
    parse_wsl_path_entries(&output.stdout, prefix, directories_only, limit)
}

fn parse_wsl_path_entries(
    stdout: &[u8],
    prefix: &str,
    directories_only: bool,
    limit: usize,
) -> Result<Vec<CommandSuggestionPathEntry>, String> {
    let mut fields = stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut entries = Vec::new();
    loop {
        let Some(name_raw) = fields.next() else {
            break;
        };
        let kind_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;
        let target_kind_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;
        let name = String::from_utf8_lossy(name_raw).to_string();
        if !entry_matches_prefix(&name, prefix) {
            continue;
        }
        let is_symlink = kind_raw == b"l";
        let is_dir = kind_raw == b"d" || (kind_raw == b"l" && target_kind_raw == b"d");
        if directories_only && !is_dir {
            continue;
        }
        entries.push(CommandSuggestionPathEntry {
            name,
            kind: if is_dir { "directory" } else { "file" }.to_string(),
            is_symlink,
        });
    }
    sort_and_limit_path_entries(entries, limit)
}

fn sort_and_limit_path_entries(
    mut entries: Vec<CommandSuggestionPathEntry>,
    limit: usize,
) -> Result<Vec<CommandSuggestionPathEntry>, String> {
    entries.sort_by_cached_key(|entry| {
        (
            if entry.kind == "directory" { 0u8 } else { 1u8 },
            entry.name.to_lowercase(),
        )
    });
    entries.truncate(limit);
    Ok(entries)
}

fn entry_matches_prefix(name: &str, prefix: &str) -> bool {
    prefix.is_empty() || name.to_lowercase().starts_with(&prefix.to_lowercase())
}

fn resolve_directory_path(path: &str) -> Result<Option<String>, String> {
    if let Some((distro, linux_dir)) = crate::wsl::parse_wsl_unc_path(path) {
        return Ok(wsl_directory_exists(&distro, &linux_dir)?.then(|| path.trim().to_string()));
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return Ok(None);
    }
    let Ok(canonical) = path.canonicalize() else {
        return Ok(None);
    };
    if !canonical.is_dir() {
        return Ok(None);
    }
    Ok(Some(canonical.to_string_lossy().replace('\\', "/")))
}

fn wsl_directory_exists(distro: &str, linux_dir: &str) -> Result<bool, String> {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let output = silent_command(&wsl_exe.to_string_lossy())
        .args(["-d", distro, "--exec", "test", "-d", linux_dir])
        .output()
        .map_err(|err| format!("path_check_failed: {err}"))?;
    Ok(output.status.success())
}

fn shared_client() -> Result<reqwest::Client, String> {
    network_client::configure_builder(reqwest::Client::builder())?
        .user_agent("CLI-Manager command suggestion")
        .timeout(Duration::from_secs(MODEL_TEST_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("http_client_create_failed: {err}"))
}

fn endpoint_url(base_url: &str, versioned_path: &str) -> String {
    auxiliary_text::endpoint_url(base_url, versioned_path)
}

fn detect_api_type(base_url: &str) -> CommandSuggestionApiType {
    let normalized = base_url.trim().trim_end_matches('/').to_ascii_lowercase();
    if normalized.ends_with("/v1/responses") {
        CommandSuggestionApiType::Responses
    } else {
        CommandSuggestionApiType::ChatCompletions
    }
}

fn command_suggestion_debug_enabled() -> bool {
    matches!(log::max_level(), LevelFilter::Debug | LevelFilter::Trace)
}

fn api_type_label(api_type: CommandSuggestionApiType) -> &'static str {
    match api_type {
        CommandSuggestionApiType::ChatCompletions => "chat_completions",
        CommandSuggestionApiType::Responses => "responses",
    }
}

fn api_type_path(api_type: CommandSuggestionApiType) -> &'static str {
    match api_type {
        CommandSuggestionApiType::ChatCompletions => "v1/chat/completions",
        CommandSuggestionApiType::Responses => "v1/responses",
    }
}

fn endpoint_log_label(base_url: &str, api_type: CommandSuggestionApiType) -> String {
    let base = sanitize_url_for_log(base_url);
    sanitize_url_for_log(&endpoint_url(&base, api_type_path(api_type)))
}

fn sanitize_url_for_log(value: &str) -> String {
    let trimmed = value.trim();
    if let Ok(mut url) = reqwest::Url::parse(trimmed) {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        return url.to_string();
    }
    trimmed
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_string()
}

async fn post_model_request(
    client: &reqwest::Client,
    api_type: CommandSuggestionApiType,
    base_url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u16,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let protocol = match api_type {
        CommandSuggestionApiType::ChatCompletions => auxiliary_text::AuxiliaryTextProtocol::Chat,
        CommandSuggestionApiType::Responses => auxiliary_text::AuxiliaryTextProtocol::Responses,
    };
    auxiliary_text::post_text_request(
        client,
        protocol,
        base_url,
        api_key,
        model,
        system_prompt,
        user_prompt,
        max_tokens,
        timeout,
    )
    .await
    .map_err(map_auxiliary_error)
}

fn build_user_prompt(request: &CommandSuggestionGenerateRequest) -> String {
    let history = clamp_items(&request.history);
    let templates = clamp_items(&request.templates);
    serde_json::json!({
        "currentInput": request.input,
        "cwd": request.cwd,
        "previousCommand": request.previous_command,
        "recentHistory": history,
        "templates": templates,
    })
    .to_string()
}

fn clamp_items(items: &[String]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| {
            let trimmed = item.trim();
            (!trimmed.is_empty() && trimmed.chars().count() <= MAX_TEXT_FIELD_CHARS)
                .then(|| trimmed.to_string())
        })
        .take(MAX_CONTEXT_ITEMS)
        .collect()
}

fn build_model_test_result(
    result: Result<(u16, String), String>,
    response_time_ms: u64,
) -> CommandSuggestionModelTestResult {
    let tested_at = chrono::Utc::now().timestamp();
    match result {
        Ok((status, _body)) if (200..300).contains(&status) => CommandSuggestionModelTestResult {
            status: if response_time_ms <= MODEL_TEST_SLOW_THRESHOLD_MS {
                CommandSuggestionModelStatus::Operational
            } else {
                CommandSuggestionModelStatus::Degraded
            },
            success: true,
            message: "Model test passed".to_string(),
            response_time_ms: Some(response_time_ms),
            http_status: Some(status),
            tested_at,
        },
        Ok((status, body)) => CommandSuggestionModelTestResult {
            status: CommandSuggestionModelStatus::Failed,
            success: false,
            message: summarize_http_error(status, &body),
            response_time_ms: Some(response_time_ms),
            http_status: Some(status),
            tested_at,
        },
        Err(message) => CommandSuggestionModelTestResult {
            status: CommandSuggestionModelStatus::Failed,
            success: false,
            message,
            response_time_ms: Some(response_time_ms),
            http_status: None,
            tested_at,
        },
    }
}

fn response_error_message(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    if error.is_null() {
        return None;
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("model_response_error");
    Some(message.to_string())
}

fn extract_command(value: &Value, api_type: CommandSuggestionApiType) -> Option<String> {
    match api_type {
        CommandSuggestionApiType::ChatCompletions => extract_chat_command(value),
        CommandSuggestionApiType::Responses => {
            extract_responses_command(value).or_else(|| extract_chat_command(value))
        }
    }
}

fn extract_chat_command(value: &Value) -> Option<String> {
    let content =
        auxiliary_text::response_text(value, auxiliary_text::AuxiliaryTextProtocol::Chat)?.trim();
    if content.is_empty() {
        return None;
    }
    parse_command_content(content)
}

fn extract_responses_command(value: &Value) -> Option<String> {
    let text =
        auxiliary_text::response_text(value, auxiliary_text::AuxiliaryTextProtocol::Responses)?
            .trim();
    (!text.is_empty())
        .then(|| parse_command_content(text))
        .flatten()
}

fn parse_command_content(content: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(content) {
        return value
            .get("command")
            .and_then(Value::as_str)
            .map(ToString::to_string);
    }
    Some(strip_code_fence(content).trim().to_string())
}

fn strip_code_fence(value: &str) -> &str {
    let trimmed = value.trim();
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    let without_start = trimmed
        .trim_start_matches('`')
        .trim_start_matches(|ch: char| ch.is_ascii_alphabetic())
        .trim();
    without_start.trim_end_matches('`').trim()
}

fn sanitize_command(command: &str) -> Option<String> {
    let command = command.trim();
    if command.is_empty()
        || command.contains('\n')
        || command.contains('\r')
        || command.chars().count() > 500
    {
        return None;
    }
    Some(command.to_string())
}

fn usage_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
}

fn summarize_http_error(status: u16, body: &str) -> String {
    let summary = body
        .chars()
        .filter(|ch| !ch.is_control())
        .take(240)
        .collect::<String>();
    if summary.trim().is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {}", summary.trim())
    }
}

fn map_request_error(err: reqwest::Error) -> String {
    if err.is_timeout() {
        "Request timeout".to_string()
    } else if err.is_connect() {
        format!("Connection failed: {err}")
    } else {
        err.to_string()
    }
}

fn map_auxiliary_error(error: auxiliary_text::AuxiliaryTextError) -> String {
    match error {
        auxiliary_text::AuxiliaryTextError::Request(error)
        | auxiliary_text::AuxiliaryTextError::ResponseRead(error) => map_request_error(error),
        auxiliary_text::AuxiliaryTextError::ResponseTooLarge => {
            "model_response_too_large".to_string()
        }
        auxiliary_text::AuxiliaryTextError::ResponseInvalidUtf8 => {
            "model_response_not_utf8".to_string()
        }
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_avoids_duplicate_v1() {
        assert_eq!(
            endpoint_url("https://example.com/", "v1/chat/completions"),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url("https://example.com/v1", "v1/chat/completions"),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url(
                "https://example.com/v1/chat/completions",
                "v1/chat/completions"
            ),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url("https://example.com/v1/responses", "v1/responses"),
            "https://example.com/v1/responses"
        );
        assert_eq!(
            endpoint_url("https://example.com/v1/responses/", "v1/responses"),
            "https://example.com/v1/responses"
        );
    }

    #[test]
    fn detects_responses_endpoint_from_base_url() {
        assert!(matches!(
            detect_api_type("https://example.com/v1/responses/"),
            CommandSuggestionApiType::Responses
        ));
        assert!(matches!(
            detect_api_type("https://example.com/v1/chat/completions"),
            CommandSuggestionApiType::ChatCompletions
        ));
        assert!(matches!(
            detect_api_type("https://example.com/v1"),
            CommandSuggestionApiType::ChatCompletions
        ));
    }

    #[test]
    fn endpoint_log_label_removes_url_credentials_query_and_fragment() {
        assert_eq!(
            endpoint_log_label(
                "https://user:secret@example.com/v1?token=secret#debug",
                CommandSuggestionApiType::ChatCompletions
            ),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn minimal_model_test_bodies_avoid_optional_sampling_params() {
        let chat = auxiliary_text::chat_completion_body("model-a", "", "ping", 16);
        assert!(chat.get("temperature").is_none());
        let messages = chat.get("messages").and_then(Value::as_array).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].get("role").and_then(Value::as_str),
            Some("user")
        );

        let responses = auxiliary_text::responses_body("model-a", "", "ping", 16);
        assert!(responses.get("temperature").is_none());
        assert!(responses.get("instructions").is_none());
    }

    #[test]
    fn parses_json_command_content() {
        assert_eq!(
            parse_command_content(r#"{"command":"git status"}"#).as_deref(),
            Some("git status")
        );
    }

    #[test]
    fn rejects_multiline_command() {
        assert!(sanitize_command("git status\nrm -rf .").is_none());
    }

    #[test]
    fn parses_responses_output_text() {
        let value = serde_json::json!({
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "{\"command\":\"git status\"}"
                }]
            }]
        });
        assert_eq!(
            extract_command(&value, CommandSuggestionApiType::Responses).as_deref(),
            Some("git status")
        );
    }

    #[test]
    fn clamp_items_limits_context_and_drops_oversized() {
        let items = (0..20)
            .map(|index| {
                if index == 2 {
                    "x".repeat(MAX_TEXT_FIELD_CHARS + 1)
                } else {
                    format!("git status {index}")
                }
            })
            .collect::<Vec<_>>();

        let clamped = clamp_items(&items);
        assert_eq!(clamped.len(), MAX_CONTEXT_ITEMS);
        assert!(!clamped.iter().any(|item| item.len() > MAX_TEXT_FIELD_CHARS));
        assert_eq!(clamped.first().map(String::as_str), Some("git status 0"));
    }

    #[test]
    fn sanitize_command_rejects_long_command() {
        assert!(sanitize_command(&"x".repeat(501)).is_none());
    }

    #[test]
    fn native_path_entries_filter_prefix_and_sort_directories_first() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("work-app")).unwrap();
        fs::write(tmp.path().join("work.txt"), "ok").unwrap();
        fs::write(tmp.path().join("other.txt"), "skip").unwrap();

        let entries =
            list_native_path_entries(&tmp.path().to_string_lossy(), "wo", false, 10).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "work-app");
        assert_eq!(entries[0].kind, "directory");
        assert_eq!(entries[1].name, "work.txt");
        assert_eq!(entries[1].kind, "file");
    }

    #[test]
    fn native_path_entries_respect_directories_only() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("src")).unwrap();
        fs::write(tmp.path().join("script.ts"), "ok").unwrap();

        let entries =
            list_native_path_entries(&tmp.path().to_string_lossy(), "s", true, 10).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[0].kind, "directory");
    }

    #[test]
    fn resolve_directory_canonicalizes_native_path() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("root").join("child")).unwrap();
        let candidate = tmp
            .path()
            .join("root")
            .join("..")
            .join("root")
            .join("child");

        let resolved = resolve_directory_path(&candidate.to_string_lossy())
            .unwrap()
            .unwrap();

        assert!(resolved.ends_with("/root/child") || resolved.ends_with("\\root\\child"));
    }
}
