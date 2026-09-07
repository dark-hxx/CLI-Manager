use super::*;

#[test]
fn remote_history_sync_rejects_identity_changes_between_pages() {
    let plan = remote_history_plan();
    let result = remote_sync_result();
    validate_remote_history_sync_result(&plan, "claude", "~/.claude", Some("instance-1"), &result)
        .unwrap();
    assert_eq!(
        validate_remote_history_sync_result(
            &plan,
            "claude",
            "~/.claude",
            Some("instance-2"),
            &result,
        )
        .unwrap_err(),
        "history_remote_identity_changed"
    );
}

#[test]
fn remote_history_get_payload_encodes_missing_transcript_ref_as_empty_string() {
    let payload = remote_history_get_payload(
        "claude",
        "~/.claude",
        vec!["/work/project".to_string()],
        "session-1".to_string(),
        None,
    );

    assert_eq!(payload["remoteTranscriptRef"], Value::String(String::new()));

    let direct_payload = remote_history_get_payload(
        "claude",
        "~/.claude",
        vec!["/work/project".to_string()],
        "session-1".to_string(),
        Some("/home/dev/.claude/projects/session-1.jsonl".to_string()),
    );
    assert_eq!(
        direct_payload["remoteTranscriptRef"],
        Value::String("/home/dev/.claude/projects/session-1.jsonl".to_string())
    );
}

#[test]
fn remote_history_detail_cache_evicts_lru_and_invalidates_instance() {
    let mut cache = RemoteHistoryDetailCache::default();
    for index in 0..REMOTE_HISTORY_DETAIL_CACHE_MAX {
        cache.insert(format!("instance:{index}"), json!({ "index": index }));
    }
    assert!(cache.get("instance:0").is_some());
    cache.insert("instance:next".to_string(), json!({ "index": "next" }));
    assert!(cache.get("instance:1").is_none());
    assert!(cache.get("instance:0").is_some());
    cache.invalidate_instance("instance");
    assert!(cache.entries.is_empty());
    assert_eq!(cache.bytes, 0);
}
