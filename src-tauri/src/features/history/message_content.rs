use super::{
    extract_model, extract_usage_tokens, is_synthetic_model, is_tool_result_message,
    positive_usage_token, summarize_json_value, HistoryMessage, HistoryMessagePart,
};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

// 递归解析支持的消息载荷与补丁事件，规范角色、正文、分块及用量并忽略元数据行。
pub(crate) fn parse_message(value: &Value) -> Option<HistoryMessage> {
    if let Some(root_type) = value.get("type").and_then(Value::as_str) {
        if root_type == "response_item" {
            let payload = value.get("payload");
            let payload_type = payload
                .and_then(|v| v.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if payload_type == "message" {
                if let Some(payload_value) = payload {
                    let mut message = parse_message(payload_value)?;
                    if message.timestamp.is_none() {
                        message.timestamp = extract_timestamp(value);
                    }
                    return Some(message);
                }
                return None;
            }

            if matches!(
                payload_type,
                "custom_tool_call" | "tool_call" | "function_call"
            ) {
                if let Some(payload_value) = payload {
                    if let Some(message) = parse_message(payload_value) {
                        if looks_like_patch(&message.content) {
                            return Some(message);
                        }
                    }
                }
            }
            return None;
        } else if root_type == "file-history-snapshot" {
            let content = extract_content(value)?;
            if !looks_like_patch(&content) {
                return None;
            }
            return Some(HistoryMessage {
                role: "tool".to_string(),
                parts: vec![HistoryMessagePart {
                    kind: "tool_result".to_string(),
                    content: content.clone(),
                    tool_name: None,
                    call_id: None,
                }],
                content,
                timestamp: extract_timestamp(value),
                model: None,
                input_tokens: None,
                output_tokens: None,
                cache_creation_tokens: None,
                cache_read_tokens: None,
                line_index: None,
                editable: false,
                editable_text: None,
            });
        } else if matches!(
            root_type,
            "event_msg" | "turn_context" | "session_meta" | "system" | "summary"
        ) {
            return None;
        }
    }

    if let Some(payload) = value.get("payload") {
        if let Some(message) = parse_message(payload) {
            let mut message = message;
            if message.timestamp.is_none() {
                message.timestamp = extract_timestamp(value);
            }
            return Some(message);
        }
    }

    let mut role = extract_role(value).unwrap_or_else(|| "assistant".to_string());
    // Claude 把工具结果写成 user 角色的行（content 全为 tool_result 块），归类为 tool，
    // 避免"用户"消息数被工具往返虚高。
    if role == "user" && is_tool_result_message(value) {
        role = "tool".to_string();
    }
    let content = extract_content(value)?;
    if content.trim().is_empty() {
        return None;
    }
    let timestamp = extract_timestamp(value);

    // 统一走 extract_usage_tokens：覆盖 Claude/Codex/Pi 等字段别名（含 Pi 的 input/output/cacheRead）。
    let usage = extract_usage_tokens(value);
    let input_tokens = positive_usage_token(usage.input_tokens);
    let output_tokens = positive_usage_token(usage.output_tokens);
    let cache_creation_tokens = positive_usage_token(usage.cache_creation_tokens);
    let cache_read_tokens = positive_usage_token(usage.cache_read_tokens);

    let parts = extract_message_parts(value, &role, &content);
    Some(HistoryMessage {
        role,
        content,
        parts,
        timestamp,
        model: extract_model(value).filter(|model| !is_synthetic_model(model)),
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        line_index: None,
        editable: false,
        editable_text: None,
    })
}

/// 提取"消息级编辑"允许替换的规范文本：
/// - Claude 根行（type=user/assistant）：message.content 为字符串时取整串；为块数组时取全部 `text` 块。
/// - Codex response_item 消息行：payload.content 中的 `input_text` / `output_text` 块。
/// 返回 None 表示该行没有可安全编辑的文本载体（tool_use / function_call / thinking / tool_result 等），
/// 前端据此禁用编辑与删除入口。与展示用 extract_content 的有损提取口径刻意分离。
// 仅提取 Claude 文本消息或 Codex response_item 消息中允许替换的文本载体。
pub(crate) fn extract_editable_text(value: &Value) -> Option<String> {
    let root_type = value.get("type").and_then(Value::as_str)?;
    if root_type == "user" || root_type == "assistant" {
        let content = value
            .get("message")
            .and_then(|message| message.get("content"))?;
        return editable_text_from_content(content, &["text"]);
    }
    if root_type == "response_item" {
        let payload = value.get("payload")?;
        if payload.get("type").and_then(Value::as_str) != Some("message") {
            return None;
        }
        return editable_text_from_content(payload.get("content")?, &["input_text", "output_text"]);
    }
    None
}

// 保留字符串内容，或用双换行连接指定类型文本块，其他形状返回空值。
pub(super) fn editable_text_from_content(
    content: &Value,
    text_block_types: &[&str],
) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter_map(|block| {
                    let block_type = block.get("type").and_then(Value::as_str)?;
                    if text_block_types.contains(&block_type) {
                        block.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        _ => None,
    }
}

// 从消息正文提取适合作为会话标题的候选文本。
pub(super) fn message_title_candidate(message: &HistoryMessage) -> Option<String> {
    title_candidate_from_text(&message.content)
}

// 优先从 objective 标签内容提取标题，未命中时处理完整文本。
pub(super) fn title_candidate_from_text(text: &str) -> Option<String> {
    if let Some(objective) = extract_simple_tag_block(text, "objective") {
        if let Some(candidate) = title_candidate_from_lines(objective) {
            return Some(candidate);
        }
    }
    title_candidate_from_lines(text)
}

// 截取首对指定简单标签之间的原始文本。
pub(super) fn extract_simple_tag_block<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

// 跳过已知噪声及工作流块，拒绝注入提示行并优先组织图片标题。
pub(super) fn title_candidate_from_lines(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut index = 0usize;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("</image>")
            || is_title_noise_line(trimmed)
        {
            index += 1;
            continue;
        }

        if is_injected_prompt_title_line(trimmed) {
            return None;
        }

        if is_workflow_state_start_line(trimmed) {
            index += 1;
            while index < lines.len() && !is_workflow_state_end_line(lines[index].trim()) {
                index += 1;
            }
            if index < lines.len() {
                index += 1;
            }
            continue;
        }

        if let Some(tag) = title_xml_tag_name(trimmed) {
            if is_title_noise_block_tag(&tag) {
                index += 1;
                if !title_line_closes_tag(trimmed, &tag) {
                    while index < lines.len() && !title_line_closes_tag(lines[index].trim(), &tag) {
                        index += 1;
                    }
                    if index < lines.len() {
                        index += 1;
                    }
                }
                continue;
            }
        }

        if let Some(candidate) = image_title_candidate_from_lines(&lines, index) {
            return Some(candidate);
        }

        return Some(trimmed.to_string());
    }

    None
}

// 从连续图片标记收集去重标签并连接后续正文作为标题。
pub(super) fn image_title_candidate_from_lines(
    lines: &[&str],
    start_index: usize,
) -> Option<String> {
    let mut image_tokens: Vec<String> = Vec::new();
    let mut text_suffix: Option<String> = None;
    let mut index = start_index;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("</image>")
            || is_title_noise_line(trimmed)
        {
            index += 1;
            continue;
        }

        let (line_images, remaining_text) = extract_image_title_parts(trimmed);
        if line_images.is_empty() {
            if image_tokens.is_empty() {
                return None;
            }
            text_suffix = Some(trimmed.to_string());
            break;
        }

        for image in line_images {
            if !image_tokens
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&image))
            {
                image_tokens.push(image);
            }
        }
        if !remaining_text.is_empty() {
            text_suffix = Some(remaining_text);
            break;
        }
        index += 1;
    }

    if image_tokens.is_empty() {
        return None;
    }

    let mut title = image_tokens.join("");
    if let Some(text) = text_suffix {
        if !text.is_empty() {
            title.push(' ');
            title.push_str(&text);
        }
    }
    Some(title)
}

// 分离图片标签、图片编号与剩余文本，移除图片结束标记。
pub(super) fn extract_image_title_parts(line: &str) -> (Vec<String>, String) {
    let mut rest = line;
    let mut image_tokens = Vec::new();
    let mut remaining_text = String::new();

    while !rest.is_empty() {
        let tag_pos = find_ascii_ci(rest, "<image");
        let label_pos = find_ascii_ci(rest, "[image #");
        let close_pos = find_ascii_ci(rest, "</image>");
        let next_pos = [tag_pos, label_pos, close_pos].into_iter().flatten().min();

        let Some(pos) = next_pos else {
            remaining_text.push_str(rest);
            break;
        };

        remaining_text.push_str(&rest[..pos]);
        rest = &rest[pos..];

        if starts_with_ascii_ci(rest, "</image>") {
            rest = &rest["</image>".len()..];
            continue;
        }

        if starts_with_ascii_ci(rest, "<image") {
            let end = rest.find('>').map(|idx| idx + 1).unwrap_or(rest.len());
            let token = &rest[..end];
            image_tokens.push(extract_image_label(token).unwrap_or_else(|| "[Image]".to_string()));
            rest = &rest[end..];
            continue;
        }

        if starts_with_ascii_ci(rest, "[image #") {
            let end = rest.find(']').map(|idx| idx + 1).unwrap_or(rest.len());
            image_tokens.push(rest[..end].to_string());
            rest = &rest[end..];
            continue;
        }
    }

    (image_tokens, remaining_text.trim().to_string())
}

// 从图片标签文本中截取完整的 Image 编号标记。
pub(super) fn extract_image_label(token: &str) -> Option<String> {
    let start = find_ascii_ci(token, "[image #")?;
    let end = token[start..].find(']')? + start + 1;
    Some(token[start..end].to_string())
}

// 将待查文本转为 ASCII 小写后查找给定小写模式的位置。
pub(super) fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_ascii_lowercase().find(needle)
}

// 安全截取前缀长度并进行 ASCII 大小写无关比较。
pub(super) fn starts_with_ascii_ci(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .map(|start| start.eq_ignore_ascii_case(prefix))
        .unwrap_or(false)
}

// 从起始标签读取并规范简单标签名，忽略结束标签和声明。
pub(super) fn title_xml_tag_name(line: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix('<')?;
    if rest.starts_with('/') || rest.starts_with('!') || rest.starts_with('?') {
        return None;
    }
    let name: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    (!name.is_empty()).then(|| name.to_lowercase())
}

// 判断标签名是否属于需要从标题候选中跳过的上下文块。
pub(super) fn is_title_noise_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "codex_internal_context"
            | "current-state"
            | "instructions"
            | "session-context"
            | "system-reminder"
            | "workflow"
    )
}

// 按小写文本判断当前行是否包含指定结束标签。
pub(super) fn title_line_closes_tag(line: &str, tag: &str) -> bool {
    line.to_lowercase().contains(&format!("</{tag}>"))
}

// 判断行是否以工作流状态起始标记开头。
pub(super) fn is_workflow_state_start_line(line: &str) -> bool {
    line.starts_with("[workflow-state:")
}

// 判断行是否以工作流状态结束标记开头。
pub(super) fn is_workflow_state_end_line(line: &str) -> bool {
    line.starts_with("[/workflow-state")
}

// 识别目标标签及日期、预算等已知标题噪声行。
pub(super) fn is_title_noise_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower == "<objective>"
        || lower == "</objective>"
        || lower.starts_with("knowledge cutoff:")
        || lower.starts_with("current date:")
        || lower.starts_with("continuation behavior:")
        || lower.starts_with("budget:")
}

// 修剪标题前缀并识别 AGENTS、技能与系统开发者提示注入行。
pub(super) fn is_injected_prompt_title_line(line: &str) -> bool {
    let normalized = line.trim_start_matches('#').trim().to_lowercase();
    normalized.starts_with("agents.md instructions for ")
        || normalized.starts_with("base directory for this skill:")
        || normalized.starts_with("base directory for this skill ")
        || normalized.starts_with("system prompt")
        || normalized.starts_with("developer instructions")
}

// 从兼容角色字段按关键词识别用户、助手、系统或工具角色。
pub(super) fn extract_role(value: &Value) -> Option<String> {
    let candidates = [
        value.get("role").and_then(Value::as_str),
        value.get("type").and_then(Value::as_str),
        value
            .get("message")
            .and_then(|v| v.get("role"))
            .and_then(Value::as_str),
        value
            .get("author")
            .and_then(|v| v.get("role"))
            .and_then(Value::as_str),
    ];

    for role in candidates.into_iter().flatten() {
        let lower = role.to_lowercase();
        if lower.contains("user") {
            return Some("user".to_string());
        }
        if lower.contains("assistant") || lower == "model" {
            return Some("assistant".to_string());
        }
        if lower.contains("developer") || lower.contains("system") {
            return Some("system".to_string());
        }
        if lower.contains("tool") {
            return Some("tool".to_string());
        }
    }
    None
}

// 按首行及已知上下文标签启发式识别注入提示正文。
pub(super) fn is_injected_prompt_content(content: &str) -> bool {
    let trimmed = content.trim_start();
    let lower = trimmed.to_lowercase();
    let first_line = lower
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches('#')
        .trim();
    is_injected_prompt_title_line(first_line)
        || first_line.starts_with("base directory for this skill:")
        || first_line.starts_with("base directory for this skill ")
        || lower.starts_with("<system-reminder")
        || lower.starts_with("<codex_internal_context")
        || lower.starts_with("<session-context")
        || lower.contains("<skills_instructions")
        || lower.contains("<permissions instructions")
        || lower.contains("<environment_context>")
        || lower.contains("<collaboration_mode>")
        || lower.contains("<workflow-state:")
        || lower.contains("### available skills")
}

// 先识别注入系统内容，再依据消息角色选择默认分块类型。
pub(super) fn fallback_message_part_kind(role: &str, content: &str) -> &'static str {
    if is_injected_prompt_content(content) {
        return "system";
    }
    match role {
        "user" | "assistant" => "text",
        "tool" => "tool_result",
        "system" => "system",
        _ => "unknown",
    }
}

// 根据角色和正文创建无工具身份的默认消息分块。
pub(super) fn fallback_history_message_part(role: &str, content: &str) -> HistoryMessagePart {
    HistoryMessagePart {
        kind: fallback_message_part_kind(role, content).to_string(),
        content: content.to_string(),
        tool_name: None,
        call_id: None,
    }
}

// 按规范化内容块类型映射展示分类，文本块回退角色分类。
pub(super) fn message_part_kind(value: &Value, role: &str, content: &str) -> &'static str {
    let part_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .replace('-', "_");
    match part_type.as_str() {
        "text" | "input_text" | "output_text" => fallback_message_part_kind(role, content),
        "thinking" | "reasoning" | "reasoning_summary" | "analysis" => "reasoning",
        "tool_use" | "tool_call" | "toolcall" | "function_call" | "custom_tool_call"
        | "mcp_tool_call" => "tool_call",
        "tool_result"
        | "toolresult"
        | "function_call_output"
        | "custom_tool_call_output"
        | "mcp_tool_call_output" => "tool_result",
        "system" | "developer" => "system",
        "metadata" | "session_meta" | "turn_context" => "metadata",
        "" => fallback_message_part_kind(role, content),
        _ => "unknown",
    }
}

// 从兼容字段提取非空工具名。
pub(super) fn message_part_tool_name(value: &Value) -> Option<String> {
    value
        .get("name")
        .or_else(|| value.get("tool_name"))
        .or_else(|| value.get("toolName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

// 从兼容字段提取非空工具调用 ID。
pub(super) fn message_part_call_id(value: &Value) -> Option<String> {
    value
        .get("call_id")
        .or_else(|| value.get("callId"))
        .or_else(|| value.get("tool_use_id"))
        .or_else(|| value.get("toolUseId"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|call_id| !call_id.is_empty())
        .map(str::to_string)
}

// 按已知正文字段及 JSON 摘要回退提取非空分块内容。
pub(super) fn extract_message_part_content(value: &Value) -> Option<String> {
    [
        "text",
        "thinking",
        "reasoning",
        "content",
        "input_text",
        "output_text",
    ]
    .into_iter()
    .filter_map(|key| value.get(key))
    .find_map(extract_text_from_value)
    .or_else(|| extract_text_from_value(value))
    .or_else(|| summarize_json_value(value))
    .map(|content| normalize_text(&content))
    .filter(|content| !content.is_empty())
}

// 将内容数组或单值转换为分类分块，无法提取时使用扁平正文回退。
pub(super) fn extract_message_parts(
    value: &Value,
    role: &str,
    flat_content: &str,
) -> Vec<HistoryMessagePart> {
    let content_value = value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"));
    let Some(content_value) = content_value else {
        return vec![HistoryMessagePart {
            kind: message_part_kind(value, role, flat_content).to_string(),
            content: flat_content.to_string(),
            tool_name: message_part_tool_name(value),
            call_id: message_part_call_id(value),
        }];
    };

    let values: Vec<&Value> = match content_value {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let parts: Vec<HistoryMessagePart> = values
        .into_iter()
        .filter_map(|part| {
            let content = extract_message_part_content(part)?;
            Some(HistoryMessagePart {
                kind: message_part_kind(part, role, &content).to_string(),
                content,
                tool_name: message_part_tool_name(part),
                call_id: message_part_call_id(part),
            })
        })
        .collect();
    if parts.is_empty() {
        vec![fallback_history_message_part(role, flat_content)]
    } else {
        parts
    }
}

// 按优先字段提取首个规范化后非空的展示正文。
pub(super) fn extract_content(value: &Value) -> Option<String> {
    let candidates = [
        value.get("content"),
        value.get("text"),
        value.get("prompt"),
        value.get("input"),
        value.get("output"),
        value.get("arguments"),
        value.get("message"),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(text) = extract_text_from_value(candidate) {
            let normalized = normalize_text(&text);
            if !normalized.is_empty() {
                return Some(normalized);
            }
        }
    }
    None
}

// 递归提取标量、数组或对象优先文本字段，数组以换行连接。
pub(super) fn extract_text_from_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(v.to_string()),
        Value::Number(v) => Some(v.to_string()),
        Value::String(v) => Some(v.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(extract_text_from_value)
                .map(|v| normalize_text(&v))
                .filter(|v| !v.is_empty())
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            let preferred_keys = [
                "text",
                "content",
                "prompt",
                "input_text",
                "output_text",
                "input",
                "output",
                "message",
                "arguments",
                "reasoning",
            ];
            for key in preferred_keys {
                if let Some(v) = map.get(key) {
                    if let Some(text) = extract_text_from_value(v) {
                        let normalized = normalize_text(&text);
                        if !normalized.is_empty() {
                            return Some(normalized);
                        }
                    }
                }
            }
            None
        }
    }
}

// 按字段顺序返回首个字符串时间值，不进行解析或空值修剪。
pub(crate) fn extract_timestamp(value: &Value) -> Option<String> {
    let candidates = [
        value.get("timestamp").and_then(Value::as_str),
        value.get("time").and_then(Value::as_str),
        value.get("created_at").and_then(Value::as_str),
        value.get("createdAt").and_then(Value::as_str),
        value
            .get("message")
            .and_then(|v| v.get("timestamp"))
            .and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .next()
        .map(ToString::to_string)
}

// 按兼容时间字段寻找首个可解析的毫秒时间戳。
pub(super) fn extract_timestamp_millis(value: &Value) -> Option<i64> {
    let candidates = [
        value.get("timestamp"),
        value.get("time"),
        value.get("created_at"),
        value.get("createdAt"),
        value.get("message").and_then(|v| v.get("timestamp")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(parse_timestamp_millis_value)
}

// 遍历根层与 payload/data 时间字段，更新扫描的最早与最晚时间。
pub(super) fn update_timestamp_bounds(
    value: &Value,
    first_timestamp_ms: &mut Option<i64>,
    last_timestamp_ms: &mut Option<i64>,
) {
    for candidate in [
        value.get("timestamp"),
        value.get("time"),
        value.get("created_at"),
        value.get("createdAt"),
        value.get("message").and_then(|v| v.get("timestamp")),
    ] {
        update_timestamp_bound(candidate, first_timestamp_ms, last_timestamp_ms);
    }
    for nested in [value.get("payload"), value.get("data")] {
        for candidate in [
            nested.and_then(|v| v.get("timestamp")),
            nested.and_then(|v| v.get("time")),
            nested.and_then(|v| v.get("created_at")),
            nested.and_then(|v| v.get("createdAt")),
        ] {
            update_timestamp_bound(candidate, first_timestamp_ms, last_timestamp_ms);
        }
    }
}

// 用单个可解析时间值扩展已有时间范围。
pub(super) fn update_timestamp_bound(
    candidate: Option<&Value>,
    first_timestamp_ms: &mut Option<i64>,
    last_timestamp_ms: &mut Option<i64>,
) {
    if let Some(timestamp_ms) = candidate.and_then(parse_timestamp_millis_value) {
        *first_timestamp_ms = Some(
            first_timestamp_ms
                .map(|current| current.min(timestamp_ms))
                .unwrap_or(timestamp_ms),
        );
        *last_timestamp_ms = Some(
            last_timestamp_ms
                .map(|current| current.max(timestamp_ms))
                .unwrap_or(timestamp_ms),
        );
    }
}

// 将数字或字符串时间值解析为 Unix 毫秒数。
pub(super) fn parse_timestamp_millis_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_f64().and_then(normalize_unix_timestamp_millis),
        Value::String(text) => parse_timestamp_millis_str(text),
        _ => None,
    }
}

// 优先解析数值秒或毫秒文本，回退 RFC3339 日期时间。
pub(super) fn parse_timestamp_millis_str(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(number) = trimmed.parse::<f64>() {
        return normalize_unix_timestamp_millis(number);
    }
    chrono::DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

// 按数值阈值区分秒和毫秒，拒绝非正、非有限或溢出的时间值。
pub(super) fn normalize_unix_timestamp_millis(value: f64) -> Option<i64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let millis = if value >= 10_000_000_000.0 {
        value
    } else {
        value * 1000.0
    };
    (millis <= i64::MAX as f64).then_some(millis as i64)
}

// 按兼容字段读取首个非空分支字符串并保留原始文本。
pub(super) fn extract_branch(value: &Value) -> Option<String> {
    let candidates = [
        value.get("branch").and_then(Value::as_str),
        value.get("git_branch").and_then(Value::as_str),
        value.get("gitBranch").and_then(Value::as_str),
        value
            .get("context")
            .and_then(|v| v.get("branch"))
            .and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|v| !v.trim().is_empty())
        .map(ToString::to_string)
}

// 移除 NUL 字符并修剪首尾空白，保留正文内部格式。
pub(super) fn normalize_text(text: &str) -> String {
    // 多数文本不含 \0，避免无意义的 replace 分配。
    if text.contains('\u{0000}') {
        text.replace('\u{0000}', "").trim().to_owned()
    } else {
        text.trim().to_owned()
    }
}

// 按 Begin Patch 或统一 diff 标记启发式识别补丁正文。
pub(super) fn looks_like_patch(text: &str) -> bool {
    text.contains("*** Begin Patch")
        || text.contains("diff --git ")
        || (text.contains("@@") && (text.contains("+++ ") || text.contains("--- ")))
}

// 按 Unicode 字符数截短修剪后的文本，超限时附加三个点。
pub(super) fn excerpt(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    // 每字符最多 4 字节（UTF-8）；预留稍微宽松一些避免临界 realloc。
    let mut out = String::with_capacity(max_chars.saturating_mul(4).saturating_add(4));
    for (idx, ch) in trimmed.chars().enumerate() {
        if idx >= max_chars {
            out.push_str("...");
            return out;
        }
        out.push(ch);
    }
    out
}

// 将系统时间转换为 Unix 毫秒数，早于纪元时返回零。
pub(super) fn system_time_to_millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
