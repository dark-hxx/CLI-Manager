use super::*;

#[tokio::test]
async fn saving_one_cli_preserves_other_cli_policies() {
    use sqlx::Connection;
    let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::query(
        "CREATE TABLE extension_scope_policies (
        scope_kind TEXT, scope_id TEXT, project_id TEXT, cli TEXT, extension_kind TEXT,
        mode TEXT, selected_ids_json TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER,
        PRIMARY KEY(scope_kind, scope_id, cli, extension_kind))",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    let selected = (ExtensionPolicyMode::Custom, vec!["original".to_string()]);
    let initial = BTreeMap::from([
        (
            (ExtensionCli::Claude, ExtensionPolicyKind::Mcp),
            selected.clone(),
        ),
        ((ExtensionCli::Codex, ExtensionPolicyKind::Mcp), selected),
    ]);
    save_policy_rows(
        &mut connection,
        ExtensionScopeKind::Project,
        "p",
        "p",
        &initial,
    )
    .await
    .unwrap();
    let changes = BTreeMap::from([(
        (ExtensionCli::Claude, ExtensionPolicyKind::Mcp),
        (ExtensionPolicyMode::Inherit, Vec::new()),
    )]);
    save_policy_rows(
        &mut connection,
        ExtensionScopeKind::Project,
        "p",
        "p",
        &changes,
    )
    .await
    .unwrap();
    let rows = sqlx::query("SELECT cli, selected_ids_json, revision FROM extension_scope_policies")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<String, _>("cli"), "codex");
    assert_eq!(
        rows[0].get::<String, _>("selected_ids_json"),
        r#"["original"]"#
    );
    assert_eq!(rows[0].get::<i64, _>("revision"), 1);
}

#[test]
fn inherited_empty_project_sets_require_snapshot_but_global_sets_do_not() {
    let mut resolution = PolicyResolution {
        scope_kind: ExtensionScopeKind::Worktree,
        scope_id: "w".into(),
        cli: ExtensionCli::Claude,
        kind: ExtensionPolicyKind::Mcp,
        mode: ExtensionPolicyMode::Inherit,
        selected_ids: vec![],
        effective_ids: vec![],
        applied_ids: vec![],
        inherited_from: "project".into(),
        revision: 1,
        capability_status: "supported".into(),
        application_status: "applied".into(),
        reason: None,
    };
    assert!(needs_project_snapshot(&resolution));
    resolution.inherited_from = "global".into();
    resolution.effective_ids = vec!["global".into()];
    assert!(!needs_project_snapshot(&resolution));
    resolution.inherited_from = "project".into();
    resolution.application_status = "error".into();
    assert!(!needs_project_snapshot(&resolution));
}

#[test]
fn unselected_duplicate_skill_sources_do_not_break_project_launch() {
    let packages = [("a", "search"), ("b", "search"), ("c", "doc")];
    let result = claude_skill_overrides(packages, &["c".to_string()]).unwrap();
    assert_eq!(result["search"], "off");
    assert_eq!(result["doc"], "on");
    for selected in ["a", "b"] {
        let result = claude_skill_overrides(packages, &[selected.to_string()]).unwrap();
        assert_eq!(result["search"], "on");
    }
    assert!(claude_skill_overrides(packages, &[])
        .unwrap()
        .values()
        .all(|value| value == "off"));
    assert_eq!(
        claude_skill_overrides(packages, &["a".to_string(), "b".to_string()]).unwrap_err(),
        "extensions_project_skill_name_conflict"
    );
}

#[test]
fn wsl_path_conversion_keeps_spaces_and_unicode() {
    assert_eq!(
        windows_path_to_wsl(r"C:\Program Files\CLI Manager\扩展"),
        Some("/mnt/c/Program Files/CLI Manager/扩展".to_string())
    );
}

#[test]
fn invalid_snapshot_ids_are_rejected() {
    assert!(!valid_snapshot_id("../snapshot"));
    assert!(!valid_snapshot_id("not-a-uuid"));
    assert!(valid_snapshot_id("12345678-1234-1234-1234-123456789abc"));
}

#[test]
fn codex_keys_reject_toml_path_injection() {
    assert!(safe_codex_key("server_name-1"));
    assert!(!safe_codex_key("server.name"));
    assert!(!safe_codex_key("server name"));
}

fn test_mcp_resource(
    server_key: &str,
    transport: McpTransport,
    command: Option<&str>,
    url: Option<&str>,
) -> McpResource {
    McpResource {
        schema_version: 1,
        resource_id: format!("mcp-{server_key}"),
        server_key: server_key.to_string(),
        name: server_key.to_string(),
        transport,
        command: command.map(str::to_string),
        args: Vec::new(),
        cwd: None,
        url: url.map(str::to_string),
        env: BTreeMap::new(),
        headers: BTreeMap::new(),
        secret_refs: BTreeMap::new(),
        timeout: None,
        per_cli_extensions: BTreeMap::new(),
        enabled_by_cli: BTreeMap::new(),
        source: None,
        extra: BTreeMap::new(),
    }
}

#[test]
fn codex_project_mcp_overrides_include_a_valid_transport() {
    let mut stdio = test_mcp_resource("local_server", McpTransport::Stdio, Some("node"), None);
    stdio.args.push("server.js".to_string());
    let stdio_overrides = codex_mcp_resource_overrides(&stdio, true).unwrap();
    assert!(stdio_overrides.contains(&"mcp_servers.local_server.command='''node'''".to_string()));
    assert!(
        stdio_overrides.contains(&"mcp_servers.local_server.args=['''server.js''']".to_string())
    );
    assert!(stdio_overrides.contains(&"mcp_servers.local_server.enabled=true".to_string()));

    let http = test_mcp_resource(
        "exa_web_search",
        McpTransport::StreamableHttp,
        None,
        Some("https://mcp.exa.ai/mcp"),
    );
    let http_overrides = codex_mcp_resource_overrides(&http, true).unwrap();
    assert!(http_overrides
        .contains(&"mcp_servers.exa_web_search.url='''https://mcp.exa.ai/mcp'''".to_string()));
    assert!(http_overrides.contains(&"mcp_servers.exa_web_search.enabled=true".to_string()));
    assert!(!http_overrides
        .iter()
        .any(|item| item.contains(".transport=") || item.contains(".type=")));
}

#[test]
fn codex_project_mcp_overrides_reject_unresolved_or_unsupported_resources() {
    let mut secret = test_mcp_resource("secret_server", McpTransport::Stdio, Some("node"), None);
    secret
        .secret_refs
        .insert("TOKEN".to_string(), "env:TOKEN".to_string());
    assert_eq!(
        codex_mcp_resource_overrides(&secret, true).unwrap_err(),
        "extensions_secret_reference_unresolved"
    );

    let sse = test_mcp_resource(
        "legacy_sse",
        McpTransport::Sse,
        None,
        Some("https://example.test"),
    );
    assert_eq!(
        codex_mcp_resource_overrides(&sse, true).unwrap_err(),
        "extensions_project_codex_transport_unsupported"
    );
}

#[test]
fn codex_project_profile_combines_provider_and_extension_overrides_as_valid_toml() {
    let snapshot_id = "12345678-1234-1234-1234-123456789abc";
    let content = codex_profile_content(
        snapshot_id,
        "model_provider='cli_manager_scope'\nmodel_providers.cli_manager_scope.env_key='CLI_MANAGER_PROVIDER_KEY'\n",
        &[
            "mcp_servers.exa_web_search.url='''https://mcp.exa.ai/mcp'''".to_string(),
            "mcp_servers.exa_web_search.enabled=true".to_string(),
            "skills.bundled.enabled=false".to_string(),
            "skills.config=[{path='C:/skills/doc/SKILL.md',enabled=true}]".to_string(),
        ],
    )
    .unwrap();
    let parsed = toml::from_slice::<toml::Value>(&content).unwrap();
    assert_eq!(
        parsed.get("model_provider").and_then(toml::Value::as_str),
        Some("cli_manager_scope")
    );
    assert_eq!(
        parsed
            .get("mcp_servers")
            .and_then(|value| value.get("exa_web_search"))
            .and_then(|value| value.get("url"))
            .and_then(toml::Value::as_str),
        Some("https://mcp.exa.ai/mcp")
    );
    assert_eq!(
        parsed
            .get("mcp_servers")
            .and_then(|value| value.get("exa_web_search"))
            .and_then(|value| value.get("enabled"))
            .and_then(toml::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        parsed
            .get("skills")
            .and_then(|value| value.get("bundled"))
            .and_then(|value| value.get("enabled"))
            .and_then(toml::Value::as_bool),
        Some(false)
    );
    assert!(content
        .starts_with(b"# cli-manager-project-profile:12345678-1234-1234-1234-123456789abc\n"));
}

#[test]
fn codex_project_profile_rejects_invalid_override_keys() {
    assert_eq!(
        codex_profile_content(
            "12345678-1234-1234-1234-123456789abc",
            "",
            &["mcp_servers.exa web.url='''https://example.test'''".to_string()],
        )
        .unwrap_err(),
        "extensions_project_codex_profile_invalid"
    );
}

#[test]
fn codex_project_profile_preserves_provider_config_and_overrides_extension_fields() {
    let base_config = r#"
model_provider = "custom.provider"
service_tier = "fast"
model_reasoning_effort = "high"
model_context_window = 1048576
model_auto_compact_token_limit = 900000
developer_instructions = "Keep $variables and \"quoted\" text intact.\nSecond line."

[model_providers."custom.provider"]
base_url = "https://provider.example.com/v1"
env_key = "CLI_MANAGER_PROVIDER_KEY"

[features]
enable_request_compression = true

[projects.'C:\work\a.project']
trust_level = "trusted"

[mcp_servers.search]
url = "https://mcp.example.com/old"
enabled = false
tool_timeout_sec = 120

[skills]
config = [{path = "C:/old/SKILL.md", enabled = false}]
custom_setting = "retain"

[skills.bundled]
enabled = true
custom_setting = "retain"
"#;
    let content = codex_profile_content(
        "12345678-1234-1234-1234-123456789abc",
        base_config,
        &[
            "mcp_servers.search.url='''https://mcp.example.com/new'''".to_string(),
            "mcp_servers.search.enabled=true".to_string(),
            "skills.bundled.enabled=false".to_string(),
            "skills.config=[{path='''C:/new/SKILL.md''',enabled=true}]".to_string(),
        ],
    )
    .unwrap();
    let actual = toml::from_slice::<toml::Value>(&content).unwrap();
    let mut expected = toml::from_str::<toml::Value>(base_config).unwrap();
    expected["mcp_servers"]["search"]["url"] =
        toml::Value::String("https://mcp.example.com/new".to_string());
    expected["mcp_servers"]["search"]["enabled"] = toml::Value::Boolean(true);
    expected["skills"]["bundled"]["enabled"] = toml::Value::Boolean(false);
    expected["skills"]["config"] =
        toml::from_str::<toml::Value>("config = [{path = 'C:/new/SKILL.md', enabled = true}]")
            .unwrap()["config"]
            .clone();
    assert_eq!(actual, expected);
}

#[test]
fn codex_project_profile_preserves_inline_table_siblings() {
    let base_config = r#"
mcp_servers = {search = {url = "https://mcp.example.com", enabled = false, tool_timeout_sec = 120}}
skills = {bundled = {enabled = true, custom_setting = "retain"}, custom_setting = "retain"}
"#;
    let content = codex_profile_content(
        "12345678-1234-1234-1234-123456789abc",
        base_config,
        &[
            "mcp_servers.search.enabled=true".to_string(),
            "skills.bundled.enabled=false".to_string(),
        ],
    )
    .unwrap();
    let actual = toml::from_slice::<toml::Value>(&content).unwrap();
    let mut expected = toml::from_str::<toml::Value>(base_config).unwrap();
    expected["mcp_servers"]["search"]["enabled"] = toml::Value::Boolean(true);
    expected["skills"]["bundled"]["enabled"] = toml::Value::Boolean(false);
    assert_eq!(actual, expected);
}

#[test]
// 供应商运行配置进入实际项目组合函数，MCP/Skills 不得重新引入旧状态栏。
fn codex_project_profile_inherits_home_statusline_after_provider_composition() {
    let settings = serde_json::json!({
        "base_url": "https://example.test/v1",
        "auth": {"OPENAI_API_KEY": "test-secret"},
        "config": "service_tier='fast'\n[tui]\nstatus_line=['total-input-tokens']\nnotifications=false\n",
    });
    let runtime = crate::provider::runtime::parse_runtime_config("provider", &settings.to_string()).unwrap();
    let content = codex_profile_content(
        "12345678-1234-1234-1234-123456789abc",
        &runtime.profile.profile_text,
        &["skills.bundled.enabled=false".to_string()],
    ).unwrap();
    let actual: toml::Value = toml::from_slice(&content).unwrap();
    assert!(actual["tui"].get("status_line").is_none());
    assert_eq!(actual["tui"]["notifications"].as_bool(), Some(false));
    assert_eq!(actual["skills"]["bundled"]["enabled"].as_bool(), Some(false));
    assert_eq!(actual["service_tier"].as_str(), Some("fast"));
}

#[test]
fn codex_project_profile_without_provider_uses_extension_config() {
    let content = codex_profile_content(
        "12345678-1234-1234-1234-123456789abc",
        "",
        &[
            "mcp_servers.local.command='''node'''".to_string(),
            "mcp_servers.local.enabled=true".to_string(),
        ],
    )
    .unwrap();
    let parsed = toml::from_slice::<toml::Value>(&content).unwrap();
    assert_eq!(
        parsed["mcp_servers"]["local"]["command"].as_str(),
        Some("node")
    );
    assert_eq!(
        parsed["mcp_servers"]["local"]["enabled"].as_bool(),
        Some(true)
    );
}

#[test]
fn codex_project_profile_rejects_invalid_base_or_override_toml() {
    for (base_config, override_value) in [
        ("[invalid", "skills.bundled.enabled=false"),
        ("", "skills.config=["),
        ("", "skills.bundled.enabled=false\nmodel='injected'"),
    ] {
        assert_eq!(
            codex_profile_content(
                "12345678-1234-1234-1234-123456789abc",
                base_config,
                &[override_value.to_string()],
            )
            .unwrap_err(),
            "extensions_project_codex_profile_invalid"
        );
    }
}

#[test]
fn policy_invalid_ids_are_distinguished_from_empty_custom_set() {
    let available = BTreeSet::from(["known".to_string()]);
    assert!(invalid_ids(&[], &available).is_empty());
    assert_eq!(
        invalid_ids(&["missing".to_string()], &available),
        vec!["missing"]
    );
}
