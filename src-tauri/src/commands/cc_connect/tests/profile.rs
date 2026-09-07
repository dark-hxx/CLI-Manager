use super::*;

#[test]
fn control_profile_detaches_connection_settings_from_project_paths() {
    let control = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let control_path = control.path().canonicalize().unwrap();
    let mut profile = sample_profile(project.path());
    profile.runtime_project_id = Some("  project-2  ".to_string());

    assert!(set_control_profile_values(&mut profile, &control_path));
    assert_eq!(profile.project_id, CONTROL_PROJECT_ID);
    assert_eq!(profile.project_name, CONTROL_PROJECT_NAME);
    assert_eq!(profile.project_path, user_path_string(&control_path));
    assert_eq!(profile.agent, CcConnectAgent::Codex);
    assert_eq!(profile.runtime_project_id.as_deref(), Some("project-2"));
    assert!(!set_control_profile_values(&mut profile, &control_path));
}

#[test]
fn parses_supported_and_unsupported_versions() {
    assert_eq!(
        parse_version("cc-connect v1.4.1 (commit abc)"),
        Some(("1.4.1".to_string(), true))
    );
    assert_eq!(
        parse_version("cc-connect v1.3.9"),
        Some(("1.3.9".to_string(), false))
    );
    assert_eq!(
        parse_version("cc-connect v1.4.2"),
        Some(("1.4.2".to_string(), true))
    );
    assert_eq!(
        parse_version("cc-connect v1.5.0-beta.2 (commit abc)"),
        Some(("1.5.0-beta.2".to_string(), true))
    );
    assert_eq!(
        parse_version("cc-connect v2.0.0"),
        Some(("2.0.0".to_string(), false))
    );
    assert_eq!(
        trusted_binary_version(VERIFIED_V1_4_1_BINARY_SHA256[0]).as_deref(),
        Some("1.4.1")
    );
    assert_eq!(
        trusted_binary_version("0000000000000000000000000000000000000000000000000000000000000000"),
        None
    );
}

#[test]
fn profile_without_yolo_field_defaults_to_safe_mode() {
    let project = tempfile::tempdir().unwrap();
    let mut value = serde_json::to_value(sample_profile(project.path())).unwrap();
    value.as_object_mut().unwrap().remove("yoloEnabled");
    let profile: CcConnectProfile = serde_json::from_value(value).unwrap();
    assert!(!profile.yolo_enabled);
}

#[test]
fn profile_without_max_turn_time_defaults_to_fifteen_minutes() {
    let project = tempfile::tempdir().unwrap();
    let mut value = serde_json::to_value(sample_profile(project.path())).unwrap();
    value.as_object_mut().unwrap().remove("maxTurnTimeMins");

    let profile: CcConnectProfile = serde_json::from_value(value).unwrap();

    assert_eq!(profile.max_turn_time_mins, DEFAULT_MAX_TURN_TIME_MINS);
}

#[test]
fn profile_rejects_turn_time_above_maximum_before_io() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.max_turn_time_mins = MAX_TURN_TIME_MINS + 1;

    let error = normalize_profile(&CcConnectManager::new(), profile).unwrap_err();

    assert_eq!(
        error,
        format!("max_turn_time_mins must be between 0 and {MAX_TURN_TIME_MINS}")
    );
}

#[test]
fn legacy_profile_without_switch_fields_remains_compatible() {
    let project_dir = tempfile::tempdir().unwrap();
    let mut value = serde_json::to_value(sample_profile(project_dir.path())).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("proxyEnabled");
    object.remove("proxyUrl");
    object.remove("loggingEnabled");
    object.remove("platforms");
    let mut profile: CcConnectProfile = serde_json::from_value(value).unwrap();
    assert!(profile.proxy_enabled);
    assert_eq!(profile.proxy_url, None);
    assert!(!profile.logging_enabled);
    hydrate_profile_platforms(&mut profile);
    assert_eq!(enabled_platforms(&profile).len(), 1);
    assert_eq!(
        enabled_platforms(&profile)[0].platform,
        CcConnectPlatform::Telegram
    );
}

#[cfg(target_os = "windows")]
#[test]
fn config_paths_strip_windows_extended_prefixes() {
    assert_eq!(
        user_path_string(Path::new(r"\\?\D:\npm\cc-connect.exe")),
        r"D:\npm\cc-connect.exe"
    );
    assert_eq!(
        normalize_executable_path_value(Some(r"  \\?\D:\npm\cc-connect.exe  ")),
        Some(r"D:\npm\cc-connect.exe".to_string())
    );
    assert_eq!(
        config_path_value(Path::new(r"\\?\F:\test\work")),
        "F:/test/work"
    );
    assert_eq!(
        config_path_value(Path::new(r"\\?\UNC\server\share\repo")),
        "//server/share/repo"
    );
    assert_eq!(
        config_path_value(Path::new(r"F:\test\work")),
        "F:/test/work"
    );
}

#[test]
fn log_redaction_and_cursor_work() {
    assert_eq!(
        redact_log_line("connected with abcdefgh", &["abcdefgh".to_string()]),
        "connected with [REDACTED]"
    );
    assert_eq!(
        redact_log_line("telegram token=abcdefgh", &[]),
        "[sensitive output redacted]"
    );
    let mut logs = CcConnectLogBuffer::default();
    for index in 0..(MAX_LOG_LINES + 5) {
        logs.push("stdout", format!("line-{index}"));
    }
    assert_eq!(logs.lines.len(), MAX_LOG_LINES);
    let first_seq = logs.lines.front().unwrap().seq;
    assert_eq!(logs.page(first_seq, 3).len(), 3);
}
