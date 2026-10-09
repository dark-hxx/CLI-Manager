use super::*;
use crate::commands::history::HistoryRoots;
use serde_json::json;
use tempfile::TempDir;

const SESSION_ID: &str = "01a11ec2-821d-79f1-b047-2fa05225f475";
const OTHER_ID: &str = "01a11eb7-8f1b-74e1-b1a5-8602e9ae559c";

// 模拟当前 Codex paginated rollout，保留真实字段结构而不复制用户对话。
fn write_rollout(root: &Path, filename_id: &str, metadata_id: &str, cwd: &str) -> PathBuf {
    let path = root
        .join("2026/10/09")
        .join(format!("rollout-2026-10-09T11-43-46-{filename_id}.jsonl"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let rows = [
        json!({"type":"session_meta","payload":{"id":metadata_id,"session_id":metadata_id,"cwd":cwd,"history_mode":"paginated"}}),
        json!({"type":"turn_context","payload":{"model":"gpt-6-luna","effort":"low"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}}),
        json!({"type":"event_msg","timestamp":"2026-10-09T03:44:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":18793,"cached_input_tokens":3840,"output_tokens":118,"total_tokens":18911},"last_token_usage":{"input_tokens":18793,"cached_input_tokens":3840,"output_tokens":118,"total_tokens":18911},"model_context_window":258400}}}),
    ];
    std::fs::write(
        &path,
        rows.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    path
}

#[test]
fn only_exact_codex_single_result_queries_use_direct_lookup() {
    assert_eq!(
        bound_codex_query(Some(" Codex "), Some(SESSION_ID), Some(1), None).as_deref(),
        Some(SESSION_ID)
    );
    for (source, query, limit, offset) in [
        (Some("claude"), Some(SESSION_ID), Some(1), None),
        (None, Some(SESSION_ID), Some(1), None),
        (Some("codex"), Some("thread title"), Some(1), None),
        (Some("codex"), Some("../outside"), Some(1), None),
        (Some("codex"), Some(SESSION_ID), Some(20), None),
        (Some("codex"), Some(SESSION_ID), Some(1), Some(1)),
    ] {
        assert!(bound_codex_query(source, query, limit, offset).is_none());
    }
}

#[test]
fn new_bound_rollout_has_messages_and_usage_without_any_catalog() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("sessions");
    write_rollout(&root, SESSION_ID, SESSION_ID, "F:/github/CLI-Manager");
    write_rollout(&root, OTHER_ID, OTHER_ID, "F:/github/CLI-Manager");
    let summary =
        find_bound_codex_session(&root, SESSION_ID, Some("F:/github/CLI-Manager")).unwrap();
    assert_eq!(summary.session_id, SESSION_ID);
    assert_eq!(summary.message_count, 2);
    let file_ref = SessionFileRef {
        source: summary.source,
        project_key: summary.project_key,
        path: summary.file_path.into(),
    };
    let roots = HistoryRoots {
        claude_config_dir: None,
        codex_config_dir: Some(temp.path().into()),
        grok_session_root: None,
        kimi_config_dir: None,
    };
    let detail =
        super::super::session_detail::build_session_detail_with_roots(&file_ref, false, &roots)
            .unwrap();
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.usage.input_tokens, 14953);
    assert_eq!(detail.usage.cache_read_tokens, 3840);
    assert_eq!(detail.usage.output_tokens, 118);
    assert_eq!(detail.usage.current_model.as_deref(), Some("gpt-6-luna"));
    assert_eq!(detail.usage.context_window, Some(258400));
    assert!(!detail.usage.token_trend.is_empty());
}

#[test]
fn missing_wrong_identity_or_wrong_project_never_uses_another_session() {
    let temp = TempDir::new().unwrap();
    write_rollout(temp.path(), OTHER_ID, OTHER_ID, "F:/repo");
    assert!(find_bound_codex_session(temp.path(), SESSION_ID, None).is_none());
    write_rollout(temp.path(), SESSION_ID, OTHER_ID, "F:/repo");
    assert!(find_bound_codex_session(temp.path(), SESSION_ID, None).is_none());
    write_rollout(temp.path(), SESSION_ID, SESSION_ID, "F:/repo");
    assert!(find_bound_codex_session(temp.path(), SESSION_ID, Some("F:/other")).is_none());
    assert!(find_bound_codex_session(temp.path(), "../outside", None).is_none());
}

#[test]
fn duplicate_identity_and_deleted_rollout_do_not_return_stale_summary() {
    let temp = TempDir::new().unwrap();
    let path = write_rollout(temp.path(), SESSION_ID, SESSION_ID, "F:/repo");
    let copy = temp.path().join(format!("rollout-copy-{SESSION_ID}.jsonl"));
    std::fs::copy(&path, &copy).unwrap();
    assert!(find_bound_codex_session(temp.path(), SESSION_ID, None).is_none());
    std::fs::remove_file(&copy).unwrap();
    assert!(find_bound_codex_session(temp.path(), SESSION_ID, None).is_some());
    std::fs::remove_file(&path).unwrap();
    assert!(find_bound_codex_session(temp.path(), SESSION_ID, None).is_none());
}
