use super::*;

#[test]
// 验证远程同步分页期间来源实例身份变化被拒绝。
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
// 验证缺失直接转录路径编码为空字符串，显式路径保持不变。
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
// 验证远程详情缓存按最近使用淘汰，并能清空整个实例。
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
