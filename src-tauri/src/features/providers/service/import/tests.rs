use super::*;

#[test]
fn native_app_type_aliases_are_normalized() {
    assert_eq!(
        normalize_source_app_type("grok"),
        Some("grokbuild".to_string())
    );
    assert_eq!(normalize_source_app_type("Claude Code"), None);
    assert_eq!(
        normalize_source_app_type("codex"),
        Some("codex".to_string())
    );
}

#[test]
fn import_preview_never_returns_secret_values() {
    let raw = r#"{"env":{"ANTHROPIC_API_KEY":"sk-secret-value","ANTHROPIC_BASE_URL":"https://example.test"}}"#;
    let candidates = secret_candidates(raw, "claude");
    assert_eq!(candidates.len(), 1);
    assert_eq!(mask_secret(&candidates[0].1), "sk-s…alue");
    let (sanitized, had_secret, valid) = sanitized_settings(raw, "claude");
    assert!(had_secret && valid);
    assert!(!sanitized.contains("sk-secret-value"));
}

#[test]
fn oauth_and_empty_credentials_are_not_imported_as_active_keys() {
    let raw = r#"{"auth":{"access_token":"oauth-value","ANTHROPIC_API_KEY":""}}"#;
    assert!(secret_candidates(raw, "claude").is_empty());
}

#[test]
fn imported_metadata_is_redacted() {
    let meta = source_meta(
        r#"{"api_key":"secret","access_token":"oauth-secret","authorization":"Bearer secret-2","clientSecret":"secret-3","label":"provider","nested":{"token":"secret-4"}}"#,
        "claude",
    );
    assert!(!serde_json::to_string(&meta).unwrap().contains("secret"));
    assert_eq!(meta.get("label").and_then(Value::as_str), Some("provider"));
}

#[test]
fn generic_sensitive_toml_fields_are_redacted() {
    let sanitized = sanitize_toml(
        "api_key = \"secret\"\nauthorization = \"Bearer secret\"\nprovider = { client_secret = \"nested-secret\" }\nmodel = \"keep\"\n",
        "codex",
    );
    assert!(!sanitized.contains("Bearer secret"));
    assert!(!sanitized.contains("nested-secret"));
    assert!(sanitized.contains("model = \"keep\""));
}

#[test]
fn every_toml_array_of_tables_entry_is_redacted() {
    let sanitized = sanitize_toml(
        "[[profiles]]\napi_key = \"first-secret\"\nmodel = \"one\"\n\n[[profiles]]\napi_key = \"second-secret\"\nmodel = \"two\"\n",
        "codex",
    );
    assert!(!sanitized.contains("first-secret"));
    assert!(!sanitized.contains("second-secret"));
    assert!(sanitized.contains("model = \"one\""));
    assert!(sanitized.contains("model = \"two\""));
}

#[test]
fn every_json_array_entry_is_redacted() {
    let (sanitized, had_secret, valid) = sanitized_settings(
        r#"{"profiles":[{"api_key":"first-secret"},{"api_key":"second-secret"}]}"#,
        "codex",
    );
    assert!(had_secret && valid);
    assert!(!sanitized.contains("first-secret"));
    assert!(!sanitized.contains("second-secret"));
}

#[test]
fn selected_import_key_prefers_enabled_source_active_key() {
    let provider = SourceProvider {
        source_id: "source-1".to_string(),
        source_app_type: "codex".to_string(),
        app_type: Some("codex".to_string()),
        name: "Provider".to_string(),
        settings_config: "{}".to_string(),
        website_url: None,
        category: None,
        notes: None,
        sort_index: 0,
        created_at: 0,
        meta: "{}".to_string(),
        is_current: false,
        settings_valid: true,
        base_url: None,
        model: None,
        api_format: None,
        keys: vec![
            SourceKey {
                label: "inactive".to_string(),
                api_key: Some("sk-inactive".to_string()),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: 0,
                is_active: false,
                reason: None,
            },
            SourceKey {
                label: "active".to_string(),
                api_key: Some("sk-active".to_string()),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: 1,
                is_active: true,
                reason: None,
            },
        ],
    };

    assert_eq!(
        selected_import_key(&provider).map(|key| key.label.as_str()),
        Some("active")
    );
}

#[test]
fn source_key_dedup_preserves_distinct_short_secrets() {
    let keys = source_keys_for(
        "{}",
        "claude",
        vec![
            SourceKey {
                label: "Primary".to_string(),
                api_key: Some("short-a".to_string()),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: 0,
                is_active: true,
                reason: None,
            },
            SourceKey {
                label: "Backup".to_string(),
                api_key: Some("short-b".to_string()),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: 1,
                is_active: false,
                reason: None,
            },
        ],
    );

    assert_eq!(keys.len(), 2);
}

#[test]
fn source_key_labels_are_unique_when_source_reuses_a_label() {
    let keys = source_keys_for(
        "{}",
        "claude",
        vec![
            SourceKey {
                label: "Primary".to_string(),
                api_key: Some("secret-a".to_string()),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: 0,
                is_active: true,
                reason: None,
            },
            SourceKey {
                label: "Primary".to_string(),
                api_key: Some("secret-b".to_string()),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: 1,
                is_active: false,
                reason: None,
            },
        ],
    );

    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0].label, "Primary");
    assert_eq!(keys[1].label, "Primary (2)");
    assert_eq!(keys[0].api_key.as_deref(), Some("secret-a"));
    assert_eq!(keys[1].api_key.as_deref(), Some("secret-b"));
}

#[test]
fn source_keys_are_stably_sorted_by_source_order() {
    let keys = source_keys_for(
        "{}",
        "claude",
        vec![
            SourceKey {
                label: "Later".to_string(),
                api_key: Some("secret-b".to_string()),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: 20,
                is_active: false,
                reason: None,
            },
            SourceKey {
                label: "Earlier".to_string(),
                api_key: Some("secret-a".to_string()),
                tags: Vec::new(),
                notes: String::new(),
                enabled: true,
                sort_index: 10,
                is_active: true,
                reason: None,
            },
        ],
    );

    assert_eq!(
        keys.iter()
            .map(|key| key.label.as_str())
            .collect::<Vec<_>>(),
        ["Earlier", "Later"]
    );
}
