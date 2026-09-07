use super::http::{append_query, ensure_safe_header_name, validate_url};
use super::model::{
    HookNotificationMessage, HttpMethod, HttpRequestSpec, HttpResponseSnapshot, NotificationError,
    ProviderAccepted, RequestBody, ThirdPartyTarget,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub fn build_request(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
    now: DateTime<Utc>,
) -> Result<HttpRequestSpec, NotificationError> {
    match target.provider.as_str() {
        "dingtalk" => build_dingtalk(target, message, now),
        "feishu" => build_feishu(target, message, now),
        "wecom" => build_json_webhook(target, message, "webhookUrl", wecom_body(message)),
        "bark" => build_bark(target, message),
        "pushplus" => build_pushplus(target, message),
        "wxpusher" => build_wxpusher(target, message),
        "serverchan" => build_serverchan(target, message),
        "telegram" => build_telegram(target, message),
        "ntfy" => build_ntfy(target, message),
        "gotify" => build_gotify(target, message),
        "custom" => build_custom(target, message),
        _ => Err(NotificationError::new(
            "unsupported_provider",
            "unsupported provider",
        )),
    }
}

pub fn parse_response(
    target: &ThirdPartyTarget,
    response: &HttpResponseSnapshot,
) -> Result<ProviderAccepted, NotificationError> {
    match target.provider.as_str() {
        "dingtalk" | "wecom" => parse_json_code(response, "errcode", 0),
        "feishu" | "serverchan" => parse_json_code(response, "code", 0),
        "bark" | "pushplus" => parse_json_code(response, "code", 200),
        "wxpusher" => parse_json_code(response, "code", 1000),
        "telegram" => parse_telegram(response),
        "ntfy" => parse_id(response, true),
        "gotify" => parse_id(response, false),
        "custom" => {
            if (200..300).contains(&response.status) {
                Ok(ProviderAccepted {
                    code: Some(response.status.to_string()),
                    message: None,
                    delivery_id: None,
                })
            } else {
                Err(NotificationError::new(
                    "http_status_failed",
                    format!("http status {}", response.status),
                ))
            }
        }
        _ => Err(NotificationError::new(
            "unsupported_provider",
            "unsupported provider",
        )),
    }
}

fn build_dingtalk(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
    now: DateTime<Utc>,
) -> Result<HttpRequestSpec, NotificationError> {
    let url = required_string(&target.config, "webhookUrl")?;
    let mut pairs = Vec::new();
    if let Some(secret) = optional_string(&target.config, "secret") {
        let timestamp = now.timestamp_millis().to_string();
        let sign_text = format!("{timestamp}\n{secret}");
        let sign = hmac_base64(secret.as_bytes(), sign_text.as_bytes())?;
        pairs.push(("timestamp".to_string(), timestamp));
        pairs.push(("sign".to_string(), sign));
    }
    let url = append_query(validate_url(&url)?, &pairs);
    Ok(json_post(url, vec![], dingtalk_body(message)))
}

fn build_feishu(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
    now: DateTime<Utc>,
) -> Result<HttpRequestSpec, NotificationError> {
    let mut body = feishu_body(message);
    if let Some(secret) = optional_string(&target.config, "secret") {
        let timestamp = now.timestamp().to_string();
        let string_to_sign = format!("{timestamp}\n{secret}");
        let sign = hmac_base64(string_to_sign.as_bytes(), b"")?;
        if let Value::Object(map) = &mut body {
            map.insert("timestamp".to_string(), Value::String(timestamp));
            map.insert("sign".to_string(), Value::String(sign));
        }
    }
    build_json_webhook(target, message, "webhookUrl", body)
}

fn build_bark(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
) -> Result<HttpRequestSpec, NotificationError> {
    let server = optional_string(&target.config, "serverUrl")
        .unwrap_or_else(|| "https://api.day.app".to_string());
    let key = required_string(&target.config, "deviceKey")?;
    let url = format!("{}/{}", server.trim_end_matches('/'), key.trim_matches('/'));
    let mut body = Map::new();
    body.insert("title".to_string(), Value::String(message.title.clone()));
    body.insert("body".to_string(), Value::String(message.body.clone()));
    for field in ["group", "sound", "level"] {
        if let Some(value) = optional_string(&target.config, field) {
            body.insert(field.to_string(), Value::String(value));
        }
    }
    let mut headers = Vec::new();
    if let (Some(username), Some(password)) = (
        optional_string(&target.config, "basicUsername"),
        optional_string(&target.config, "basicPassword"),
    ) {
        headers.push((
            "Authorization".to_string(),
            basic_auth(&username, &password),
        ));
    }
    Ok(json_post(url, headers, Value::Object(body)))
}

fn build_pushplus(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
) -> Result<HttpRequestSpec, NotificationError> {
    let token = required_string(&target.config, "token")?;
    let mut body = Map::new();
    body.insert("token".to_string(), Value::String(token));
    body.insert("title".to_string(), Value::String(message.title.clone()));
    body.insert("content".to_string(), Value::String(message.body.clone()));
    for field in ["channel", "template", "topic", "webhook"] {
        if let Some(value) = optional_string(&target.config, field) {
            body.insert(field.to_string(), Value::String(value));
        }
    }
    Ok(json_post(
        "https://www.pushplus.plus/send".to_string(),
        vec![],
        Value::Object(body),
    ))
}

fn build_wxpusher(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
) -> Result<HttpRequestSpec, NotificationError> {
    let mut body = Map::new();
    body.insert("content".to_string(), Value::String(message.body.clone()));
    body.insert("summary".to_string(), Value::String(message.title.clone()));
    body.insert("contentType".to_string(), Value::Number(1.into()));
    if let Some(spt) = optional_string(&target.config, "spt") {
        body.insert("spt".to_string(), Value::String(spt));
    } else {
        body.insert(
            "appToken".to_string(),
            Value::String(required_string(&target.config, "appToken")?),
        );
        if let Some(uids) = optional_string_array(&target.config, "uids") {
            body.insert(
                "uids".to_string(),
                Value::Array(uids.into_iter().map(Value::String).collect()),
            );
        }
        if let Some(topic_ids) = optional_i64_array(&target.config, "topicIds") {
            body.insert(
                "topicIds".to_string(),
                Value::Array(
                    topic_ids
                        .into_iter()
                        .map(|id| Value::Number(id.into()))
                        .collect(),
                ),
            );
        }
    }
    Ok(json_post(
        "https://wxpusher.zjiecode.com/api/send/message".to_string(),
        vec![],
        Value::Object(body),
    ))
}

fn build_serverchan(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
) -> Result<HttpRequestSpec, NotificationError> {
    let send_key = required_string(&target.config, "sendKey")?;
    let url = if send_key.starts_with("sctp") {
        format!("https://{}.push.ft07.com/send", send_key)
    } else {
        format!("https://sctapi.ftqq.com/{}.send", send_key)
    };
    Ok(HttpRequestSpec {
        method: HttpMethod::Post,
        url,
        headers: vec![],
        body: RequestBody::Form(vec![
            ("title".to_string(), message.title.clone()),
            ("desp".to_string(), message.body.clone()),
        ]),
    })
}

fn build_telegram(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
) -> Result<HttpRequestSpec, NotificationError> {
    let token = required_string(&target.config, "botToken")?;
    let chat_id = required_string(&target.config, "chatId")?;
    let mut body = Map::new();
    body.insert("chat_id".to_string(), Value::String(chat_id));
    body.insert("text".to_string(), Value::String(message.body.clone()));
    body.insert("disable_web_page_preview".to_string(), Value::Bool(true));
    if let Some(thread_id) = optional_i64(&target.config, "messageThreadId") {
        body.insert(
            "message_thread_id".to_string(),
            Value::Number(thread_id.into()),
        );
    }
    Ok(json_post(
        format!("https://api.telegram.org/bot{token}/sendMessage"),
        vec![],
        Value::Object(body),
    ))
}

fn build_ntfy(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
) -> Result<HttpRequestSpec, NotificationError> {
    let server = optional_string(&target.config, "serverUrl")
        .unwrap_or_else(|| "https://ntfy.sh".to_string());
    let topic = required_string(&target.config, "topic")?;
    let mut headers = vec![("Title".to_string(), message.title.clone())];
    if let Some(priority) = optional_string(&target.config, "priority") {
        headers.push(("Priority".to_string(), priority));
    }
    if let Some(tags) = optional_string(&target.config, "tags") {
        headers.push(("Tags".to_string(), tags));
    }
    append_auth_headers(target, &mut headers);
    Ok(HttpRequestSpec {
        method: HttpMethod::Post,
        url: format!(
            "{}/{}",
            server.trim_end_matches('/'),
            topic.trim_matches('/')
        ),
        headers,
        body: RequestBody::Text(message.body.clone()),
    })
}

fn build_gotify(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
) -> Result<HttpRequestSpec, NotificationError> {
    let server = required_string(&target.config, "serverUrl")?;
    let token = required_string(&target.config, "appToken")?;
    let priority = optional_i64(&target.config, "priority").unwrap_or(5);
    let url = append_query(
        validate_url(&format!("{}/message", server.trim_end_matches('/')))?,
        &[("token".to_string(), token)],
    );
    Ok(json_post(
        url,
        vec![],
        json!({
            "title": message.title,
            "message": message.body,
            "priority": priority
        }),
    ))
}

fn build_custom(
    target: &ThirdPartyTarget,
    message: &HookNotificationMessage,
) -> Result<HttpRequestSpec, NotificationError> {
    let method = match optional_string(&target.config, "method")
        .unwrap_or_else(|| "POST".to_string())
        .to_ascii_uppercase()
        .as_str()
    {
        "GET" => HttpMethod::Get,
        "POST" => HttpMethod::Post,
        _ => {
            return Err(NotificationError::new(
                "invalid_method",
                "only GET/POST is allowed",
            ))
        }
    };
    let url_template = required_string(&target.config, "url")?;
    let mut query = Vec::new();
    if let Some(items) = target.config.get("query").and_then(Value::as_array) {
        for item in items {
            query.push((
                render_template(&required_string(item, "key")?, message),
                render_template(&required_string(item, "value")?, message),
            ));
        }
    }
    let url = append_query(
        validate_url(&render_template(&url_template, message))?,
        &query,
    );
    let mut headers = Vec::new();
    if let Some(items) = target.config.get("headers").and_then(Value::as_array) {
        for item in items {
            let key = render_template(&required_string(item, "key")?, message);
            ensure_safe_header_name(&key)?;
            headers.push((
                key,
                render_template(&required_string(item, "value")?, message),
            ));
        }
    }
    let body = match method {
        HttpMethod::Get => RequestBody::Empty,
        HttpMethod::Post => match optional_string(&target.config, "bodyType")
            .unwrap_or_else(|| "json".to_string())
            .as_str()
        {
            "json" => {
                let value = target
                    .config
                    .get("jsonBody")
                    .cloned()
                    .unwrap_or_else(|| json!({ "title": "{{title}}", "body": "{{body}}" }));
                RequestBody::Json(render_json_templates(value, message))
            }
            "form" => {
                let mut fields = Vec::new();
                if let Some(items) = target.config.get("formBody").and_then(Value::as_array) {
                    for item in items {
                        fields.push((
                            render_template(&required_string(item, "key")?, message),
                            render_template(&required_string(item, "value")?, message),
                        ));
                    }
                }
                RequestBody::Form(fields)
            }
            "text" => RequestBody::Text(render_template(
                &optional_string(&target.config, "textBody")
                    .unwrap_or_else(|| "{{body}}".to_string()),
                message,
            )),
            _ => {
                return Err(NotificationError::new(
                    "invalid_body_type",
                    "invalid body type",
                ))
            }
        },
    };
    Ok(HttpRequestSpec {
        method,
        url,
        headers,
        body,
    })
}

fn build_json_webhook(
    target: &ThirdPartyTarget,
    _message: &HookNotificationMessage,
    url_key: &str,
    body: Value,
) -> Result<HttpRequestSpec, NotificationError> {
    let url = required_string(&target.config, url_key)?;
    Ok(json_post(url, vec![], body))
}

fn dingtalk_body(message: &HookNotificationMessage) -> Value {
    json!({
        "msgtype": "text",
        "text": { "content": message.body }
    })
}

fn feishu_body(message: &HookNotificationMessage) -> Value {
    json!({
        "msg_type": "text",
        "content": { "text": message.body }
    })
}

fn wecom_body(message: &HookNotificationMessage) -> Value {
    json!({
        "msgtype": "text",
        "text": { "content": message.body }
    })
}

fn json_post(url: String, headers: Vec<(String, String)>, body: Value) -> HttpRequestSpec {
    HttpRequestSpec {
        method: HttpMethod::Post,
        url,
        headers,
        body: RequestBody::Json(body),
    }
}

fn parse_json_code(
    response: &HttpResponseSnapshot,
    field: &str,
    expected: i64,
) -> Result<ProviderAccepted, NotificationError> {
    let value = response_json(response)?;
    let code = value.get(field).and_then(Value::as_i64);
    if code == Some(expected) {
        return Ok(ProviderAccepted {
            code: Some(expected.to_string()),
            message: json_message(&value),
            delivery_id: json_delivery_id(&value),
        });
    }
    Err(NotificationError::new(
        "business_code_failed",
        format!(
            "{field}={}",
            code.map_or_else(|| "<missing>".to_string(), |v| v.to_string())
        ),
    ))
}

fn parse_telegram(response: &HttpResponseSnapshot) -> Result<ProviderAccepted, NotificationError> {
    let value = response_json(response)?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(ProviderAccepted {
            code: Some("ok".to_string()),
            message: json_message(&value),
            delivery_id: value
                .pointer("/result/message_id")
                .and_then(Value::as_i64)
                .map(|id| id.to_string()),
        });
    }
    Err(NotificationError::new(
        "business_code_failed",
        "telegram ok=false",
    ))
}

fn parse_id(
    response: &HttpResponseSnapshot,
    allow_any_2xx: bool,
) -> Result<ProviderAccepted, NotificationError> {
    if allow_any_2xx && !(200..300).contains(&response.status) {
        return Err(NotificationError::new(
            "http_status_failed",
            format!("http status {}", response.status),
        ));
    }
    if !allow_any_2xx && response.status != 200 {
        return Err(NotificationError::new(
            "http_status_failed",
            format!("http status {}", response.status),
        ));
    }
    let value = response_json(response)?;
    let id = value.get("id").and_then(|id| {
        id.as_str()
            .map(ToString::to_string)
            .or_else(|| id.as_i64().map(|number| number.to_string()))
    });
    if let Some(delivery_id) = id {
        Ok(ProviderAccepted {
            code: Some(response.status.to_string()),
            message: json_message(&value),
            delivery_id: Some(delivery_id),
        })
    } else {
        Err(NotificationError::new(
            "missing_delivery_id",
            "delivery id is missing",
        ))
    }
}

fn response_json(response: &HttpResponseSnapshot) -> Result<Value, NotificationError> {
    serde_json::from_slice::<Value>(&response.body)
        .map_err(|_| NotificationError::new("invalid_response_json", "response is not valid json"))
}

fn json_message(value: &Value) -> Option<String> {
    for key in ["errmsg", "msg", "message", "error"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            return Some(text.chars().take(160).collect());
        }
    }
    None
}

fn json_delivery_id(value: &Value) -> Option<String> {
    for key in ["id", "messageId", "message_id"] {
        if let Some(id) = value.get(key) {
            if let Some(text) = id.as_str() {
                return Some(text.to_string());
            }
            if let Some(number) = id.as_i64() {
                return Some(number.to_string());
            }
        }
    }
    None
}

fn hmac_base64(key: &[u8], payload: &[u8]) -> Result<String, NotificationError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| NotificationError::new("sign_failed", "invalid signing key"))?;
    mac.update(payload);
    Ok(STANDARD.encode(mac.finalize().into_bytes()))
}

fn basic_auth(username: &str, password: &str) -> String {
    format!(
        "Basic {}",
        STANDARD.encode(format!("{username}:{password}"))
    )
}

fn append_auth_headers(target: &ThirdPartyTarget, headers: &mut Vec<(String, String)>) {
    match optional_string(&target.config, "authType").as_deref() {
        Some("bearer") => {
            if let Some(token) = optional_string(&target.config, "authToken") {
                headers.push(("Authorization".to_string(), format!("Bearer {token}")));
            }
        }
        Some("basic") => {
            if let (Some(username), Some(password)) = (
                optional_string(&target.config, "basicUsername"),
                optional_string(&target.config, "basicPassword"),
            ) {
                headers.push((
                    "Authorization".to_string(),
                    basic_auth(&username, &password),
                ));
            }
        }
        _ => {}
    }
}

fn render_template(template: &str, message: &HookNotificationMessage) -> String {
    template
        .replace("{{title}}", &message.title)
        .replace("{{body}}", &message.body)
        .replace("{{event}}", &message.event)
        .replace("{{source}}", &message.source)
        .replace("{{project}}", &message.project)
        .replace("{{time}}", &message.time)
        .replace("{{id}}", &message.id)
}

fn render_json_templates(value: Value, message: &HookNotificationMessage) -> Value {
    match value {
        Value::String(text) => Value::String(render_template(&text, message)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| render_json_templates(item, message))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, render_json_templates(value, message)))
                .collect(),
        ),
        other => other,
    }
}

fn required_string(value: &Value, key: &str) -> Result<String, NotificationError> {
    optional_string(value, key).ok_or_else(|| {
        NotificationError::new("missing_config", format!("missing config field {key}"))
    })
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn optional_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn optional_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    let items = value.get(key)?.as_array()?;
    let result: Vec<String> = items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect();
    (!result.is_empty()).then_some(result)
}

fn optional_i64_array(value: &Value, key: &str) -> Option<Vec<i64>> {
    let items = value.get(key)?.as_array()?;
    let result: Vec<i64> = items.iter().filter_map(Value::as_i64).collect();
    (!result.is_empty()).then_some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::third_party_notification::model::HookNotificationMessage;

    fn message() -> HookNotificationMessage {
        HookNotificationMessage {
            id: "id-1".to_string(),
            title: "CLI-Manager".to_string(),
            body: "✅ 任务完成\n项目：demo".to_string(),
            event: "Stop".to_string(),
            source: "codex".to_string(),
            project: "demo".to_string(),
            time: "2026-07-14 18:00:00 UTC".to_string(),
        }
    }

    #[test]
    fn custom_json_replaces_only_string_leaves() {
        let value = json!({"body":"{{body}}","count":1,"nested":["{{project}}"]});
        let rendered = render_json_templates(value, &message());
        assert_eq!(rendered["count"], 1);
        assert_eq!(rendered["nested"][0], "demo");
    }

    #[test]
    fn rejects_controlled_custom_header() {
        assert!(ensure_safe_header_name("Content-Length").is_err());
        assert!(ensure_safe_header_name("X-Test").is_ok());
    }
}
