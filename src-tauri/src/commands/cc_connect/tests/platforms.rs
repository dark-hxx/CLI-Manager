use super::*;

#[test]
fn legacy_platform_state_is_copied_to_the_control_identity() {
    let root = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let control = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.project_id = "legacy-project".to_string();
    profile.project_name = "Legacy".to_string();

    let source_session = handoff_session::cc_session_store_path(
        root.path(),
        &profile.project_name,
        &profile.project_path,
    )
    .unwrap();
    fs::create_dir_all(source_session.parent().unwrap()).unwrap();
    fs::write(&source_session, br#"{"active":"s1","sessions":{}}"#).unwrap();
    let source_weixin =
        weixin_account_dir_at(root.path(), &profile.project_name, &profile.project_id);
    fs::create_dir_all(&source_weixin).unwrap();
    fs::write(
        source_weixin.join("context_tokens.json"),
        br#"{"user":"token"}"#,
    )
    .unwrap();
    fs::write(source_weixin.join("get_updates.buf"), b"cursor").unwrap();

    migrate_legacy_profile_state_at(&profile, control.path(), root.path()).unwrap();

    let target_session = handoff_session::cc_session_store_path(
        root.path(),
        CONTROL_PROJECT_NAME,
        &user_path_string(control.path()),
    )
    .unwrap();
    assert_eq!(
        fs::read(target_session).unwrap(),
        br#"{"active":"s1","sessions":{}}"#
    );
    let target_weixin =
        weixin_account_dir_at(root.path(), CONTROL_PROJECT_NAME, CONTROL_PROJECT_ID);
    assert_eq!(
        fs::read(target_weixin.join("context_tokens.json")).unwrap(),
        br#"{"user":"token"}"#
    );
    assert_eq!(
        fs::read(target_weixin.join("get_updates.buf")).unwrap(),
        b"cursor"
    );
}

#[test]
fn allowlist_is_fail_closed_and_normalized() {
    assert_eq!(
        normalize_allow_from(
            CcConnectPlatform::Telegram,
            "123456789, 987654321,123456789"
        )
        .unwrap(),
        "123456789,987654321"
    );
    assert!(normalize_allow_from(CcConnectPlatform::Telegram, "*").is_err());
    assert!(normalize_allow_from(CcConnectPlatform::Telegram, "alice").is_err());
    assert_eq!(
        normalize_allow_from(CcConnectPlatform::Feishu, "ou_owner").unwrap(),
        "ou_owner"
    );
    assert_eq!(
        normalize_allow_from(CcConnectPlatform::Weixin, "owner@im.wechat").unwrap(),
        "owner@im.wechat"
    );
    assert!(normalize_allow_from(CcConnectPlatform::Weixin, "owner").is_err());
    assert_eq!(
        normalize_allow_from(CcConnectPlatform::Wecom, "zhangsan, lisi").unwrap(),
        "zhangsan,lisi"
    );
    assert!(normalize_allow_from(CcConnectPlatform::Wecom, "*").is_err());
}

#[test]
fn legacy_profile_migrates_to_a_single_enabled_platform() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());

    hydrate_profile_platforms(&mut profile);

    assert_eq!(profile.platforms.len(), CC_CONNECT_PLATFORMS.len());
    assert_eq!(
        enabled_platforms(&profile),
        vec![CcConnectPlatformProfile {
            platform: CcConnectPlatform::Telegram,
            enabled: true,
            allow_from: "123456789".to_string(),
        }]
    );
    assert_eq!(profile.allow_from, "123456789");
}

#[test]
fn weixin_authorization_ignores_incomplete_unrelated_platform_drafts() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.platform = CcConnectPlatform::Weixin;
    profile.allow_from = "legacy-invalid-id".to_string();
    profile.platforms = vec![
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Telegram,
            enabled: true,
            allow_from: String::new(),
        },
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Feishu,
            enabled: true,
            allow_from: "ou_owner".to_string(),
        },
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Weixin,
            enabled: true,
            allow_from: "legacy-invalid-id".to_string(),
        },
    ];

    let existing = prepare_weixin_authorization_platforms(&mut profile).unwrap();

    assert!(existing.is_empty());
    let telegram = platform_profile(&profile, CcConnectPlatform::Telegram).unwrap();
    assert!(!telegram.enabled);
    assert!(telegram.allow_from.is_empty());
    let feishu = platform_profile(&profile, CcConnectPlatform::Feishu).unwrap();
    assert!(feishu.enabled);
    assert_eq!(feishu.allow_from, "ou_owner");
    let weixin = platform_profile(&profile, CcConnectPlatform::Weixin).unwrap();
    assert!(weixin.enabled);
    assert_eq!(weixin.allow_from, "authorization-pending@im.wechat");
    assert_eq!(profile.allow_from, "authorization-pending@im.wechat");
}

#[test]
fn weixin_authorization_preserves_valid_existing_allowlist() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.platform = CcConnectPlatform::Weixin;
    profile.platforms = vec![
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Telegram,
            enabled: true,
            allow_from: "123456789".to_string(),
        },
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Weixin,
            enabled: true,
            allow_from: "owner@im.wechat".to_string(),
        },
    ];

    let existing = prepare_weixin_authorization_platforms(&mut profile).unwrap();

    assert_eq!(existing, "owner@im.wechat");
    assert!(
        platform_profile(&profile, CcConnectPlatform::Telegram)
            .unwrap()
            .enabled
    );
}

#[test]
fn regular_profile_validation_still_rejects_incomplete_enabled_platforms() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.platform = CcConnectPlatform::Weixin;
    profile.allow_from = "owner@im.wechat".to_string();
    profile.platforms = vec![
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Telegram,
            enabled: true,
            allow_from: String::new(),
        },
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Weixin,
            enabled: true,
            allow_from: "owner@im.wechat".to_string(),
        },
    ];

    let error = normalize_profile(&CcConnectManager::new(), profile).unwrap_err();

    assert_eq!(error, "platform_allow_from_required:telegram");
}

#[test]
fn profile_allowlist_errors_identify_every_platform_and_reason() {
    let invalid_values = [
        (CcConnectPlatform::Telegram, "telegram-name"),
        (CcConnectPlatform::Feishu, "123456789"),
        (CcConnectPlatform::Weixin, "wechat-owner"),
        (CcConnectPlatform::Wecom, "user with spaces"),
    ];

    for platform in CC_CONNECT_PLATFORMS {
        assert_eq!(
            normalize_profile_allow_from(platform, "").unwrap_err(),
            format!("platform_allow_from_required:{}", platform_type(platform))
        );
        assert_eq!(
            normalize_profile_allow_from(platform, "*").unwrap_err(),
            format!("platform_allow_from_wildcard:{}", platform_type(platform))
        );
    }

    for (platform, value) in invalid_values {
        assert_eq!(
            normalize_profile_allow_from(platform, value).unwrap_err(),
            format!("platform_allow_from_invalid:{}", platform_type(platform))
        );
    }
}

#[test]
fn regular_profile_validation_ignores_disabled_platform_drafts() {
    let project = tempfile::tempdir().unwrap();
    let valid_values = [
        (CcConnectPlatform::Telegram, "123456789"),
        (CcConnectPlatform::Feishu, "ou_owner"),
        (CcConnectPlatform::Weixin, "owner@im.wechat"),
        (CcConnectPlatform::Wecom, "zhangsan"),
    ];

    for (selected, valid_value) in valid_values {
        let mut profile = sample_profile(project.path());
        profile.platform = selected;
        profile.platforms = CC_CONNECT_PLATFORMS
            .into_iter()
            .map(|platform| CcConnectPlatformProfile {
                platform,
                enabled: platform == selected,
                allow_from: if platform == selected {
                    valid_value.to_string()
                } else {
                    "unfinished draft".to_string()
                },
            })
            .collect();

        let normalized = normalize_profile(&CcConnectManager::new(), profile).unwrap();

        assert_eq!(enabled_platforms(&normalized).len(), 1);
        assert_eq!(normalized.allow_from, valid_value);
    }
}

#[test]
fn managed_config_keeps_multiple_enabled_platforms_online() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.platforms = vec![
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Telegram,
            enabled: true,
            allow_from: "123456789".to_string(),
        },
        CcConnectPlatformProfile {
            platform: CcConnectPlatform::Weixin,
            enabled: true,
            allow_from: "owner@im.wechat".to_string(),
        },
    ];
    let config = build_managed_config(
        &profile,
        Path::new(r"C:Users	estcli-manager-projects.txt"),
        Path::new(r"C:Users	estcli-manager-switch.ps1"),
    )
    .unwrap();
    let value = toml::from_str::<toml::Value>(&toml::to_string(&config).unwrap()).unwrap();
    let platforms = value["projects"][0]["platforms"].as_array().unwrap();

    assert_eq!(platforms.len(), 2);
    assert_eq!(platforms[0]["type"].as_str(), Some("telegram"));
    assert_eq!(platforms[1]["type"].as_str(), Some("weixin"));
    assert_eq!(
        value["projects"][0]["admin_from"].as_str(),
        Some("123456789,owner@im.wechat")
    );
}

#[test]
fn managed_config_uses_cc_connect_native_weixin_and_wecom_platforms() {
    let project = tempfile::tempdir().unwrap();
    let render = |profile: &CcConnectProfile| {
        let config = build_managed_config(
            profile,
            Path::new(r"C:\Users\test\cli-manager-projects.txt"),
            Path::new(r"C:\Users\test\cli-manager-switch.ps1"),
        )
        .unwrap();
        toml::from_str::<toml::Value>(&toml::to_string(&config).unwrap()).unwrap()
    };

    let mut profile = sample_profile(project.path());
    profile.platform = CcConnectPlatform::Weixin;
    profile.allow_from = "owner@im.wechat".to_string();
    let weixin = render(&profile);
    assert_eq!(
        weixin["projects"][0]["platforms"][0]["type"].as_str(),
        Some("weixin")
    );
    assert_eq!(
        weixin["projects"][0]["platforms"][0]["options"]["token"].as_str(),
        Some("${CLI_MANAGER_CC_WEIXIN_TOKEN}")
    );
    assert_eq!(
        weixin["projects"][0]["platforms"][0]["options"]["account_id"].as_str(),
        Some("project-1")
    );

    profile.platform = CcConnectPlatform::Wecom;
    profile.allow_from = "zhangsan".to_string();
    let wecom = render(&profile);
    let options = &wecom["projects"][0]["platforms"][0]["options"];
    assert_eq!(
        wecom["projects"][0]["platforms"][0]["type"].as_str(),
        Some("wecom")
    );
    assert_eq!(options["mode"].as_str(), Some("websocket"));
    assert_eq!(
        options["bot_id"].as_str(),
        Some("${CLI_MANAGER_CC_WECOM_BOT_ID}")
    );
    assert_eq!(
        options["bot_secret"].as_str(),
        Some("${CLI_MANAGER_CC_WECOM_BOT_SECRET}")
    );
}

#[test]
fn weixin_authorization_config_is_native_and_contains_no_credential() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.platform = CcConnectPlatform::Weixin;
    profile.allow_from = "authorization-pending@im.wechat".to_string();

    let raw = build_weixin_authorization_config(&profile).unwrap();
    let config: toml::Value = toml::from_str(&raw).unwrap();
    let options = &config["projects"][0]["platforms"][0]["options"];
    assert_eq!(
        config["projects"][0]["platforms"][0]["type"].as_str(),
        Some("weixin")
    );
    assert_eq!(options["token"].as_str(), Some(""));
    assert_eq!(options["allow_from"].as_str(), Some(""));
    assert!(!raw.contains(&format!("${{{WEIXIN_TOKEN_ENV}}}")));
}

#[test]
fn weixin_authorization_result_is_parsed_and_allowlist_is_merged() {
    let directory = tempfile::tempdir().unwrap();
    let config_path = directory.path().join("setup.toml");
    fs::write(
        &config_path,
        r#"
[[projects]]
name = "amazon"

[[projects.platforms]]
type = "weixin"

[projects.platforms.options]
token = "test-ilink-token"
allow_from = "owner@im.wechat"
"#,
    )
    .unwrap();

    let result = parse_weixin_authorization_result(&config_path, "amazon").unwrap();
    assert_eq!(result.token, "test-ilink-token");
    assert_eq!(result.allow_from, "owner@im.wechat");
    assert_eq!(
        merge_weixin_allow_from("teammate@im.wechat", &result.allow_from).unwrap(),
        "teammate@im.wechat,owner@im.wechat"
    );

    fs::write(
        &config_path,
        r#"
[[projects]]
name = "amazon"
[[projects.platforms]]
type = "weixin"
[projects.platforms.options]
token = "must-not-leak"
allow_from = ""
"#,
    )
    .unwrap();
    let error = parse_weixin_authorization_result(&config_path, "amazon").unwrap_err();
    assert_eq!(error, "Weixin authorization user ID is missing");
    assert!(!error.contains("must-not-leak"));
}
