use super::now_millis;
use cli_manager_history_core::RemoteHistorySessionDetail;
use serde_json::{json, Value};
use std::collections::BTreeMap;

// 将远程详情转换为只读前端载荷，按路径汇总变更并映射消息及用量。
pub(super) fn remote_detail_value(detail: RemoteHistorySessionDetail) -> Value {
    let summary = detail.summary;
    let mut grouped = BTreeMap::<String, Vec<_>>::new();
    for change in detail.file_changes {
        grouped
            .entry(change.file_path.clone())
            .or_default()
            .push(change);
    }
    let file_changes = grouped
        .into_iter()
        .map(|(file_path, operations)| {
            let additions = operations.iter().map(|item| item.additions).sum::<u64>();
            let deletions = operations.iter().map(|item| item.deletions).sum::<u64>();
            let latest_message_index = operations.last().and_then(|item| item.message_index);
            json!({
                "filePath": file_path,
                "status": "M",
                "additions": additions,
                "deletions": deletions,
                "latestMessageIndex": latest_message_index,
                "latestOperationGroupIndex": Value::Null,
                "latestTimestamp": operations.last().and_then(|item| item.timestamp.clone()),
                "operations": operations.into_iter().map(|item| json!({
                    "source": summary.session_ref.source_id,
                    "toolName": item.tool_name,
                    "filePath": item.file_path,
                    "oldText": item.old_text,
                    "newText": item.new_text,
                    "patch": item.patch,
                    "additions": item.additions,
                    "deletions": item.deletions,
                    "messageIndex": item.message_index,
                    "operationGroupIndex": Value::Null,
                    "timestamp": item.timestamp,
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let token_trend = summary
        .usage_facts
        .iter()
        .map(|fact| {
            json!({
                "inputTokens": fact.usage.input_tokens,
                "outputTokens": fact.usage.output_tokens,
                "cacheReadTokens": fact.usage.cache_read_tokens,
                "cacheCreationTokens": fact.usage.cache_creation_tokens,
                "totalTokens": fact.usage.total(),
                "model": fact.model,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "sessionId": summary.session_ref.source_session_id,
        "source": summary.session_ref.source_id,
        "projectKey": summary.project_key,
        "title": summary.title,
        "filePath": "",
        "cwd": summary.cwd,
        "createdAt": summary.created_at,
        "updatedAt": summary.updated_at,
        "messageCount": summary.message_count,
        "branch": summary.branch,
        "sessionRef": summary.session_ref,
        "materializationLevel": "detail",
        "freshnessState": "fresh",
        "asOf": now_millis(),
        "readOnly": true,
        "usage": {
            "inputTokens": summary.usage.input_tokens,
            "outputTokens": summary.usage.output_tokens,
            "cacheReadTokens": summary.usage.cache_read_tokens,
            "cacheCreationTokens": summary.usage.cache_creation_tokens,
            "totalCostUsd": 0,
            "dominantModel": summary.dominant_model,
            "currentModel": summary.current_model,
            "tokenTrend": token_trend,
            "toolCallCount": 0,
            "mcpCalls": [],
            "skillCalls": [],
            "builtinCalls": [],
        },
        "toolEvents": [],
        "fileChanges": file_changes,
        "messages": detail.messages.into_iter().map(|message| json!({
            "role": message.role,
            "content": message.content,
            "timestamp": message.timestamp,
            "model": message.model,
            "inputTokens": message.input_tokens,
            "outputTokens": message.output_tokens,
            "cacheReadTokens": message.cache_read_tokens,
            "cacheCreationTokens": message.cache_creation_tokens,
            "lineIndex": message.line_index,
            "editable": false,
        })).collect::<Vec<_>>(),
    })
}
