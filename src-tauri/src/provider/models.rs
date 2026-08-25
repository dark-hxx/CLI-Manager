use crate::provider::{network_client, repository};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::time::Duration;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchModelsInput {
    pub app_type: String,
    /// 新增供应商尚未落库时为 `None`;此时必须提供 `api_key`。
    pub provider_id: Option<String>,
    pub base_url: String,
    pub is_full_url: Option<bool>,
    pub api_format: Option<String>,
    pub api_key_field: Option<String>,
    /// 表单里的临时明文密钥,仅用于本次请求,不落库。优先级高于已存的激活密钥。
    pub api_key: Option<String>,
}

// 手写 Debug:`api_key` 是明文密钥,不能随 `{:?}` 进日志
// (`CLI_MANAGER_DEBUG=1` 会把 Debug 级日志写进 cli-manager.log)。
impl fmt::Debug for FetchModelsInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FetchModelsInput")
            .field("app_type", &self.app_type)
            .field("provider_id", &self.provider_id)
            .field("base_url", &self.base_url)
            .field("is_full_url", &self.is_full_url)
            .field("api_format", &self.api_format)
            .field("api_key_field", &self.api_key_field)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchModelsResult {
    pub models: Vec<String>,
}

pub(crate) async fn fetch(input: FetchModelsInput) -> Result<FetchModelsResult, String> {
    let app_type = repository::normalize_app_type(&input.app_type)?;
    let provider_id = input
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    // 未落库的新供应商没有 provider_id,此时只能靠表单传入的临时密钥。
    let detail = match provider_id.as_ref() {
        Some(id) => Some(repository::get_provider(app_type.clone(), id.clone()).await?),
        None => None,
    };
    let form_api_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let used_form_key = form_api_key.is_some();
    let api_key = match form_api_key {
        // 表单密钥优先:新增态用它,编辑态改了密钥也应按新值探测。
        Some(value) => value,
        None => {
            let (detail, provider_id) = detail
                .as_ref()
                .zip(provider_id.as_ref())
                .ok_or_else(|| "provider_models_active_key_required".to_string())?;
            let key = detail
                .keys
                .iter()
                .find(|item| item.is_active && item.enabled)
                .ok_or_else(|| "provider_models_active_key_required".to_string())?;
            repository::reveal_key(app_type.clone(), provider_id.clone(), key.id.clone()).await?
        }
    };
    let is_full_url = input.is_full_url.unwrap_or_else(|| {
        detail
            .as_ref()
            .and_then(|item| item.claude_config.as_ref())
            .map(|item| item.is_full_url)
            .unwrap_or(false)
    });
    let url = build_models_url(&input.base_url, is_full_url)?;
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let api_format = input
        .api_format
        .or_else(|| {
            detail
                .as_ref()
                .and_then(|item| item.card.api_format.clone())
        })
        .unwrap_or_default()
        .to_ascii_lowercase();
    let api_key_field = input
        .api_key_field
        .or_else(|| {
            detail
                .as_ref()
                .and_then(|item| item.claude_config.as_ref())
                .map(|item| item.api_key_field.clone())
        })
        .unwrap_or_default();
    let uses_x_api_key =
        app_type == "claude" && api_key_field == "ANTHROPIC_API_KEY" && api_format == "anthropic";
    if uses_x_api_key {
        headers.insert(
            HeaderName::from_static("x-api-key"),
            HeaderValue::try_from(api_key.as_str())
                .map_err(|_| "provider_models_invalid_key".to_string())?,
        );
    } else {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::try_from(format!("Bearer {api_key}"))
                .map_err(|_| "provider_models_invalid_key".to_string())?,
        );
    }
    let client = network_client::configure_builder(reqwest::Client::builder())?
        .default_headers(headers)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "provider_models_client_failed".to_string())?;
    // 诊断日志：同一个地址在不同 CLI 类型下表现不一致时，需要能逐项比对实际发出的请求。
    // 密钥只记指纹与长度（长度能暴露复制时多带的空格或截断），不记明文。
    log::debug!(
        "provider_fetch_models request: app_type={app_type} url={url} auth_header={auth_header} \
         api_format={api_format} api_key_field={api_key_field} key_source={key_source} \
         key={key_fingerprint} key_len={key_len}",
        auth_header = if uses_x_api_key { "x-api-key" } else { "authorization: Bearer" },
        key_source = if used_form_key { "form" } else { "stored_active" },
        key_fingerprint = fingerprint_key(&api_key),
        key_len = api_key.len(),
    );
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "provider_models_request_failed".to_string())?;
    let status = response.status();
    // 先判状态再解析：错误响应体经常是 HTML 或非标准 JSON，反过来做会让解析失败
    // 抢先报 `invalid_response`，把真正的 401/404 藏起来，排查时完全看不到原因。
    let body_text = response
        .text()
        .await
        .map_err(|_| "provider_models_request_failed".to_string())?;
    if !status.is_success() {
        // 供应商真正的拒绝原因几乎总在响应体里（哪个权限缺失、密钥属于哪个租户……），
        // 只报状态码排查不动。用 warn 级别，不必开 CLI_MANAGER_DEBUG 就能看到。
        log::warn!(
            "provider_fetch_models failed: app_type={app_type} status={status} body={body}",
            status = status.as_u16(),
            body = truncate_for_log(&body_text),
        );
        return Err(format!("provider_models_http_{}", status.as_u16()));
    }
    let body = serde_json::from_str::<Value>(&body_text)
        .map_err(|_| "provider_models_invalid_response".to_string())?;
    let models = parse_model_ids(&body);
    if models.is_empty() {
        return Err("provider_models_empty".to_string());
    }
    Ok(FetchModelsResult { models })
}

/// 密钥指纹：只保留首尾各 4 个字符，够用来比对「两次请求用的是不是同一把密钥」，
/// 但不足以还原密钥本身。太短的密钥一律全部隐去，避免变相泄露。
fn fingerprint_key(api_key: &str) -> String {
    let chars: Vec<char> = api_key.chars().collect();
    if chars.len() <= 12 {
        return "***".to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}***{tail}")
}

/// 截断响应体用于日志：保留足够看清供应商的报错，又不至于把整页 HTML 灌进日志文件。
fn truncate_for_log(body: &str) -> String {
    const LIMIT: usize = 300;
    let cleaned = body.replace(['\n', '\r'], " ");
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }
    let kept: String = trimmed.chars().take(LIMIT).collect();
    format!("{kept}…<truncated>")
}

fn build_models_url(base_url: &str, is_full_url: bool) -> Result<String, String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err("provider_models_base_url_required".to_string());
    }
    if is_full_url {
        return Ok(base.to_string());
    }
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/models") {
        Ok(trimmed.to_string())
    } else if trimmed.ends_with("/v1") {
        Ok(format!("{trimmed}/models"))
    } else {
        Ok(format!("{trimmed}/v1/models"))
    }
}

fn parse_model_ids(value: &Value) -> Vec<String> {
    let candidates = match value {
        Value::Array(items) => Some(items),
        Value::Object(map) => map
            .get("data")
            .or_else(|| map.get("models"))
            .and_then(Value::as_array),
        _ => None,
    };
    let Some(items) = candidates else {
        return Vec::new();
    };
    let mut models = items
        .iter()
        .filter_map(|item| match item {
            Value::String(value) => Some(value.trim().to_string()),
            Value::Object(map) => map
                .get("id")
                .or_else(|| map.get("name"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    models.sort_by_key(|value| value.to_ascii_lowercase());
    models.dedup();
    models
}

#[cfg(test)]
mod tests {
    use super::{
        build_models_url, fetch, fingerprint_key, parse_model_ids, truncate_for_log,
        FetchModelsInput,
    };
    use serde_json::json;

    fn input(provider_id: Option<&str>, api_key: Option<&str>) -> FetchModelsInput {
        FetchModelsInput {
            app_type: "claude".to_string(),
            provider_id: provider_id.map(str::to_string),
            base_url: "https://example.test".to_string(),
            is_full_url: None,
            api_format: None,
            api_key_field: None,
            api_key: api_key.map(str::to_string),
        }
    }

    #[test]
    fn full_url_is_not_extended() {
        assert_eq!(
            build_models_url("https://example.test/v1/messages", true).unwrap(),
            "https://example.test/v1/messages"
        );
    }
    #[test]
    fn base_url_gets_models_endpoint() {
        assert_eq!(
            build_models_url("https://example.test/v1/", false).unwrap(),
            "https://example.test/v1/models"
        );
    }

    #[test]
    fn root_base_url_gets_v1_models_endpoint() {
        assert_eq!(
            build_models_url("https://example.test", false).unwrap(),
            "https://example.test/v1/models"
        );
    }
    #[test]
    fn parses_common_model_shapes() {
        assert_eq!(
            parse_model_ids(&json!({"data": [{"id": "b"}, {"id": "a"}, {"id": "a"}]})),
            vec!["a", "b"]
        );
        assert_eq!(
            parse_model_ids(&json!({"models": ["z", "y"]})),
            vec!["y", "z"]
        );
    }

    /// `api_key` 是明文密钥,Debug 输出必须脱敏,否则 `CLI_MANAGER_DEBUG=1` 会把它写进日志文件。
    #[test]
    fn debug_output_redacts_api_key() {
        let rendered = format!("{:?}", input(Some("provider-1"), Some("sk-super-secret")));
        assert!(!rendered.contains("sk-super-secret"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        // 非敏感字段仍应可读,便于排查。
        assert!(rendered.contains("provider-1"), "{rendered}");
    }

    #[test]
    fn debug_output_keeps_absent_api_key_distinguishable() {
        let rendered = format!("{:?}", input(Some("provider-1"), None));
        assert!(rendered.contains("api_key: None"), "{rendered}");
    }

    /// provider_id 与 api_key 皆缺失时必须在触库/发网络请求之前就拒绝。
    #[tokio::test]
    async fn missing_provider_and_key_is_rejected() {
        let error = fetch(input(None, None)).await.unwrap_err();
        assert_eq!(error, "provider_models_active_key_required");
    }

    /// 空白串等同于未提供,不能被当成有效密钥送去请求。
    #[tokio::test]
    async fn blank_values_are_treated_as_absent() {
        let error = fetch(input(Some("   "), Some("  "))).await.unwrap_err();
        assert_eq!(error, "provider_models_active_key_required");
    }

    /// 指纹用于比对「两次请求是不是同一把密钥」,不能足以还原密钥。
    #[test]
    fn key_fingerprint_keeps_only_edges() {
        let key = "sk-kWbezyoMpusEbvUIppI4oulFGVCAkvtsbDGic";
        let printed = fingerprint_key(key);
        assert_eq!(printed, "sk-k***DGic");
        assert!(!key.contains(&printed));
        // 短密钥全隐,避免首尾各 4 位就几乎等于全文。
        assert_eq!(fingerprint_key("sk-123456789"), "***");
        assert_eq!(fingerprint_key(""), "***");
    }

    #[test]
    fn log_body_is_truncated_and_single_line() {
        let long = "x".repeat(400);
        let printed = truncate_for_log(&format!("line1\nline2\n{long}"));
        assert!(printed.ends_with("…<truncated>"), "{printed}");
        assert!(!printed.contains('\n'), "{printed}");
        assert_eq!(truncate_for_log("  {\"error\":\"forbidden\"}\n"), "{\"error\":\"forbidden\"}");
    }
}
