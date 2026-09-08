use super::codex::toml_hooks_state_key;
use super::grok::{grok_config_path, grok_hooks_path, set_toml_table_bool, toml_table_bool};
use super::kimi_adapter::replace_kimi_config_with_stage_hook;
use super::pi::pi_extension_path;
use super::*;
use tempfile::TempDir;

fn trust_installed_codex_hooks(codex_dir: &Path) {
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let settings = read_json_if_exists(&hooks_path).unwrap();
    let hooks = settings.get("hooks").and_then(Value::as_object).unwrap();
    let mut blocks = Vec::new();
    for event in CODEX_HOOK_EVENTS {
        let event_name = codex_hook_state_event_name(event).unwrap();
        let Some(entries) = hooks.get(event).and_then(Value::as_array) else {
            continue;
        };
        for (entry_index, entry) in entries.iter().enumerate() {
            let commands = entry.get("hooks").and_then(Value::as_array).unwrap();
            for (hook_index, hook) in commands.iter().enumerate() {
                if !is_cli_manager_command(hook, &CODEX_LEGACY_SCRIPTS) {
                    continue;
                }
                let key = toml_escape_basic_string(&format!(
                    "{}:{event_name}:{entry_index}:{hook_index}",
                    path_to_string(&hooks_path)
                ));
                let hash = codex_hook_trusted_hash(event, entry, hook).unwrap();
                blocks.push(format!(
                    "[hooks.state.\"{key}\"]\ntrusted_hash = \"{hash}\""
                ));
            }
        }
    }
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let mut config = fs::read_to_string(&config_path).unwrap();
    config.push('\n');
    config.push_str(&blocks.join("\n\n"));
    config.push('\n');
    fs::write(config_path, config).unwrap();
}

#[test]
fn optional_config_resolution_does_not_create_missing_selected_dirs() {
    let tmp = TempDir::new().unwrap();
    let missing_claude_dir = tmp.path().join("missing-claude");
    let missing_codex_dir = tmp.path().join("missing-codex");
    let missing_kimi_dir = tmp.path().join("missing-kimi");
    let missing_pi_dir = tmp.path().join("missing-pi");
    let missing_grok_dir = tmp.path().join("missing-grok");

    assert_eq!(
        resolve_claude_dir(Some(path_to_string(&missing_claude_dir)), false).unwrap(),
        None
    );
    assert_eq!(
        resolve_codex_dir(Some(path_to_string(&missing_codex_dir)), false).unwrap(),
        None
    );
    assert_eq!(
        resolve_kimi_dir(Some(path_to_string(&missing_kimi_dir))).unwrap(),
        Some(missing_kimi_dir.clone())
    );
    assert_eq!(
        resolve_pi_dir(Some(path_to_string(&missing_pi_dir)), false).unwrap(),
        None
    );
    assert_eq!(
        resolve_grok_dir(Some(path_to_string(&missing_grok_dir)), false).unwrap(),
        None
    );

    assert!(!missing_claude_dir.exists());
    assert!(!missing_codex_dir.exists());
    assert!(!missing_kimi_dir.exists());
    assert!(!missing_pi_dir.exists());
    assert!(!missing_grok_dir.exists());
}

#[test]
fn required_claude_resolution_rejects_missing_selected_dir() {
    let tmp = TempDir::new().unwrap();
    let missing_claude_dir = tmp.path().join("missing-claude");

    let err = resolve_claude_dir(Some(path_to_string(&missing_claude_dir)), true).unwrap_err();

    assert_eq!(err, "选择的 Claude 配置目录不存在");
    assert!(!missing_claude_dir.exists());
}

#[tokio::test]
async fn install_codex_allows_existing_selected_dir() {
    let tmp = TempDir::new().unwrap();
    let claude_dir = tmp.path().join("claude");
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&claude_dir).unwrap();
    fs::create_dir_all(&codex_dir).unwrap();

    install_codex_hooks(&codex_dir).unwrap();
    let untrusted_status = build_codex_status(Some(codex_dir.clone())).unwrap();
    assert!(matches!(
        untrusted_status.status,
        HookInstallStatus::PartialInstalled
    ));
    trust_installed_codex_hooks(&codex_dir);
    let status = build_codex_status(Some(codex_dir.clone())).unwrap();

    assert!(matches!(status.status, HookInstallStatus::Installed));
    // 新方案不写脚本文件，改为校验 hooks.json 已注册指向二进制 __hook 的命令
    assert!(codex_dir.join(CODEX_HOOKS_FILE_NAME).is_file());
    assert!(codex_dir.join(CODEX_CONFIG_FILE_NAME).is_file());
    let hooks_json = fs::read_to_string(codex_dir.join(CODEX_HOOKS_FILE_NAME)).unwrap();
    assert!(hooks_json.contains(HOOK_COMMAND_MARKER));
    assert!(hooks_json.contains("--source codex"));
    assert!(hooks_json.contains("--event SubagentStart"));
    assert!(hooks_json.contains("--event SubagentStop"));
    assert!(hooks_json.contains("--event ToolStart"));
    assert!(hooks_json.contains("--event ToolStop"));
    assert!(hooks_json.contains(CODEX_QUESTION_TOOL_NAME));
    let hooks: Value = serde_json::from_str(&hooks_json).unwrap();
    let exe = hook_exe_for_dir(&codex_dir).unwrap();
    assert!(registered_exact_command_with_matcher(
        &hooks,
        Some(&exe),
        "PreToolUse",
        "codex",
        "Notification",
        CODEX_QUESTION_TOOL_NAME,
    ));
    assert!(registered_exact_command(
        &hooks,
        Some(&exe),
        "PreToolUse",
        "codex",
        "ToolStart",
    ));
    assert!(registered_exact_command(
        &hooks,
        Some(&exe),
        "PostToolUse",
        "codex",
        "ToolStop",
    ));
    assert!(!hooks_json.contains(".ps1"));
    assert!(!codex_dir
        .join("hooks")
        .join(CODEX_ATTENTION_SCRIPT_NAME)
        .is_file());
}

#[test]
fn codex_hook_trusted_hash_matches_codex_canonical_format() {
    let group = json!({
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": "/tmp/cli-manager __hook --source codex --event SessionStart",
            "timeout": 15
        }]
    });
    let hook = &group["hooks"][0];

    assert_eq!(
        codex_hook_trusted_hash("SessionStart", &group, hook).unwrap(),
        "sha256:9e6b7860465f1ee644164253a9e2aee2b124b234b836f5a68330eeb99929dfb4"
    );
}

#[test]
fn codex_hook_state_key_normalizes_basic_and_literal_toml_strings() {
    let key = r"C:\Users\1\.codex\hooks.json:session_start:0:0";
    let basic = format!(r#"[hooks.state."{}"]"#, toml_escape_basic_string(key));
    let literal = format!("[hooks.state.'{key}']");

    assert_eq!(toml_hooks_state_key(&basic), Some(key.to_string()));
    assert_eq!(toml_hooks_state_key(&literal), Some(key.to_string()));
}

#[test]
fn codex_hook_state_merge_replaces_equivalent_literal_key() {
    let key = r"C:\Users\1\.codex\hooks.json:session_start:0:0";
    let existing = format!(
        "[features]\nhooks = true\n\n[hooks.state.'{key}']\ntrusted_hash = \"sha256:old\"\n\n[hooks.state.\"user-hook\"]\ntrusted_hash = \"sha256:user\"\n"
    );
    let blocks = vec![vec![
        format!(r#"[hooks.state."{}"]"#, toml_escape_basic_string(key)),
        "trusted_hash = \"sha256:new\"".to_string(),
    ]];

    let merged = merge_codex_common_config_toml(Some(&existing), &blocks);

    toml::from_str::<toml::Value>(&merged).unwrap();
    assert!(!merged.contains("sha256:old"));
    assert!(merged.contains("sha256:new"));
    assert!(merged.contains("sha256:user"));
}

#[test]
fn claude_common_config_strip_keeps_user_hooks() {
    let managed = r#"{
      "env": {"KEEP": "yes"},
      "hooks": {
        "Stop": [
          {"matcher": "", "hooks": [{"type": "command", "command": "cli-manager __hook --source claude --event Stop"}]},
          {"matcher": "", "hooks": [{"type": "command", "command": "user-hook"}]}
        ]
      }
    }"#;
    let stripped = strip_ccswitch_common_config(Some(managed), CommonConfigTool::Claude)
        .unwrap()
        .unwrap();
    let value: Value = serde_json::from_str(&stripped).unwrap();
    assert_eq!(value["env"]["KEEP"], "yes");
    assert!(stripped.contains("user-hook"));
    assert!(!stripped.contains(HOOK_COMMAND_MARKER));
}

#[test]
fn codex_common_config_strip_keeps_user_features_and_state() {
    let managed = format!(
        "[features]\nhooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}\n\n{CODEX_COMMON_CONFIG_HOOKS_MARKER}\n[hooks.state.\"owned\"]\ntrusted_hash = \"sha256:owned\"\n\n[hooks.state.\"user\"]\ntrusted_hash = \"sha256:user\"\n"
    );
    let stripped = strip_ccswitch_common_config(Some(&managed), CommonConfigTool::Codex)
        .unwrap()
        .unwrap();
    assert!(!stripped.contains(CODEX_COMMON_CONFIG_HOOKS_MARKER));
    assert!(!stripped.contains("sha256:owned"));
    assert!(stripped.contains("sha256:user"));
}

#[tokio::test]
async fn local_ccswitch_uninstall_removes_claude_owned_common_hooks() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("cc-switch.db");
    let claude_dir = tmp.path().join(".claude");
    fs::create_dir_all(&claude_dir).unwrap();
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO settings (key, value) VALUES (?1, ?2)")
        .bind(CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)
        .bind(r#"{"env":{"KEEP":"yes"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}"#)
        .execute(&mut connection)
        .await
        .unwrap();
    drop(connection);

    install_claude_hooks(&claude_dir).unwrap();
    sync_ccswitch_local_common_config(
        &db_path,
        &claude_dir,
        CommonConfigTool::Claude,
        CommonConfigSyncMode::Install,
    )
    .await
    .unwrap();
    uninstall_claude_hooks(&claude_dir).unwrap();
    sync_ccswitch_local_common_config(
        &db_path,
        &claude_dir,
        CommonConfigTool::Claude,
        CommonConfigSyncMode::Uninstall,
    )
    .await
    .unwrap();

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .read_only(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(CCSWITCH_COMMON_CONFIG_CLAUDE_KEY)
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert!(value.contains("KEEP"));
    assert!(value.contains("user-hook"));
    assert!(!value.contains(HOOK_COMMAND_MARKER));
}

#[test]
fn codex_pre_tool_use_trust_hash_includes_matcher() {
    let group = json!({
        "matcher": CODEX_QUESTION_TOOL_NAME,
        "hooks": [{
            "type": "command",
            "command": "/tmp/cli-manager __hook --source codex --event Notification",
            "timeout": 15
        }]
    });
    let mut changed = group.clone();
    changed["matcher"] = json!("other_tool");

    assert_eq!(
        codex_hook_state_event_name("PreToolUse"),
        Some("pre_tool_use")
    );
    assert_ne!(
        codex_hook_trusted_hash("PreToolUse", &group, &group["hooks"][0]).unwrap(),
        codex_hook_trusted_hash("PreToolUse", &changed, &changed["hooks"][0]).unwrap()
    );
}

#[test]
fn codex_status_repairs_disabled_or_stale_hook_trust() {
    let tmp = TempDir::new().unwrap();
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&codex_dir).unwrap();
    install_codex_hooks(&codex_dir).unwrap();
    let missing = build_codex_status_with_trust_repair(Some(codex_dir.clone())).unwrap();
    assert!(matches!(missing.status, HookInstallStatus::Installed));
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let mut trusted = fs::read_to_string(&config_path).unwrap();
    trusted.push_str("\n[hooks.state.\"user-hook\"]\ntrusted_hash = \"sha256:user\"\n");

    fs::write(
        &config_path,
        trusted.replacen("trusted_hash =", "enabled = false\ntrusted_hash =", 1),
    )
    .unwrap();
    let disabled = build_codex_status_with_trust_repair(Some(codex_dir.clone())).unwrap();
    assert!(matches!(disabled.status, HookInstallStatus::Installed));

    fs::write(
        &config_path,
        trusted.replacen("sha256:", "sha256:stale-", 1),
    )
    .unwrap();
    let stale = build_codex_status_with_trust_repair(Some(codex_dir)).unwrap();
    assert!(matches!(stale.status, HookInstallStatus::Installed));
    assert!(fs::read_to_string(config_path)
        .unwrap()
        .contains("[hooks.state.\"user-hook\"]\ntrusted_hash = \"sha256:user\""));
}

#[test]
fn codex_status_repairs_equivalent_duplicate_hook_state_keys() {
    let tmp = TempDir::new().unwrap();
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&codex_dir).unwrap();
    install_codex_hooks(&codex_dir).unwrap();
    let installed = build_codex_status_with_trust_repair(Some(codex_dir.clone())).unwrap();
    assert!(matches!(installed.status, HookInstallStatus::Installed));

    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let settings = read_json_if_exists(&hooks_path).unwrap();
    let key = codex_cli_manager_hook_state_keys(&settings, &hooks_path)
        .into_iter()
        .next()
        .unwrap();
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let config = fs::read_to_string(&config_path).unwrap();
    let broken = format!("[hooks.state.'{key}']\ntrusted_hash = \"sha256:old\"\n\n{config}");
    fs::write(&config_path, broken).unwrap();
    assert!(build_codex_status(Some(codex_dir.clone())).is_err());

    let repaired = build_codex_status_with_trust_repair(Some(codex_dir)).unwrap();

    assert!(matches!(repaired.status, HookInstallStatus::Installed));
    let config = fs::read_to_string(config_path).unwrap();
    toml::from_str::<toml::Value>(&config).unwrap();
    assert!(!config.contains("sha256:old"));
}

#[test]
fn codex_status_does_not_repair_trust_when_required_hook_is_missing() {
    let tmp = TempDir::new().unwrap();
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&codex_dir).unwrap();
    install_codex_hooks(&codex_dir).unwrap();
    trust_installed_codex_hooks(&codex_dir);
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path).unwrap();
    settings["hooks"].as_object_mut().unwrap().remove("Stop");
    write_json(&hooks_path, &settings).unwrap();
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let trusted = fs::read_to_string(&config_path).unwrap();
    fs::write(
        &config_path,
        trusted.replacen("sha256:", "sha256:stale-", 1),
    )
    .unwrap();

    let status = build_codex_status_with_trust_repair(Some(codex_dir)).unwrap();

    assert!(matches!(status.status, HookInstallStatus::PartialInstalled));
    assert!(fs::read_to_string(config_path)
        .unwrap()
        .contains("sha256:stale-"));
}

#[tokio::test]
async fn install_codex_registers_and_uninstall_removes_subagent_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let claude_dir = tmp.path().join("claude");
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&claude_dir).unwrap();
    fs::create_dir_all(&codex_dir).unwrap();

    install_codex_hooks(&codex_dir).unwrap();
    let status = build_codex_status(Some(codex_dir.clone())).unwrap();
    assert!(status.subagent_start_hook_installed);
    let after_install = fs::read_to_string(codex_dir.join(CODEX_HOOKS_FILE_NAME)).unwrap();
    assert!(after_install.contains("--event SubagentStart"));
    assert!(after_install.contains("--event SubagentStop"));
    assert!(after_install.contains("--event ToolStart"));
    assert!(after_install.contains("--event ToolStop"));

    uninstall_codex_hooks(&codex_dir).unwrap();
    let after_uninstall = fs::read_to_string(codex_dir.join(CODEX_HOOKS_FILE_NAME)).unwrap();
    assert!(!after_uninstall.contains("--event SubagentStart"));
    assert!(!after_uninstall.contains("--event SubagentStop"));
    assert!(!after_uninstall.contains("--event ToolStart"));
    assert!(!after_uninstall.contains("--event ToolStop"));
}

#[test]
fn codex_status_requires_internal_tool_lifecycle_upgrade() {
    let tmp = TempDir::new().unwrap();
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&codex_dir).unwrap();
    install_codex_hooks(&codex_dir).unwrap();
    trust_installed_codex_hooks(&codex_dir);

    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path).unwrap();
    remove_named_hook_command(&mut settings, "PostToolUse", "codex", "ToolStop");
    write_json(&hooks_path, &settings).unwrap();

    let status = build_codex_status_with_trust_repair(Some(codex_dir)).unwrap();
    assert!(!status.subagent_start_hook_installed);
    assert!(matches!(status.status, HookInstallStatus::PartialInstalled));
}

#[tokio::test]
async fn install_then_uninstall_grok_writes_hooks_and_disables_compat() {
    let tmp = TempDir::new().unwrap();
    let grok_dir = tmp.path().join("grok");
    fs::create_dir_all(&grok_dir).unwrap();

    install_grok_hooks(&grok_dir).unwrap();
    let status = build_grok_status(Some(grok_dir.clone())).unwrap();
    assert!(matches!(status.status, HookInstallStatus::Installed));
    assert!(status.hooks_feature_installed);

    let hooks_json = fs::read_to_string(grok_hooks_path(&grok_dir)).unwrap();
    assert!(hooks_json.contains(HOOK_COMMAND_MARKER));
    assert!(hooks_json.contains("--source grok"));
    assert!(hooks_json.contains("--event SessionStart"));
    assert!(hooks_json.contains("--event PermissionRequest"));
    assert!(hooks_json.contains("Bash|Edit|Write|MultiEdit"));
    assert!(hooks_json.contains("--event ToolStart"));
    assert!(!hooks_json.contains("--event Notification"));

    let config = fs::read_to_string(grok_config_path(&grok_dir)).unwrap();
    assert!(config.contains("[compat.claude]"));
    assert!(config.contains("[compat.cursor]"));
    assert_eq!(
        toml_table_bool(&config, "compat.claude", "hooks"),
        Some(false)
    );
    assert_eq!(
        toml_table_bool(&config, "compat.cursor", "hooks"),
        Some(false)
    );

    uninstall_grok_hooks(&grok_dir).unwrap();
    let status = build_grok_status(Some(grok_dir.clone())).unwrap();
    assert!(!matches!(status.status, HookInstallStatus::Installed));
    // Uninstall must NOT re-enable foreign hooks.
    let config = fs::read_to_string(grok_config_path(&grok_dir)).unwrap();
    assert_eq!(
        toml_table_bool(&config, "compat.claude", "hooks"),
        Some(false)
    );
    assert_eq!(
        toml_table_bool(&config, "compat.cursor", "hooks"),
        Some(false)
    );
}

#[test]
fn uninstall_grok_attention_preserves_tool_start_hook() {
    let tmp = TempDir::new().unwrap();
    let grok_dir = tmp.path().join("grok");
    fs::create_dir_all(&grok_dir).unwrap();

    install_grok_hooks(&grok_dir).unwrap();
    uninstall_grok_hook_module(&grok_dir, ClaudeHookModule::Attention).unwrap();

    let settings = read_json(&grok_hooks_path(&grok_dir)).unwrap();
    let exe = hook_exe_for_dir(&grok_dir).unwrap();
    assert!(!registered_exact_command(
        &settings,
        Some(&exe),
        "PreToolUse",
        "grok",
        "PermissionRequest",
    ));
    assert!(registered_exact_command(
        &settings,
        Some(&exe),
        "PreToolUse",
        "grok",
        "ToolStart",
    ));
}

#[test]
fn install_grok_attention_upgrades_obsolete_notification_hook() {
    let tmp = TempDir::new().unwrap();
    let grok_dir = tmp.path().join("grok");
    fs::create_dir_all(&grok_dir).unwrap();
    let exe = hook_exe_for_dir(&grok_dir).unwrap();
    let hooks_path = grok_hooks_path(&grok_dir);
    let mut settings = json!({});
    add_hook_command_with_matcher(
        &mut settings,
        "Notification",
        "permission_prompt|idle_prompt",
        build_command(&exe, "grok", "Notification"),
    );
    fs::create_dir_all(hooks_path.parent().unwrap()).unwrap();
    write_json(&hooks_path, &settings).unwrap();

    install_grok_hook_module(&grok_dir, ClaudeHookModule::Attention).unwrap();

    let settings = read_json(&hooks_path).unwrap();
    assert!(!registered_exact_command(
        &settings,
        Some(&exe),
        "Notification",
        "grok",
        "Notification",
    ));
    assert!(registered_exact_command(
        &settings,
        Some(&exe),
        "PreToolUse",
        "grok",
        "PermissionRequest",
    ));
}

#[test]
fn set_toml_table_bool_updates_existing_and_preserves_other_keys() {
    let input = r#"
[models]
default = "x"

[compat.claude]
skills = true
hooks = true

[ui]
yolo = false
"#;
    let out = set_toml_table_bool(input, "compat.claude", "hooks", false);
    assert_eq!(toml_table_bool(&out, "compat.claude", "hooks"), Some(false));
    assert!(out.contains("skills = true"));
    assert!(out.contains("[models]"));
    assert!(out.contains("[ui]"));
}

#[tokio::test]
async fn install_then_uninstall_claude_removes_hook_commands() {
    let tmp = TempDir::new().unwrap();
    let claude_dir = tmp.path().join("claude");
    fs::create_dir_all(&claude_dir).unwrap();

    install_claude_hooks(&claude_dir).unwrap();
    let settings_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let after_install = fs::read_to_string(&settings_path).unwrap();
    assert!(after_install.contains(HOOK_COMMAND_MARKER));
    assert!(after_install.contains("--source claude"));

    uninstall_claude_hooks(&claude_dir).unwrap();
    let after_uninstall = fs::read_to_string(&settings_path).unwrap();
    assert!(!after_uninstall.contains(HOOK_COMMAND_MARKER));
}

#[tokio::test]
async fn install_claude_registers_and_uninstall_removes_subagent_start() {
    let tmp = TempDir::new().unwrap();
    let claude_dir = tmp.path().join("claude");
    fs::create_dir_all(&claude_dir).unwrap();

    install_claude_hooks(&claude_dir).unwrap();
    let status = build_claude_status(Some(claude_dir.clone())).unwrap();
    assert!(status.subagent_start_hook_installed);
    let after_install = fs::read_to_string(claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
    assert!(after_install.contains("--event SubagentStart"));
    assert!(after_install.contains("--event SubagentStop"));
    assert!(after_install.contains("PreToolUse"));
    assert!(after_install.contains("PostToolUse"));
    assert!(after_install.contains("--event AgentToolStart"));
    assert!(after_install.contains("--event AgentToolStop"));
    assert!(after_install.contains("--event ToolStart"));
    assert!(after_install.contains("--event ToolStop"));
    assert!(after_install.contains(CLAUDE_QUESTION_TOOL_NAME));

    uninstall_claude_hooks(&claude_dir).unwrap();
    let after_uninstall = fs::read_to_string(claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
    assert!(!after_uninstall.contains("--event SubagentStart"));
    assert!(!after_uninstall.contains("--event SubagentStop"));
    assert!(!after_uninstall.contains("--event AgentToolStart"));
    assert!(!after_uninstall.contains("--event AgentToolStop"));
    assert!(!after_uninstall.contains("--event ToolStart"));
    assert!(!after_uninstall.contains("--event ToolStop"));
}

#[test]
fn uninstall_claude_attention_preserves_tool_lifecycle_hooks() {
    let tmp = TempDir::new().unwrap();
    let claude_dir = tmp.path().join("claude");
    fs::create_dir_all(&claude_dir).unwrap();
    install_claude_hooks(&claude_dir).unwrap();

    uninstall_claude_hook_module(&claude_dir, ClaudeHookModule::Attention).unwrap();

    let settings = read_json(&claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
    let exe = hook_exe_for_dir(&claude_dir).unwrap();
    assert!(!registered_exact_command_with_matcher(
        &settings,
        Some(&exe),
        "PreToolUse",
        "claude",
        "Notification",
        CLAUDE_QUESTION_TOOL_NAME,
    ));
    assert!(registered_exact_command(
        &settings,
        Some(&exe),
        "PreToolUse",
        "claude",
        "ToolStart",
    ));
    assert!(registered_exact_command(
        &settings,
        Some(&exe),
        "PreToolUse",
        "claude",
        "AgentToolStart",
    ));
}

#[test]
fn wrong_question_matcher_keeps_local_hook_status_partial() {
    let tmp = TempDir::new().unwrap();
    let claude_dir = tmp.path().join("claude");
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&claude_dir).unwrap();
    fs::create_dir_all(&codex_dir).unwrap();

    install_claude_hooks(&claude_dir).unwrap();
    let claude_path = claude_dir.join(CLAUDE_SETTINGS_FILE_NAME);
    let mut claude_settings = read_json(&claude_path).unwrap();
    let claude_question = claude_settings["hooks"]["PreToolUse"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| {
            entry.get("matcher").and_then(Value::as_str) == Some(CLAUDE_QUESTION_TOOL_NAME)
        })
        .unwrap();
    claude_question["matcher"] = json!("OtherTool");
    write_json(&claude_path, &claude_settings).unwrap();
    let claude_status = build_claude_status(Some(claude_dir)).unwrap();
    assert!(!claude_status.attention_hook_installed);
    assert!(matches!(
        claude_status.status,
        HookInstallStatus::PartialInstalled
    ));

    install_codex_hooks(&codex_dir).unwrap();
    trust_installed_codex_hooks(&codex_dir);
    let codex_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut codex_settings = read_json(&codex_path).unwrap();
    let codex_question = codex_settings["hooks"]["PreToolUse"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| {
            entry.get("matcher").and_then(Value::as_str) == Some(CODEX_QUESTION_TOOL_NAME)
        })
        .unwrap();
    codex_question["matcher"] = json!("OtherTool");
    write_json(&codex_path, &codex_settings).unwrap();
    let codex_status = build_codex_status_with_trust_repair(Some(codex_dir)).unwrap();
    assert!(!codex_status.attention_hook_installed);
    assert!(matches!(
        codex_status.status,
        HookInstallStatus::PartialInstalled
    ));
}

#[tokio::test]
async fn install_claude_single_module_only_writes_requested_event() {
    let tmp = TempDir::new().unwrap();
    let claude_dir = tmp.path().join("claude");
    fs::create_dir_all(&claude_dir).unwrap();

    install_claude_hook_module(&claude_dir, ClaudeHookModule::Running).unwrap();

    let settings = fs::read_to_string(claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
    assert!(settings.contains("--event UserPromptSubmit"));
    assert!(!settings.contains("--event SessionStart"));
    assert!(!settings.contains("--event Stop"));
    assert!(!settings.contains("--event SubagentStart"));
}

#[tokio::test]
async fn install_codex_hooks_feature_module_only_toggles_config() {
    let tmp = TempDir::new().unwrap();
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&codex_dir).unwrap();

    install_codex_hook_module(&codex_dir, CodexHookModule::HooksFeature).unwrap();
    let config_after_install = fs::read_to_string(codex_dir.join(CODEX_CONFIG_FILE_NAME)).unwrap();
    assert!(config_after_install.contains("hooks = true"));
    assert!(!codex_dir.join(CODEX_HOOKS_FILE_NAME).exists());

    uninstall_codex_hook_module(&codex_dir, CodexHookModule::HooksFeature).unwrap();
    let config_after_uninstall =
        fs::read_to_string(codex_dir.join(CODEX_CONFIG_FILE_NAME)).unwrap();
    assert!(config_after_uninstall.contains("hooks = false"));
    assert!(!codex_dir.join(CODEX_HOOKS_FILE_NAME).exists());
}

#[test]
fn codex_hooks_feature_status_accepts_a_trailing_inline_comment() {
    let tmp = TempDir::new().unwrap();
    let config_path = tmp.path().join(CODEX_CONFIG_FILE_NAME);
    fs::write(&config_path, "[features]\nhooks = true # user comment\n").unwrap();

    assert!(codex_hooks_feature_installed(&config_path).unwrap());
}

#[tokio::test]
async fn empty_codex_status_is_not_installed() {
    let tmp = TempDir::new().unwrap();
    let codex_dir = tmp.path().join("codex");
    fs::create_dir_all(&codex_dir).unwrap();

    let status = build_codex_status(Some(codex_dir)).unwrap();

    assert!(matches!(status.status, HookInstallStatus::NotInstalled));
}

#[tokio::test]
async fn install_claude_cleans_legacy_ps1_command() {
    let tmp = TempDir::new().unwrap();
    let claude_dir = tmp.path().join("claude");
    let hooks_dir = claude_dir.join("hooks");
    fs::create_dir_all(&hooks_dir).unwrap();
    // 预置旧版 .ps1 脚本文件与对应注册命令，验证安装即升级会清掉历史项
    fs::write(hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME), "old").unwrap();
    let legacy = json!({
        "hooks": {
            "Stop": [{
                "matcher": "",
                "hooks": [{
                    "type": "command",
                    "command": format!("powershell -File \"{}\" -Event Stop", CLAUDE_APPROVAL_SCRIPT_NAME),
                    "timeout": 15
                }]
            }]
        }
    });
    fs::write(
        claude_dir.join(CLAUDE_SETTINGS_FILE_NAME),
        serde_json::to_string_pretty(&legacy).unwrap(),
    )
    .unwrap();

    install_claude_hooks(&claude_dir).unwrap();

    let settings = fs::read_to_string(claude_dir.join(CLAUDE_SETTINGS_FILE_NAME)).unwrap();
    assert!(!settings.contains(".ps1"));
    assert!(settings.contains(HOOK_COMMAND_MARKER));
    assert!(!hooks_dir.join(CLAUDE_APPROVAL_SCRIPT_NAME).is_file());
}

#[test]
fn build_command_wraps_windows_native_path_for_powershell() {
    let command = build_command(
        r"D:\Program Files\CLI-Manager\cli-manager.exe",
        "codex",
        "SessionStart",
    );

    assert_eq!(
        command,
        r#"powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'D:\Program Files\CLI-Manager\cli-manager.exe' __hook --source codex --event SessionStart""#
    );
}

#[test]
fn build_command_escapes_powershell_single_quote_in_windows_path() {
    let command = build_command(
        r"D:\Program Files\CLI-Manager's\cli-manager.exe",
        "claude",
        "Stop",
    );

    assert_eq!(
        command,
        r#"powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'D:\Program Files\CLI-Manager''s\cli-manager.exe' __hook --source claude --event Stop""#
    );
}

#[test]
fn build_command_keeps_wsl_mnt_path_shell_format() {
    let command = build_command(
        "/mnt/d/Program Files/CLI-Manager/cli-manager.exe",
        "codex",
        "SessionStart",
    );

    assert_eq!(
        command,
        "'/mnt/d/Program Files/CLI-Manager/cli-manager.exe' __hook --source codex --event SessionStart"
    );
}

#[test]
fn build_command_escapes_posix_single_quote() {
    let command = build_command("/Users/me/CLI-Manager's/cli-manager", "claude", "Stop");

    assert_eq!(
        command,
        "'/Users/me/CLI-Manager'\\''s/cli-manager' __hook --source claude --event Stop"
    );
}
#[tokio::test]
async fn install_then_uninstall_pi_extension() {
    let tmp = TempDir::new().unwrap();
    let pi_dir = tmp.path().join("pi-agent");
    fs::create_dir_all(&pi_dir).unwrap();

    install_pi_hooks(&pi_dir).unwrap();
    let status = build_pi_status(Some(pi_dir.clone())).unwrap();
    assert!(matches!(status.status, HookInstallStatus::Installed));
    assert!(status.session_start_hook_installed);
    assert!(status.running_hook_installed);
    assert!(status.stop_hook_installed);
    let extension = fs::read_to_string(pi_extension_path(&pi_dir)).unwrap();
    assert!(extension.contains(PI_EXTENSION_MARKER));
    assert!(extension.contains(r#"source: "pi""#));
    assert!(extension.contains("session_start"));
    assert!(extension.contains("agent_start"));
    assert!(extension.contains("agent_settled"));
    assert!(!extension.contains("before_agent_start"));
    assert!(extension.contains("void postHookEvent"));
    assert!(!extension.contains("await postHookEvent"));
    assert!(extension.contains("AbortController"));
    assert!(extension.contains("HOOK_TIMEOUT_MS = 1_000"));

    uninstall_pi_hooks(&pi_dir).unwrap();
    let after = build_pi_status(Some(pi_dir.clone())).unwrap();
    assert!(matches!(after.status, HookInstallStatus::NotInstalled));
    assert!(!pi_extension_path(&pi_dir).is_file());
}

#[tokio::test]
async fn install_pi_single_module_only_enables_requested_event() {
    let tmp = TempDir::new().unwrap();
    let pi_dir = tmp.path().join("pi-agent");
    fs::create_dir_all(&pi_dir).unwrap();

    install_pi_hook_module(&pi_dir, PiHookModule::SessionStart).unwrap();
    let status = build_pi_status(Some(pi_dir.clone())).unwrap();
    assert!(matches!(status.status, HookInstallStatus::PartialInstalled));
    assert!(status.session_start_hook_installed);
    assert!(!status.running_hook_installed);
    assert!(!status.stop_hook_installed);
}

#[test]
fn install_pi_preserves_unmanaged_extension() {
    let tmp = TempDir::new().unwrap();
    let pi_dir = tmp.path().join("pi-agent");
    let extensions_dir = pi_dir.join(PI_EXTENSION_DIR_NAME);
    fs::create_dir_all(&extensions_dir).unwrap();
    let extension_path = pi_extension_path(&pi_dir);
    let user_content = "export default function userExtension() {}\n";
    fs::write(&extension_path, user_content).unwrap();

    let error = install_pi_hooks(&pi_dir).unwrap_err();

    assert_eq!(error, PI_EXTENSION_CONFLICT_ERROR);
    assert_eq!(fs::read_to_string(extension_path).unwrap(), user_content);
}

#[test]
fn kimi_write_revalidates_live_config_before_replace() {
    let tmp = TempDir::new().unwrap();
    let config_path = tmp.path().join(KIMI_CONFIG_FILE_NAME);
    fs::write(&config_path, "before\n").unwrap();
    let external_path = config_path.clone();

    let error = replace_kimi_config_with_stage_hook(
        &config_path,
        Some("before\n".to_string()),
        "after\n",
        move || {
            fs::write(&external_path, "external\n").unwrap();
            Ok(())
        },
    )
    .unwrap_err();

    assert_eq!(error, "kimi_config_changed");
    assert_eq!(fs::read_to_string(config_path).unwrap(), "external\n");
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
}

#[test]
fn kimi_status_and_first_install_do_not_require_cli() {
    let tmp = TempDir::new().unwrap();
    let kimi_dir = tmp.path().join("new-kimi-home");

    let before = build_kimi_status(Some(kimi_dir.clone())).unwrap();
    assert!(matches!(before.status, HookInstallStatus::NotInstalled));

    install_kimi_hooks(&kimi_dir, &ALL_KIMI_HOOK_MODULES).unwrap();

    let config = fs::read_to_string(kimi_dir.join(KIMI_CONFIG_FILE_NAME)).unwrap();
    assert_eq!(config.matches("--source kimi").count(), 9);
    let after = build_kimi_status(Some(kimi_dir)).unwrap();
    assert!(matches!(after.status, HookInstallStatus::Installed));
}

#[cfg(windows)]
#[test]
fn hook_exe_for_dir_uses_mnt_form_for_wsl_target() {
    let native = cli_manager_exe().unwrap();
    // WSL/UNC 目标：exe 转 /mnt 形式
    let wsl_exe =
        hook_exe_for_dir(Path::new(r"\\wsl.localhost\Ubuntu-22.04\home\me\.claude")).unwrap();
    assert!(wsl_exe.starts_with("/mnt/"), "got {wsl_exe}");
    // 普通 Windows 目标：保持原生路径
    assert_eq!(
        hook_exe_for_dir(Path::new(r"C:\Users\me\.claude")).unwrap(),
        native
    );
}
