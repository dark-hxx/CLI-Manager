use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedHookInput {
    pub message: Option<String>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub tool_use_id: Option<String>,
    pub tool_name: Option<String>,
    pub mcp_server: Option<String>,
    pub skill_name: Option<String>,
    pub agent_type: Option<String>,
    pub agent_transcript_path: Option<String>,
    pub transcript_path: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HookExpectedFile {
    pub role: String,
    pub canonical_path: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HookConfigRequest {
    pub source: String,
    pub configured_config_root: String,
    #[serde(default)]
    pub expected_canonical_root: Option<String>,
    #[serde(default)]
    pub expected_files: Vec<HookExpectedFile>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HookConfigFile {
    pub role: String,
    pub canonical_path: String,
    pub fingerprint: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HookConfigChange {
    pub role: String,
    pub canonical_path: String,
    pub before_fingerprint: String,
    pub after_fingerprint: String,
    pub action: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HookInstallationFile {
    pub role: String,
    pub canonical_path: String,
    pub before_fingerprint: String,
    pub after_fingerprint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HookHistorySourceCandidate {
    pub source: String,
    pub canonical_config_root: String,
    pub config_root_hash: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HookInstallationRecord {
    pub source: String,
    pub installation_id: String,
    pub owner_id: String,
    pub configured_config_root: String,
    pub canonical_config_root: String,
    pub config_files: Vec<HookInstallationFile>,
    pub managed_entries: u32,
    pub adapter_version: u16,
    pub installed_at: u64,
    pub history_source_candidate: HookHistorySourceCandidate,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HookConfigReport {
    pub action: String,
    pub status: String,
    pub source: String,
    pub installation_id: String,
    pub remote_machine_id: String,
    pub configured_config_root: String,
    pub canonical_config_root: String,
    pub config_root_hash: String,
    pub config_root_exists: bool,
    pub will_create_config_root: bool,
    pub config_files: Vec<HookConfigFile>,
    pub managed_entries: u32,
    pub required_entries: u32,
    pub changes: Vec<HookConfigChange>,
    pub installation: Option<HookInstallationRecord>,
}

pub fn normalize_hook_input(event: &str, hook_input: &Value) -> Option<NormalizedHookInput> {
    let tool_input = hook_input.get("tool_input");
    let tool_response = hook_input
        .get("tool_response")
        .or_else(|| hook_input.get("tool_result"));
    let tool_name = first_string(hook_input, &["tool_name", "toolName", "name"])
        .or_else(|| {
            tool_input.and_then(|value| first_string(value, &["tool_name", "toolName", "name"]))
        })
        .or_else(|| {
            tool_response.and_then(|value| first_string(value, &["tool_name", "toolName", "name"]))
        });
    if matches!(event, "ToolStart" | "ToolStop")
        && tool_name
            .as_deref()
            .is_some_and(|name| matches!(name, "Agent" | "Task"))
    {
        return None;
    }
    let message = first_string(hook_input, &["message", "prompt", "notification", "reason"])
        .or_else(|| {
            tool_input.and_then(|value| first_string(value, &["prompt", "description", "task"]))
        });
    let agent_id = first_string(hook_input, &["agent_id"])
        .or_else(|| tool_input.and_then(|value| first_string(value, &["agent_id", "agentId"])))
        .or_else(|| tool_response.and_then(|value| first_string(value, &["agent_id", "agentId"])));
    let tool_use_id = first_string(hook_input, &["tool_use_id", "toolUseId", "tool_id", "id"])
        .or_else(|| {
            tool_input.and_then(|value| first_string(value, &["tool_use_id", "toolUseId", "id"]))
        });
    let mcp_server = tool_name
        .as_deref()
        .and_then(extract_mcp_server)
        .or_else(|| first_string(hook_input, &["mcp_server", "mcpServer", "server"]))
        .or_else(|| {
            tool_input.and_then(|value| first_string(value, &["mcp_server", "mcpServer", "server"]))
        })
        .or_else(|| {
            tool_response
                .and_then(|value| first_string(value, &["mcp_server", "mcpServer", "server"]))
        });
    let skill_name = tool_input
        .and_then(|value| first_string(value, &["skill", "skill_name", "skillName"]))
        .or_else(|| first_string(hook_input, &["skill", "skill_name", "skillName"]));
    let agent_type = first_string(hook_input, &["agent_type"])
        .or_else(|| {
            tool_input.and_then(|value| {
                first_string(
                    value,
                    &["agent_type", "agentType", "subagent_type", "subagentType"],
                )
            })
        })
        .or_else(|| {
            tool_response.and_then(|value| {
                first_string(
                    value,
                    &["agent_type", "agentType", "subagent_type", "subagentType"],
                )
            })
        });
    let agent_transcript_path = first_string(hook_input, &["agent_transcript_path"])
        .or_else(|| {
            tool_input.and_then(|value| {
                first_string(value, &["agent_transcript_path", "agentTranscriptPath"])
            })
        })
        .or_else(|| {
            tool_response.and_then(|value| {
                first_string(value, &["agent_transcript_path", "agentTranscriptPath"])
            })
        })
        .or_else(|| {
            deep_first_string(
                hook_input,
                &[
                    "agent_transcript_path",
                    "agentTranscriptPath",
                    "child_transcript_path",
                    "childTranscriptPath",
                ],
            )
        });
    Some(NormalizedHookInput {
        message,
        session_id: first_string(hook_input, &["session_id"]),
        agent_id,
        tool_use_id,
        tool_name,
        mcp_server,
        skill_name,
        agent_type,
        agent_transcript_path,
        transcript_path: first_string(hook_input, &["transcript_path"]),
        reasoning_effort: extract_reasoning_effort(hook_input),
    })
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_string))
}

fn deep_first_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(found) = keys
                .iter()
                .find_map(|key| map.get(*key).and_then(Value::as_str).map(str::to_string))
            {
                return Some(found);
            }
            map.values()
                .find_map(|child| deep_first_string(child, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| deep_first_string(child, keys)),
        _ => None,
    }
}

pub fn extract_mcp_server(value: &str) -> Option<String> {
    let rest = value.strip_prefix("mcp__")?;
    let (server, _) = rest.split_once("__")?;
    non_empty_trimmed(server)
}

pub fn extract_reasoning_effort(hook_input: &Value) -> Option<String> {
    let candidates = [
        hook_input.get("effort").and_then(Value::as_str),
        hook_input
            .get("effort")
            .and_then(|value| value.get("level"))
            .and_then(Value::as_str),
        hook_input.get("reasoning_effort").and_then(Value::as_str),
        hook_input.get("reasoningEffort").and_then(Value::as_str),
        hook_input.get("effort_level").and_then(Value::as_str),
        hook_input.get("effortLevel").and_then(Value::as_str),
    ];
    candidates.into_iter().flatten().find_map(non_empty_trimmed)
}

pub fn non_empty_trimmed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::{extract_mcp_server, extract_reasoning_effort, normalize_hook_input};
    use serde_json::json;

    #[test]
    fn normalizes_nested_subagent_fields() {
        let input = json!({
            "session_id": "session",
            "tool_name": "Read",
            "tool_response": {
                "agentId": "agent-1",
                "childTranscriptPath": "/tmp/child.jsonl"
            },
            "effort": { "level": " high " }
        });
        let normalized = normalize_hook_input("SubagentStop", &input).unwrap();
        assert_eq!(normalized.session_id.as_deref(), Some("session"));
        assert_eq!(normalized.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(
            normalized.agent_transcript_path.as_deref(),
            Some("/tmp/child.jsonl")
        );
        assert_eq!(normalized.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn ignores_generic_tool_events_for_agent_tools() {
        assert!(normalize_hook_input("ToolStart", &json!({ "tool_name": "Agent" })).is_none());
        assert!(normalize_hook_input("ToolStart", &json!({ "tool_name": "Read" })).is_some());
    }

    #[test]
    fn shared_extractors_keep_existing_contracts() {
        assert_eq!(
            extract_reasoning_effort(&json!({ "reasoning_effort": "xhigh" })).as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            extract_mcp_server("mcp__exa__search").as_deref(),
            Some("exa")
        );
    }
}
