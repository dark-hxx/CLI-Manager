use super::live_files::parse_wsl_batch_reads;
use super::materialize::remove_toml_secret_fields;
use super::*;
use crate::provider::home::DerivedCliTargets;
use serde_json::json;
use toml_edit::DocumentMut;

#[test]
// 验证 Claude 配置生成保留 hooks、权限、未知字段和用户环境项，并替换供应商端点与认证值。
fn claude_writer_preserves_user_owned_fields() {
    let before = br#"{
      "hooks": {"UserPromptSubmit": []},
      "permissions": {"allow": ["Read"]},
      "env": {"ANTHROPIC_AUTH_TOKEN": "old", "USER_FLAG": "keep"},
      "unknown": {"value": true}
    }"#;
    let effective = json!({
        "env": {
            "ANTHROPIC_BASE_URL": "https://provider.test",
            "ANTHROPIC_MODEL": "claude-test"
        }
    });
    let (bytes, _) = materialize_claude(Some(before), &effective, "new-secret").unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["hooks"]["UserPromptSubmit"], json!([]));
    assert_eq!(value["permissions"]["allow"], json!(["Read"]));
    assert_eq!(value["unknown"]["value"], json!(true));
    assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "https://provider.test");
    assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "new-secret");
    assert_eq!(value["env"]["USER_FLAG"], "keep");
    assert!(!String::from_utf8(bytes).unwrap().contains("old"));
}

#[test]
// 验证同时存在两个认证键时，空 AUTH_TOKEN 标记优先接收新凭据并移除另一键。
fn claude_writer_prefers_explicit_auth_field_marker() {
    let effective = json!({
        "env": {
            "ANTHROPIC_AUTH_TOKEN": "",
            "ANTHROPIC_API_KEY": "common-value",
            "ANTHROPIC_MODEL": "claude-test"
        }
    });
    let (bytes, _) = materialize_claude(None, &effective, "new-secret").unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "new-secret");
    assert!(value["env"]["ANTHROPIC_API_KEY"].is_null());
}

#[test]
// 验证旧 AUTH_TOKEN 与空 API_KEY 并存时，新凭据写入 API_KEY 并移除旧认证键。
fn claude_writer_honors_api_key_marker_when_token_is_legacy() {
    let effective = json!({
        "env": {
            "ANTHROPIC_AUTH_TOKEN": "legacy-value",
            "ANTHROPIC_API_KEY": "",
            "ANTHROPIC_MODEL": "claude-test"
        }
    });
    let (bytes, _) = materialize_claude(None, &effective, "new-secret").unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["env"]["ANTHROPIC_API_KEY"], "new-secret");
    assert!(value["env"]["ANTHROPIC_AUTH_TOKEN"].is_null());
}

#[test]
// 验证 Claude 本地路由投影替换端点与认证占位符，移除直连 token 并保留 hooks。
fn local_route_projection_replaces_claude_endpoint_and_credential() {
    let mut plan = ProviderPlan {
        app_type: "claude".to_string(),
        provider_id: "provider".to_string(),
        provider_name: "Provider".to_string(),
        source_signature: String::new(),
        home: ProviderHomeState {
            identity: HomeIdentity {
                environment_kind: "local".to_string(),
                environment_id: "host".to_string(),
                identity: "local:host".to_string(),
            },
            mode: "auto".to_string(),
            home_path: "C:\\Users\\test".to_string(),
            source: "detected".to_string(),
            targets: DerivedCliTargets {
                home_path: String::new(),
                claude_config_dir: String::new(),
                claude_history_root: String::new(),
                codex_config_dir: String::new(),
                codex_history_root: String::new(),
                grok_config_dir: String::new(),
                grok_history_root: String::new(),
            },
        },
        targets: vec![PlannedTarget {
            target: "claude.settings".to_string(),
            path: "settings.json".to_string(),
            before: None,
            desired: br#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret"},"hooks":{}}"#.to_vec(),
            owned_fields: Vec::new(),
        }],
    };
    apply_local_route_projection(
        &mut plan,
        &LocalRouteProjection {
            endpoint: "http://127.0.0.1:15721".to_string(),
        },
    )
    .unwrap();
    let value: Value = serde_json::from_slice(&plan.targets[0].desired).unwrap();
    assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:15721");
    assert_eq!(
        value["env"]["ANTHROPIC_API_KEY"],
        ROUTED_CREDENTIAL_SENTINEL
    );
    assert!(value["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
    assert!(value["hooks"].is_object());
}

#[test]
// 验证 Codex 路由投影更新认证与带 /v1 的端点，同时保留账户信息、模型及 MCP 配置。
fn local_route_projection_updates_codex_auth_and_config_without_losing_unowned_data() {
    let mut plan = ProviderPlan {
        app_type: "codex".to_string(),
        provider_id: "provider".to_string(),
        provider_name: "Provider".to_string(),
        source_signature: String::new(),
        home: matching_home(),
        targets: vec![
            PlannedTarget {
                target: "codex.auth".to_string(),
                path: "auth.json".to_string(),
                before: None,
                desired: br#"{"OPENAI_API_KEY":"direct","account_id":"keep"}"#.to_vec(),
                owned_fields: Vec::new(),
            },
            PlannedTarget {
                target: "codex.config".to_string(),
                path: "config.toml".to_string(),
                before: None,
                desired: br#"model = "gpt-5"
model_provider = "cli_manager"

[model_providers.cli_manager]
name = "Provider"
base_url = "https://provider.test/v1"

[mcp_servers.demo]
command = "demo"
"#
                .to_vec(),
                owned_fields: Vec::new(),
            },
        ],
    };

    apply_local_route_projection(
        &mut plan,
        &LocalRouteProjection {
            endpoint: "http://127.0.0.1:15721".to_string(),
        },
    )
    .unwrap();

    let auth: Value = serde_json::from_slice(&plan.targets[0].desired).unwrap();
    assert_eq!(auth["OPENAI_API_KEY"], ROUTED_CREDENTIAL_SENTINEL);
    assert_eq!(auth["account_id"], "keep");

    let config = String::from_utf8(plan.targets[1].desired.clone()).unwrap();
    assert!(config.contains("model = \"gpt-5\""));
    assert!(config.contains("base_url = \"http://127.0.0.1:15721/v1\""));
    assert!(config.contains("[mcp_servers.demo]"));
}

#[test]
// 验证 Grok 样例路由投影更新所选模型的端点和凭据并保留 MCP 段；样例未包含其他模型配置。
fn local_route_projection_updates_grok_selected_model_only() {
    let mut plan = ProviderPlan {
        app_type: "grokbuild".to_string(),
        provider_id: "provider".to_string(),
        provider_name: "Provider".to_string(),
        source_signature: String::new(),
        home: matching_home(),
        targets: vec![PlannedTarget {
            target: "grokbuild.config".to_string(),
            path: "config.toml".to_string(),
            before: None,
            desired: br#"[models]
default = "proxy"

[model.proxy]
model = "grok-test"
base_url = "https://provider.test"
api_key = "direct"

[mcp_servers.demo]
command = "demo"
"#
            .to_vec(),
            owned_fields: Vec::new(),
        }],
    };

    apply_local_route_projection(
        &mut plan,
        &LocalRouteProjection {
            endpoint: "http://127.0.0.1:15721".to_string(),
        },
    )
    .unwrap();

    let config = String::from_utf8(plan.targets[0].desired.clone()).unwrap();
    assert!(config.contains("model = \"grok-test\""));
    assert!(config.contains("base_url = \"http://127.0.0.1:15721\""));
    assert!(config.contains("api_key = \"CLI_MANAGER_ROUTED\""));
    assert!(config.contains("[mcp_servers.demo]"));
    assert!(!config.contains("api_key = \"direct\""));
}

#[test]
// 验证无投影与显式本地路由投影分别映射为直连和本地路由模式。
fn global_writer_has_explicit_direct_and_local_route_modes() {
    let projection = LocalRouteProjection {
        endpoint: "http://127.0.0.1:15721".to_string(),
    };
    assert_eq!(projection_mode(None), ProjectionMode::Direct);
    assert_eq!(
        projection_mode(Some(&projection)),
        ProjectionMode::LocalRoute(projection)
    );
}

#[test]
// 验证路由端点拒绝样例通配地址 0.0.0.0，不代表拒绝全部非回环地址。
fn local_route_projection_rejects_non_loopback_endpoint() {
    let result = route_endpoint_with_suffix("http://0.0.0.0:15721", "");
    assert_eq!(result.unwrap_err(), "routing_endpoint_invalid");
}

#[test]
// 验证样例 WSL 网关端点被接受；本测试只处理字符串，不探测真实网关。
fn local_route_projection_accepts_validated_wsl_gateway_endpoint() {
    assert_eq!(
        route_endpoint_with_suffix("http://172.28.224.1:15721", ""),
        Ok("http://172.28.224.1:15721".to_string())
    );
}

#[test]
// 验证 Codex auth 生成移除整个旧 auth 节点及旧密钥，保留未知顶层字段并写入新密钥。
fn codex_auth_writer_removes_legacy_top_level_credentials() {
    let before = br#"{
      "OPENAI_API_KEY": "old-root-secret",
      "auth": {"api_key": "old-nested-secret", "account_id": "keep"},
      "unknown": true
    }"#;
    let effective = json!({"auth": {"api_key": "marker"}});
    let (bytes, _) = materialize_codex_auth(Some(before), &effective, "new-secret").unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["OPENAI_API_KEY"], "new-secret");
    assert!(value.get("auth").is_none());
    assert!(!String::from_utf8(bytes)
        .unwrap()
        .contains("old-nested-secret"));
    assert!(value["unknown"].as_bool().unwrap());
}

#[test]
// 验证 Codex 配置生成保留已有注释与 MCP 段，复制来源模型配置并移除样例认证字段。
fn codex_writer_preserves_unowned_toml_sections() {
    let before = br#"# keep
[mcp_servers.demo]
command = "demo"
model = "old"
    model_provider = "old-provider"
"#;
    let effective = json!({
        "config": "[model_providers.demo]\nname = \"new\"\nauthorization = \"nested-secret\"\n\nmodel = \"gpt-new\"\nmodel_provider = \"demo\"\n"
    });
    let (bytes, _) = materialize_codex_config(Some(before), &effective).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("# keep"));
    assert!(text.contains("[mcp_servers.demo]"));
    assert!(text.contains("model = \"gpt-new\""));
    assert!(text.contains("model_provider = \"demo\""));
    assert!(!text.contains("env_key"));
    assert!(!text.contains("nested-secret"));
    assert!(!text.contains("authorization"));
}

#[test]
// 验证敏感字段清理访问表数组中的两个元素，不在首个命中后短路。
fn codex_secret_cleanup_visits_every_array_of_tables_entry() {
    let mut document =
        "[[profiles]]\napi_key = \"first-secret\"\n\n[[profiles]]\napi_key = \"second-secret\"\n"
            .parse::<DocumentMut>()
            .unwrap();
    assert!(remove_toml_secret_fields(document.as_item_mut()));
    let text = document.to_string();
    assert!(!text.contains("first-secret"));
    assert!(!text.contains("second-secret"));
}

#[test]
// 验证显式端点与模型生成默认 Codex 供应商映射，输出不含 env_key。
fn codex_writer_projects_typed_endpoint_and_model() {
    let effective = json!({
        "base_url": "https://codex.test",
        "model": "gpt-codex"
    });
    let (bytes, _) = materialize_codex_config(None, &effective).unwrap();
    let document = String::from_utf8(bytes).unwrap();
    assert!(document.contains("model = \"gpt-codex\""));
    assert!(document.contains("model_provider = \"cli_manager\""));
    assert!(document.contains("base_url = \"https://codex.test\""));
    assert!(!document.contains("env_key"));
}

#[test]
// 验证生成配置清除旧顶层连接字段，保留新端点对应的模型供应商表。
fn codex_writer_removes_legacy_root_endpoint_fields() {
    let before = br#"base_url = "https://old.example"
wire_api = "responses"
"#;
    let effective = json!({
        "config": "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://new.example/v1\"\nwire_api = \"responses\"\n",
        "base_url": "https://new.example/v1",
        "model": "gpt-test"
    });
    let (bytes, _) = materialize_codex_config(Some(before), &effective).unwrap();
    let document = String::from_utf8(bytes).unwrap();
    assert!(!document.starts_with("base_url ="));
    assert!(!document.contains("wire_api = \"responses\"\n\n[model_providers]"));
    assert!(document.contains("[model_providers.custom]"));
    assert!(document.contains("base_url = \"https://new.example/v1\""));
}

#[test]
// 验证 Grok 全局配置将给定凭据内联写入所选模型，输出不含 env_key。
fn grok_global_writer_writes_selected_inline_key() {
    let effective = json!({
        "config": "[models]\ndefault = \"proxy\"\n[model.proxy]\nmodel = \"grok-test\"\nbase_url = \"https://grok.test\"\nname = \"Grok\"\n"
    });
    let (bytes, _) = materialize_grok_global_config(None, &effective, "new-secret").unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("api_key = \"new-secret\""));
    assert!(!text.contains("env_key"));
}

#[test]
// 验证相同键值以不同插入顺序构建 BTreeMap 后产生相同聚合指纹。
fn aggregate_fingerprint_is_order_stable() {
    let mut left = BTreeMap::new();
    left.insert("a".to_string(), "1".to_string());
    left.insert("b".to_string(), "2".to_string());
    let mut right = BTreeMap::new();
    right.insert("b".to_string(), "2".to_string());
    right.insert("a".to_string(), "1".to_string());
    assert_eq!(aggregate_fingerprint(&left), aggregate_fingerprint(&right));
}

#[test]
// 验证批量读取帧正确处理缺失文件、非 UTF-8 字节及负载中的换行，不运行 WSL。
fn parses_wsl_batch_reads_with_binary_payloads_and_missing_files() {
    let stdout = b"1 5\nhello\n0 0\n1 4\n\x00\xff\n\n\n";
    assert_eq!(
        parse_wsl_batch_reads(stdout, 3).unwrap(),
        vec![
            Some(b"hello".to_vec()),
            None,
            Some(vec![0, 255, b'\n', b'\n']),
        ]
    );
}

#[test]
// 验证同类型与 Home 的第二次加锁被拒绝，释放首个守卫后可重新获取。
fn apply_lock_serializes_same_home_and_app_type() {
    let first = acquire_apply_lock("claude", "test:recovery-lock").unwrap();
    assert!(matches!(
        acquire_apply_lock("claude", "test:recovery-lock"),
        Err(error) if error == "provider_apply_busy"
    ));
    drop(first);
    assert!(acquire_apply_lock("claude", "test:recovery-lock").is_ok());
}

#[test]
// 验证暂存目标按类型要求 JSON 对象或有效 TOML，拒绝样例非法内容。
fn staged_target_parser_validates_json_and_toml_by_target() {
    let json_target = PlannedTarget {
        target: "codex.auth".to_string(),
        path: String::new(),
        before: None,
        desired: Vec::new(),
        owned_fields: Vec::new(),
    };
    assert!(parse_staged_target(&json_target, br#"{}"#).is_ok());
    assert!(parse_staged_target(&json_target, b"[]").is_err());

    let toml_target = PlannedTarget {
        target: "codex.config".to_string(),
        path: String::new(),
        before: None,
        desired: Vec::new(),
        owned_fields: Vec::new(),
    };
    assert!(parse_staged_target(&toml_target, b"model = \"test\"\n").is_ok());
    assert!(parse_staged_target(&toml_target, b"[").is_err());
}

#[test]
// 验证计划中所有 before 与 desired 相同才判定匹配，增加一个变化目标后判定为不匹配。
fn plan_matches_live_requires_every_target_to_match() {
    let matching = PlannedTarget {
        target: "codex.config".to_string(),
        path: String::new(),
        before: Some(b"model = \"test\"\n".to_vec()),
        desired: b"model = \"test\"\n".to_vec(),
        owned_fields: Vec::new(),
    };
    let changed = PlannedTarget {
        target: "codex.auth".to_string(),
        path: String::new(),
        before: Some(br#"{"old":true}"#.to_vec()),
        desired: br#"{"new":true}"#.to_vec(),
        owned_fields: Vec::new(),
    };
    let mut plan = ProviderPlan {
        app_type: "codex".to_string(),
        provider_id: "provider".to_string(),
        provider_name: "Provider".to_string(),
        source_signature: String::new(),
        home: matching_home(),
        targets: vec![matching],
    };
    assert!(plan_matches_live(&plan));
    plan.targets.push(changed);
    assert!(!plan_matches_live(&plan));
}

// 构造纯内存本机自动 Home，目录字段留空，供不依赖真实路径的计划测试复用。
fn matching_home() -> ProviderHomeState {
    ProviderHomeState {
        identity: HomeIdentity {
            environment_kind: "local".to_string(),
            environment_id: "host".to_string(),
            identity: "local:host".to_string(),
        },
        mode: "auto".to_string(),
        home_path: String::new(),
        source: "auto".to_string(),
        targets: crate::provider::home::DerivedCliTargets {
            home_path: String::new(),
            claude_config_dir: String::new(),
            claude_history_root: String::new(),
            codex_config_dir: String::new(),
            codex_history_root: String::new(),
            grok_config_dir: String::new(),
            grok_history_root: String::new(),
        },
    }
}

#[cfg(windows)]
#[test]
// 在 Windows 验证本机和 WSL UNC 暂存路径位于目标同目录，并符合日志 ID 与索引命名。
fn stage_path_stays_beside_local_and_wsl_targets() {
    let local = stage_path_for_target(r"C:\Users\tester\.codex\config.toml", "journal", 1).unwrap();
    assert_eq!(
        Path::new(&local).parent().unwrap(),
        Path::new(r"C:\Users\tester\.codex")
    );
    assert!(local.ends_with(".config.toml.journal.1.stage"));

    let wsl = stage_path_for_target(
        r"\\wsl.localhost\Ubuntu\home\tester\.codex\config.toml",
        "journal",
        1,
    )
    .unwrap();
    let (distro, linux_path) = wsl::parse_wsl_unc_path(&wsl).unwrap();
    assert_eq!(distro, "Ubuntu");
    assert_eq!(
        linux_path,
        "/home/tester/.codex/.config.toml.journal.1.stage"
    );
}

#[test]
// 在独立临时目录验证暂存文件替换现有目标，成功后暂存路径消失。
fn local_stage_replacement_overwrites_existing_target() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("config.toml");
    let stage = directory.path().join(".config.toml.stage");
    fs::write(&target, b"old").unwrap();
    fs::write(&stage, b"new").unwrap();

    replace_live_from_stage(
        target.to_string_lossy().as_ref(),
        stage.to_string_lossy().as_ref(),
    )
    .unwrap();

    assert_eq!(fs::read(&target).unwrap(), b"new");
    assert!(!stage.exists());
}

#[cfg(target_os = "macos")]
#[test]
// macOS 专用临时文件测试：检查暂存与目标同目录及替换结果，不模拟并发读取验证原子可见性。
fn macos_local_stage_replace_keeps_atomic_same_directory_contract() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("settings.json");
    let stage = directory.path().join(".settings.json.route.stage");
    fs::write(&stage, br#"{"route":"local"}"#).unwrap();

    assert_eq!(stage.parent(), target.parent());
    replace_live_from_stage(
        target.to_string_lossy().as_ref(),
        stage.to_string_lossy().as_ref(),
    )
    .unwrap();

    assert_eq!(fs::read(&target).unwrap(), br#"{"route":"local"}"#);
    assert!(!stage.exists());
}

#[test]
// 在临时目录验证补偿恢复旧目标、移除本次新建目标，并拒绝覆盖随后发生的外部修改。
fn compensation_restores_existing_and_removes_created_targets() {
    let directory = tempfile::tempdir().unwrap();
    let existing_path = directory.path().join("existing.json");
    let created_path = directory.path().join("created.json");
    fs::write(&existing_path, br#"{"old":true}"#).unwrap();
    fs::write(&existing_path, br#"{"new":true}"#).unwrap();
    fs::write(&created_path, br#"{"created":true}"#).unwrap();

    let plan = ProviderPlan {
        app_type: "codex".to_string(),
        provider_id: "provider".to_string(),
        provider_name: "Provider".to_string(),
        source_signature: String::new(),
        home: ProviderHomeState {
            identity: HomeIdentity {
                environment_kind: "local".to_string(),
                environment_id: "host".to_string(),
                identity: "local:host".to_string(),
            },
            mode: "auto".to_string(),
            home_path: directory.path().to_string_lossy().into_owned(),
            source: "auto".to_string(),
            targets: crate::provider::home::DerivedCliTargets {
                home_path: directory.path().to_string_lossy().into_owned(),
                claude_config_dir: directory
                    .path()
                    .join(".claude")
                    .to_string_lossy()
                    .into_owned(),
                claude_history_root: directory
                    .path()
                    .join(".claude")
                    .join("projects")
                    .to_string_lossy()
                    .into_owned(),
                codex_config_dir: directory
                    .path()
                    .join(".codex")
                    .to_string_lossy()
                    .into_owned(),
                codex_history_root: directory
                    .path()
                    .join(".codex")
                    .join("sessions")
                    .to_string_lossy()
                    .into_owned(),
                grok_config_dir: directory
                    .path()
                    .join(".grok")
                    .to_string_lossy()
                    .into_owned(),
                grok_history_root: directory
                    .path()
                    .join(".grok")
                    .join("sessions")
                    .to_string_lossy()
                    .into_owned(),
            },
        },
        targets: vec![
            PlannedTarget {
                target: "codex.auth".to_string(),
                path: existing_path.to_string_lossy().into_owned(),
                before: Some(br#"{"old":true}"#.to_vec()),
                desired: br#"{"new":true}"#.to_vec(),
                owned_fields: Vec::new(),
            },
            PlannedTarget {
                target: "codex.config".to_string(),
                path: created_path.to_string_lossy().into_owned(),
                before: None,
                desired: br#"{"created":true}"#.to_vec(),
                owned_fields: Vec::new(),
            },
        ],
    };

    restore_targets(
        &plan,
        &[
            existing_path.to_string_lossy().into_owned(),
            created_path.to_string_lossy().into_owned(),
        ],
    )
    .unwrap();

    assert_eq!(fs::read(&existing_path).unwrap(), br#"{"old":true}"#);
    assert!(!created_path.exists());

    fs::write(&existing_path, br#"{"external":true}"#).unwrap();
    assert_eq!(
        restore_targets(&plan, &[existing_path.to_string_lossy().into_owned()]),
        Err("provider_recovery_required".to_string())
    );
    assert_eq!(fs::read(&existing_path).unwrap(), br#"{"external":true}"#);
}

#[test]
// 在临时文件设置只读属性，验证可写检查返回 false，再恢复属性以便清理。
fn existing_readonly_file_is_not_writable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    fs::write(&path, b"{}").unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).unwrap();

    assert!(!target_writable(path.to_string_lossy().as_ref()));

    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(false);
    fs::set_permissions(&path, permissions).unwrap();
}

#[test]
// 在临时目录验证备份清理移除备份文件及清空后的日志目录。
fn cleanup_backup_files_removes_stale_stage_failure_backups_and_directory() {
    let directory = tempfile::tempdir().unwrap();
    let backup_directory = directory.path().join("journal");
    fs::create_dir(&backup_directory).unwrap();
    let backup = backup_directory.join("target.backup");
    fs::write(&backup, b"secret").unwrap();
    let targets = vec![JournalTarget {
        target: "target".to_string(),
        backup_path: Some(backup.to_string_lossy().into_owned()),
        stage_path: "stage".to_string(),
        existed: true,
    }];

    cleanup_backup_files(&targets);

    assert!(!backup.exists());
    assert!(!backup_directory.exists());
}

#[test]
// 验证备份路径清理保留普通、外部和越界目标；本测试会在临时根的父目录写固定 escaped.backup，运行需隔离该父目录。
fn cleanup_persisted_backup_paths_stays_inside_provider_backup_root() {
    let directory = tempfile::tempdir().unwrap();
    let outside_directory = tempfile::tempdir().unwrap();
    let backup_directory = directory.path().join("journal");
    fs::create_dir(&backup_directory).unwrap();
    let backup = backup_directory.join("target.backup");
    fs::write(&backup, b"secret").unwrap();
    let rogue = directory.path().join("rogue.txt");
    fs::write(&rogue, b"keep").unwrap();
    let outside = outside_directory.path().join("outside.txt");
    fs::write(&outside, b"keep").unwrap();
    let escaped = directory
        .path()
        .join("journal")
        .join("..")
        .join("..")
        .join("escaped.backup");
    let escaped_target = directory.path().parent().unwrap().join("escaped.backup");
    fs::write(&escaped_target, b"keep").unwrap();

    cleanup_backup_paths(
        &[
            backup.to_string_lossy().into_owned(),
            rogue.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            escaped.to_string_lossy().into_owned(),
        ],
        Some(directory.path()),
    );

    assert!(!backup.exists());
    assert!(!backup_directory.exists());
    assert!(rogue.exists());
    assert!(outside.exists());
    assert!(escaped_target.exists());
}
