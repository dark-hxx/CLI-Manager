use reqwest::{Client, Response};
use serde_json::{json, Map, Value};
use std::time::Duration;

pub(crate) const MAX_RESPONSE_BODY_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuxiliaryTextProtocol {
    Anthropic,
    Chat,
    Responses,
}

#[derive(Debug)]
pub(crate) enum AuxiliaryTextError {
    Request(reqwest::Error),
    ResponseTooLarge,
    ResponseRead(reqwest::Error),
    ResponseInvalidUtf8,
}

// 按协议构造认证头和非流式文本请求，使用调用方超时；返回状态码与正文，不自行拒绝非 2xx。
pub(crate) async fn post_text_request(
    client: &Client,
    protocol: AuxiliaryTextProtocol,
    base_url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u16,
    timeout: Duration,
) -> Result<(u16, String), AuxiliaryTextError> {
    let request = match protocol {
        AuxiliaryTextProtocol::Anthropic => client
            .post(endpoint_url(base_url, "v1/messages"))
            .header("content-type", "application/json")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&anthropic_messages_body(
                model,
                system_prompt,
                user_prompt,
                max_tokens,
            )),
        AuxiliaryTextProtocol::Chat => client
            .post(endpoint_url(base_url, "v1/chat/completions"))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {api_key}"))
            .json(&chat_completion_body(
                model,
                system_prompt,
                user_prompt,
                max_tokens,
            )),
        AuxiliaryTextProtocol::Responses => client
            .post(endpoint_url(base_url, "v1/responses"))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {api_key}"))
            .json(&responses_body(
                model,
                system_prompt,
                user_prompt,
                max_tokens,
            )),
    };
    let response = request
        .timeout(timeout)
        .send()
        .await
        .map_err(AuxiliaryTextError::Request)?;
    let status = response.status().as_u16();
    let body = read_response_body(response).await?;
    Ok((status, body))
}

// 按字符串后缀避免重复完整端点或 /v1，再拼接路径；不解析 URL 查询、片段或规范化大小写。
pub(crate) fn endpoint_url(base_url: &str, versioned_path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let path = versioned_path.trim().trim_start_matches('/');
    if base.ends_with(&format!("/{path}")) {
        return base.to_string();
    }
    if let Some(rest) = path.strip_prefix("v1/") {
        if base.ends_with("/v1") {
            return format!("{base}/{rest}");
        }
    }
    format!("{base}/{path}")
}

// 构造非流式 Chat 请求，裁剪模型和系统提示，空系统提示省略对应消息。
pub(crate) fn chat_completion_body(
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u16,
) -> Value {
    let mut messages = Vec::new();
    let system_prompt = system_prompt.trim();
    if !system_prompt.is_empty() {
        messages.push(json!({ "role": "system", "content": system_prompt }));
    }
    messages.push(json!({ "role": "user", "content": user_prompt }));

    json!({
        "model": model.trim(),
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": false
    })
}

// 构造非流式且 store=false 的 Responses 请求，使用字符串 input，空 instructions 不写入。
pub(crate) fn responses_body(
    model: &str,
    instructions: &str,
    input: &str,
    max_tokens: u16,
) -> Value {
    let mut body = Map::new();
    body.insert("model".to_string(), json!(model.trim()));
    body.insert("input".to_string(), json!(input));
    body.insert("max_output_tokens".to_string(), json!(max_tokens));
    body.insert("stream".to_string(), Value::Bool(false));
    body.insert("store".to_string(), Value::Bool(false));
    let instructions = instructions.trim();
    if !instructions.is_empty() {
        body.insert("instructions".to_string(), json!(instructions));
    }
    Value::Object(body)
}

// 构造 Anthropic 单条用户消息与系统提示及输出上限；不添加 stream 字段。
pub(crate) fn anthropic_messages_body(
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u16,
) -> Value {
    json!({
        "model": model.trim(),
        "max_tokens": max_tokens,
        "system": system_prompt.trim(),
        "messages": [{"role": "user", "content": user_prompt}]
    })
}

// 按协议借用首个匹配文本片段，Chat 可回退旧 text 字段，Responses 优先顶层 output_text；不合并多个片段。
pub(crate) fn response_text<'a>(
    value: &'a Value,
    protocol: AuxiliaryTextProtocol,
) -> Option<&'a str> {
    match protocol {
        AuxiliaryTextProtocol::Anthropic => value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find_map(|item| {
                    (item.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| item.get("text").and_then(Value::as_str))
                        .flatten()
                })
            }),
        AuxiliaryTextProtocol::Chat => value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| {
                item.get("message")
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_str)
                    .or_else(|| item.get("text").and_then(Value::as_str))
            }),
        AuxiliaryTextProtocol::Responses => value
            .get("output_text")
            .and_then(Value::as_str)
            .or_else(|| {
                value.get("output")?.as_array()?.iter().find_map(|item| {
                    item.get("content")?.as_array()?.iter().find_map(|part| {
                        (part.get("type").and_then(Value::as_str) == Some("output_text"))
                            .then(|| part.get("text").and_then(Value::as_str))
                            .flatten()
                    })
                })
            }),
    }
}

// 先拒绝声明长度超过 128 KiB 的响应，再完整读取正文交给字节校验；未知长度不会在读取途中截断。
async fn read_response_body(response: Response) -> Result<String, AuxiliaryTextError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
    {
        return Err(AuxiliaryTextError::ResponseTooLarge);
    }
    let bytes = response
        .bytes()
        .await
        .map_err(AuxiliaryTextError::ResponseRead)?;
    response_body_from_bytes(bytes.as_ref())
}

// 拒绝超过 128 KiB 或非 UTF-8 的完整字节，再复制为字符串，不解析 JSON。
fn response_body_from_bytes(bytes: &[u8]) -> Result<String, AuxiliaryTextError> {
    if bytes.len() > MAX_RESPONSE_BODY_BYTES {
        return Err(AuxiliaryTextError::ResponseTooLarge);
    }
    std::str::from_utf8(bytes)
        .map(str::to_string)
        .map_err(|_| AuxiliaryTextError::ResponseInvalidUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 验证根地址、版本地址及完整端点不会重复拼接版本和路径。
    fn endpoint_url_avoids_duplicate_v1_and_endpoint_segments() {
        assert_eq!(
            endpoint_url("https://example.com/", "v1/chat/completions"),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url("https://example.com/v1", "v1/responses"),
            "https://example.com/v1/responses"
        );
        assert_eq!(
            endpoint_url("https://example.com/v1/responses/", "v1/responses"),
            "https://example.com/v1/responses"
        );
    }

    #[test]
    // 验证 Responses 使用字符串输入、不附加 tools/reasoning，且禁止存储。
    fn responses_body_uses_compatible_string_input_without_tools() {
        let body = responses_body("model-a", "title instructions", "user text", 64);
        assert_eq!(body.get("input").and_then(Value::as_str), Some("user text"));
        assert!(body.get("tools").is_none());
        assert!(body.get("reasoning").is_none());
        assert_eq!(body.get("store").and_then(Value::as_bool), Some(false));
    }

    #[test]
    // 验证 Chat/Responses 显式关闭流式及 Anthropic 的输出上限；未发请求验证服务端默认行为。
    fn all_protocol_bodies_are_non_streaming() {
        assert_eq!(
            chat_completion_body("model-a", "system", "input", 16)
                .get("stream")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            responses_body("model-a", "system", "input", 16)
                .get("stream")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            anthropic_messages_body("model-a", "system", "input", 16)
                .get("max_tokens")
                .and_then(Value::as_u64),
            Some(16)
        );
    }

    #[test]
    // 验证三种协议的典型响应结构均能提取首个文本内容。
    fn response_text_extracts_all_supported_protocol_shapes() {
        assert_eq!(
            response_text(
                &json!({"content": [{"type": "text", "text": "anthropic"}]}),
                AuxiliaryTextProtocol::Anthropic
            ),
            Some("anthropic")
        );
        assert_eq!(
            response_text(
                &json!({"choices": [{"message": {"content": "chat"}}]}),
                AuxiliaryTextProtocol::Chat
            ),
            Some("chat")
        );
        assert_eq!(
            response_text(
                &json!({"output": [{"content": [{"type": "output_text", "text": "responses"}]}]}),
                AuxiliaryTextProtocol::Responses
            ),
            Some("responses")
        );
    }

    #[test]
    // 用内存字节验证超限与无效 UTF-8 被拒绝，不覆盖网络读取期间的内存占用。
    fn response_body_is_bounded_and_must_be_utf8() {
        assert!(matches!(
            response_body_from_bytes(&vec![b'x'; MAX_RESPONSE_BODY_BYTES + 1]),
            Err(AuxiliaryTextError::ResponseTooLarge)
        ));
        assert!(matches!(
            response_body_from_bytes(&[0xff]),
            Err(AuxiliaryTextError::ResponseInvalidUtf8)
        ));
    }
}
