use super::{
    add_exact_hooks, apply_transaction, feature_marker, fingerprint, grok_compat_isolated,
    hook_command, inspect_json, install_codex_feature, install_grok_compat_isolation,
    parse_owned_marker, parse_toml, recover_transaction, remove_exact_hooks, transaction_dir,
    uninstall_codex_feature, uninstall_grok_compat_isolation, FileState, PlannedFile, Source,
    TransactionFile, TransactionJournal,
};
#[cfg(unix)]
use super::{
    config_target_unchanged, exact_commands, installation_record, plan_files,
    supports_current_kimi, validate_kimi_candidate, ResolvedRoot,
};
use crate::installer::InstallationRecord;
use crate::layout::AgentLayout;
use serde_json::json;
use std::collections::HashMap;
use std::fs;

fn installation_record_for_test(path: &std::path::Path) -> InstallationRecord {
    InstallationRecord {
        schema_version: 1,
        installation_id: "00000000-0000-4000-8000-000000000001".to_string(),
        remote_machine_id: "machine".to_string(),
        agent_version: "0.1.9".to_string(),
        protocol_version: "1.11".to_string(),
        target: "linux-x86_64".to_string(),
        install_root: path.parent().unwrap().to_path_buf(),
        install_path: path.to_path_buf(),
        source: "test".to_string(),
        manifest_url: String::new(),
        artifact_sha256: "a".repeat(64),
        installed_at: 1,
        previous_version: String::new(),
    }
}

#[test]
fn kimi_source_uses_native_root_and_exact_owner_token() {
    let installation = installation_record_for_test(std::path::Path::new(
        "/opt/cli-manager/cli-manager-ssh-agent",
    ));
    assert_eq!(Source::Kimi.default_dir(), ".kimi-code");
    assert_eq!(Source::Kimi.required_entries(), 9);
    assert_eq!(
        hook_command(&installation, Source::Kimi, "PermissionResult"),
        "'/opt/cli-manager/cli-manager-ssh-agent' hook --source kimi --event PermissionResult --owner cli-manager-ssh-agent:00000000-0000-4000-8000-000000000001 --managed-by cli-manager-ssh-agent --installation-id 00000000-0000-4000-8000-000000000001"
    );
}

#[cfg(unix)]
#[test]
fn kimi_plan_uses_single_config_role_and_omits_history_candidate() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join(".kimi-code");
    fs::create_dir_all(&root_path).unwrap();
    fs::write(
        root_path.join("config.toml"),
        "# keep\nmodel = \"kimi-k2\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"third-party\"\n",
    )
    .unwrap();
    let canonical = fs::canonicalize(&root_path).unwrap();
    let root = ResolvedRoot {
        configured: "~/.kimi-code".to_string(),
        requested: root_path,
        canonical,
        hash: "a".repeat(64),
        existed: true,
    };
    let installation = installation_record_for_test(std::path::Path::new(
        "/opt/cli-manager/cli-manager-ssh-agent",
    ));

    let (plans, managed, conflict) =
        plan_files(&root, Source::Kimi, &installation, Some(true)).unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].before.role, "kimiConfig");
    assert_eq!(managed, 9);
    assert!(!conflict);
    let content = String::from_utf8(plans[0].after.clone()).unwrap();
    assert!(content.contains("# keep"));
    assert!(content.contains("third-party"));
    assert_eq!(content.matches("--source kimi").count(), 9);

    let record = installation_record(Source::Kimi, &root, &installation, &plans);
    assert!(record.history_source_candidate.is_none());
}

#[test]
fn grok_source_uses_native_root_and_permission_request_command() {
    let installation = installation_record_for_test(std::path::Path::new(
        "/opt/cli-manager/cli-manager-ssh-agent",
    ));
    assert_eq!(Source::Grok.default_dir(), ".grok");
    assert_eq!(Source::Grok.required_entries(), 11);
    assert_eq!(
        hook_command(&installation, Source::Grok, "PermissionRequest"),
        "'/opt/cli-manager/cli-manager-ssh-agent' hook --source grok --event PermissionRequest --managed-by cli-manager-ssh-agent --installation-id 00000000-0000-4000-8000-000000000001"
    );
}

fn grok_compat_doc(text: &str) -> toml_edit::DocumentMut {
    parse_toml(&FileState {
        role: "grokCompat",
        logical_path: "config.toml".into(),
        canonical_path: "config.toml".into(),
        bytes: text.as_bytes().to_vec(),
        exists: true,
        mode: None,
    })
    .expect("grok compat toml")
}

#[test]
fn grok_compat_isolated_reads_nested_and_dotted_tables() {
    assert!(!grok_compat_isolated(&grok_compat_doc(
        "[compat.claude]\nskills = true\n"
    )));
    assert!(grok_compat_isolated(&grok_compat_doc(
        "[compat.claude]\nhooks = false\n[compat.cursor]\nhooks = false\n"
    )));
    assert!(grok_compat_isolated(&grok_compat_doc(
        "compat.claude.hooks = false\ncompat.cursor.hooks = false\n"
    )));
    assert!(grok_compat_isolated(&grok_compat_doc(
        "[compat]\nclaude.hooks = false\ncursor.hooks = false\n"
    )));
    assert!(!grok_compat_isolated(&grok_compat_doc(
        "[compat.claude]\nhooks = false\n[compat.cursor]\nhooks = true\n"
    )));
}

#[test]
fn grok_compat_uninstall_restores_owned_values_and_preserves_user_values() {
    let mut document = grok_compat_doc(
        "# keep\n[compat.claude]\nhooks = true # claude user comment\nskills = true\n[compat.cursor]\nhooks = false # cursor user choice\n",
    );

    install_grok_compat_isolation(&mut document, "installation-1").unwrap();
    let installed = document.to_string();
    assert!(grok_compat_isolated(&document));
    assert!(installed.contains("hooks = false # claude user comment # cli-manager-ssh-agent"));
    assert!(installed.contains("hooks = false # cursor user choice"));
    assert_eq!(installed.matches("cli-manager-ssh-agent").count(), 1);

    uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();
    let restored = document.to_string();
    assert!(restored.contains("hooks = true # claude user comment"));
    assert!(restored.contains("hooks = false # cursor user choice"));
    assert!(!restored.contains("cli-manager-ssh-agent"));
    assert!(restored.contains("skills = true"));
}

#[test]
fn grok_compat_uninstall_removes_only_agent_created_tables() {
    let mut document = grok_compat_doc("# keep\n[other]\nvalue = true\n");

    install_grok_compat_isolation(&mut document, "installation-1").unwrap();
    assert!(grok_compat_isolated(&document));
    assert!(document.contains_key("compat"));

    uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();
    assert!(!document.contains_key("compat"));
    let restored = document.to_string();
    assert!(restored.contains("# keep"));
    assert!(restored.contains("[other]"));
    assert!(restored.contains("value = true"));
}

#[test]
fn grok_compat_uninstall_respects_other_installations_and_user_changes() {
    let mut document =
        grok_compat_doc("[compat.claude]\nhooks = true\n[compat.cursor]\nhooks = true\n");
    install_grok_compat_isolation(&mut document, "installation-1").unwrap();

    uninstall_grok_compat_isolation(&mut document, "installation-2").unwrap();
    assert!(grok_compat_isolated(&document));
    assert!(document.to_string().contains("installation=installation-1"));

    document["compat"]["claude"]["hooks"] = toml_edit::value(true);
    uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();
    assert_eq!(document["compat"]["claude"]["hooks"].as_bool(), Some(true));
    assert_eq!(document["compat"]["cursor"]["hooks"].as_bool(), Some(true));
}

#[test]
fn grok_compat_already_isolated_without_marker_remains_unchanged() {
    let original = "[compat.claude]\nhooks = false # user\n[compat.cursor]\nhooks = false # user\n";
    let mut document = grok_compat_doc(original);

    install_grok_compat_isolation(&mut document, "installation-1").unwrap();
    uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();

    assert_eq!(document.to_string(), original);
}

#[test]
fn grok_compat_uninstall_ignores_incomplete_markers() {
    let original =
        "[compat.claude]\nhooks = false # cli-manager-ssh-agent installation=installation-1\n";
    let mut document = grok_compat_doc(original);

    uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();

    assert_eq!(document.to_string(), original);
}

#[test]
fn grok_compat_install_and_uninstall_preserve_supported_dotted_forms() {
    for original in [
        "compat.claude.hooks = true\ncompat.cursor.hooks = true\n",
        "[compat]\nclaude.hooks = true\ncursor.hooks = true\n",
    ] {
        let mut document = grok_compat_doc(original);
        install_grok_compat_isolation(&mut document, "installation-1").unwrap();
        assert!(grok_compat_isolated(&document));

        uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();
        assert!(!grok_compat_isolated(&document));
        assert_eq!(document["compat"]["claude"]["hooks"].as_bool(), Some(true));
        assert_eq!(document["compat"]["cursor"]["hooks"].as_bool(), Some(true));
        assert!(!document.to_string().contains("cli-manager-ssh-agent"));
    }
}

#[cfg(unix)]
#[test]
fn grok_plan_writes_hooks_json_and_compat_and_omits_history_candidate() {
    let temp = tempfile::tempdir().unwrap();
    let root_path = temp.path().join(".grok");
    fs::create_dir_all(root_path.join("hooks")).unwrap();
    fs::write(
        root_path.join("hooks").join("cli-manager.json"),
        "{\n  \"keep\": true\n}\n",
    )
    .unwrap();
    fs::write(
        root_path.join("config.toml"),
        "# keep\n[compat.claude]\nhooks = true\nskills = true\n",
    )
    .unwrap();
    let canonical = fs::canonicalize(&root_path).unwrap();
    let root = ResolvedRoot {
        configured: "~/.grok".to_string(),
        requested: root_path.clone(),
        canonical,
        hash: "a".repeat(64),
        existed: true,
    };
    let installation = installation_record_for_test(std::path::Path::new(
        "/opt/cli-manager/cli-manager-ssh-agent",
    ));

    let (plans, _, conflict) = plan_files(&root, Source::Grok, &installation, Some(true)).unwrap();
    assert_eq!(plans.len(), 2);
    assert_eq!(plans[0].before.role, "grokHooks");
    assert_eq!(plans[1].before.role, "grokCompat");
    assert!(!conflict);
    let hooks = String::from_utf8(plans[0].after.clone()).unwrap();
    assert!(hooks.contains("\"keep\": true"));
    assert_eq!(hooks.matches("--source grok").count(), 11);
    assert!(hooks.contains("PermissionRequest"));
    let after_json = serde_json::from_slice(&plans[0].after).unwrap();
    let expected = exact_commands(&installation, Source::Grok);
    let (managed, after_conflict, _) = inspect_json(&after_json, Source::Grok, &expected).unwrap();
    assert_eq!(managed, 11);
    assert!(!after_conflict);
    let config = String::from_utf8(plans[1].after.clone()).unwrap();
    assert!(config.contains("# keep"));
    assert!(config.contains("skills = true"));
    assert!(config.contains("hooks = false"));

    let record = installation_record(Source::Grok, &root, &installation, &plans);
    assert!(record.history_source_candidate.is_none());

    let inspect_plans = plan_files(&root, Source::Grok, &installation, None)
        .unwrap()
        .0;
    assert!(!grok_compat_isolated(
        &parse_toml(&inspect_plans[1].before).unwrap()
    ));
    let after_toml = parse_toml(&FileState {
        role: "grokCompat",
        logical_path: inspect_plans[1].before.logical_path.clone(),
        canonical_path: inspect_plans[1].before.canonical_path.clone(),
        bytes: plans[1].after.clone(),
        exists: true,
        mode: None,
    })
    .unwrap();
    assert!(grok_compat_isolated(&after_toml));

    fs::write(root_path.join("config.toml"), &plans[1].after).unwrap();
    let uninstall_plans = plan_files(&root, Source::Grok, &installation, Some(false))
        .unwrap()
        .0;
    let restored = String::from_utf8(uninstall_plans[1].after.clone()).unwrap();
    assert!(restored.contains("hooks = true"));
    assert!(restored.contains("skills = true"));
    assert!(!restored.contains("cli-manager-ssh-agent"));
}

#[cfg(unix)]
#[test]
fn kimi_candidate_failure_leaves_live_config_untouched() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config.toml");
    fs::write(&config, "model = \"kimi-k2\"\n").unwrap();
    let doctor = temp.path().join("kimi");
    fs::write(&doctor, "#!/bin/sh\nexit 2\n").unwrap();
    fs::set_permissions(&doctor, fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(
        validate_kimi_candidate(&doctor, &config, b"model = \"other\"\n").unwrap_err(),
        "hook_config_doctor_failed"
    );
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "model = \"kimi-k2\"\n"
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
}

#[cfg(unix)]
#[test]
fn kimi_capability_rejects_legacy_cli_and_accepts_current_cli() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let current = temp.path().join("current-kimi");
    fs::write(&current, "#!/bin/sh\n[ \"$1\" = doctor ]\n").unwrap();
    fs::set_permissions(&current, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(supports_current_kimi(&current));

    let legacy = temp.path().join("legacy-kimi");
    fs::write(&legacy, "#!/bin/sh\nexit 2\n").unwrap();
    fs::set_permissions(&legacy, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!supports_current_kimi(&legacy));
}

#[test]
fn exact_owner_merge_preserves_third_party_entries() {
    let mut value = json!({
        "permissions": { "allow": ["Read"] },
        "hooks": {
            "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "third-party" }] }]
        }
    });
    let expected = HashMap::from([
        ("SessionStart", "agent SessionStart".to_string()),
        ("UserPromptSubmit", "agent UserPromptSubmit".to_string()),
        ("Notification", "agent Notification".to_string()),
        ("Stop", "agent Stop".to_string()),
        ("StopFailure", "agent StopFailure".to_string()),
        ("SubagentStart", "agent SubagentStart".to_string()),
        ("SubagentStop", "agent SubagentStop".to_string()),
        ("AgentToolStart", "agent AgentToolStart".to_string()),
        ("AgentToolStop", "agent AgentToolStop".to_string()),
        ("ToolStart", "agent ToolStart".to_string()),
        ("ToolStop", "agent ToolStop".to_string()),
    ]);
    add_exact_hooks(&mut value, Source::Claude, &expected).unwrap();
    assert_eq!(
        inspect_json(&value, Source::Claude, &expected).unwrap().0,
        12
    );
    remove_exact_hooks(&mut value, Source::Claude, &expected).unwrap();
    assert_eq!(
        value["hooks"]["Stop"][0]["hooks"][0]["command"],
        "third-party"
    );
    assert_eq!(value["permissions"]["allow"][0], "Read");
}

#[test]
fn marker_only_matches_same_installation() {
    let marker = feature_marker("installation-1", "false", false);
    assert_eq!(
        parse_owned_marker(&marker, "installation-1"),
        Some(("false".to_string(), false, " ".to_string()))
    );
    assert_eq!(parse_owned_marker(&marker, "installation-2"), None);
}

#[test]
fn duplicate_exact_entries_are_outdated_but_removable() {
    let mut value = json!({});
    let expected = HashMap::from([
        ("SessionStart", "agent SessionStart".to_string()),
        ("UserPromptSubmit", "agent UserPromptSubmit".to_string()),
        ("Notification", "agent Notification".to_string()),
        ("PermissionRequest", "agent PermissionRequest".to_string()),
        ("Stop", "agent Stop".to_string()),
        ("SubagentStart", "agent SubagentStart".to_string()),
        ("SubagentStop", "agent SubagentStop".to_string()),
    ]);
    add_exact_hooks(&mut value, Source::Codex, &expected).unwrap();
    let duplicate = value["hooks"]["Stop"][0].clone();
    value["hooks"]["Stop"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let (managed, conflict, outdated) = inspect_json(&value, Source::Codex, &expected).unwrap();
    assert_eq!(managed, 7);
    assert!(!conflict);
    assert!(outdated);
    add_exact_hooks(&mut value, Source::Codex, &expected).unwrap();
    let (managed, conflict, outdated) = inspect_json(&value, Source::Codex, &expected).unwrap();
    assert_eq!(managed, 7);
    assert!(!conflict);
    assert!(!outdated);
    remove_exact_hooks(&mut value, Source::Codex, &expected).unwrap();
    assert!(value.get("hooks").is_none());
}

#[test]
fn codex_feature_uninstall_restores_only_owned_changes() {
    let mut disabled = "[features]\nhooks = false # keep this\n".parse().unwrap();
    install_codex_feature(&mut disabled, "installation-1").unwrap();
    assert!(disabled.to_string().contains("cli-manager-ssh-agent"));
    uninstall_codex_feature(&mut disabled, "installation-1").unwrap();
    assert!(disabled.to_string().contains("hooks = false # keep this"));

    let mut user_enabled = "[features]\nhooks = true # user\n".parse().unwrap();
    install_codex_feature(&mut user_enabled, "installation-1").unwrap();
    uninstall_codex_feature(&mut user_enabled, "installation-1").unwrap();
    assert!(user_enabled.to_string().contains("hooks = true # user"));
}

fn test_layout(root: &std::path::Path) -> AgentLayout {
    let state_dir = root.join("state");
    AgentLayout {
        home: root.join("home"),
        data_dir: root.join("data"),
        runtime_dir: root.join("run"),
        installation_record: state_dir.join("installation.json"),
        state_dir,
    }
}

#[cfg(unix)]
fn write_hook_record(
    layout: &AgentLayout,
    source: Source,
    configured: &std::path::Path,
    canonical: &std::path::Path,
) {
    let hash = super::config_root_hash(canonical);
    let records = layout.state_dir.join("hooks/installations");
    fs::create_dir_all(&records).unwrap();
    fs::write(
        records.join(format!("{}-{hash}.json", source.as_str())),
        serde_json::to_vec(&json!({
            "source": source.as_str(),
            "installationId": "00000000-0000-4000-8000-000000000001",
            "ownerId": "cli-manager-ssh-agent:00000000-0000-4000-8000-000000000001",
            "configuredConfigRoot": configured.to_string_lossy(),
            "canonicalConfigRoot": canonical.to_string_lossy(),
            "configFiles": [],
            "managedEntries": source.required_entries(),
            "adapterVersion": 1,
            "installedAt": 1,
            "historySourceCandidate": matches!(source, Source::Claude | Source::Codex).then(|| json!({
                "source": source.as_str(),
                "canonicalConfigRoot": canonical.to_string_lossy(),
                "configRootHash": hash,
            }))
        }))
        .unwrap(),
    )
    .unwrap();
}

fn test_plan(path: &std::path::Path, before: &[u8], after: &[u8]) -> PlannedFile {
    PlannedFile {
        before: FileState {
            role: "test",
            logical_path: path.to_path_buf(),
            canonical_path: fs::canonicalize(path).unwrap(),
            bytes: before.to_vec(),
            exists: true,
            mode: None,
        },
        after: after.to_vec(),
        after_exists: true,
    }
}

#[test]
fn transaction_rejects_external_change_without_overwrite() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    fs::write(&path, b"before").unwrap();
    let plan = test_plan(&path, b"before", b"after");
    fs::write(&path, b"external").unwrap();
    assert_eq!(
        apply_transaction(&test_layout(temp.path()), "root", &[plan]).unwrap_err(),
        "hook_config_changed"
    );
    assert_eq!(fs::read(&path).unwrap(), b"external");
}

#[test]
fn transaction_preflights_all_targets_before_first_write() {
    let temp = tempfile::tempdir().unwrap();
    let first = temp.path().join("first.json");
    let second = temp.path().join("second.json");
    let replacement = temp.path().join("replacement.json");
    fs::write(&first, b"first-before").unwrap();
    fs::write(&second, b"second-before").unwrap();
    fs::write(&replacement, b"replacement").unwrap();
    let first_plan = test_plan(&first, b"first-before", b"first-after");
    let mut second_plan = test_plan(&second, b"second-before", b"second-after");
    second_plan.before.logical_path = replacement;
    assert_eq!(
        apply_transaction(
            &test_layout(temp.path()),
            "root",
            &[first_plan, second_plan]
        )
        .unwrap_err(),
        "hook_config_root_changed"
    );
    assert_eq!(fs::read(&first).unwrap(), b"first-before");
    assert_eq!(fs::read(&second).unwrap(), b"second-before");
}

#[test]
fn recovery_restores_safe_files_and_preserves_external_conflict() {
    let temp = tempfile::tempdir().unwrap();
    let layout = test_layout(temp.path());
    let first = temp.path().join("first.json");
    let second = temp.path().join("second.json");
    fs::write(&first, b"first-after").unwrap();
    fs::write(&second, b"external").unwrap();
    let directory = transaction_dir(&layout, "root");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("0.before"), b"first-before").unwrap();
    fs::write(directory.join("1.before"), b"second-before").unwrap();
    fs::write(
        directory.join("journal.json"),
        serde_json::to_vec(&TransactionJournal {
            files: vec![
                TransactionFile {
                    role: "first".to_string(),
                    canonical_path: fs::canonicalize(&first)
                        .unwrap()
                        .to_string_lossy()
                        .to_string(),
                    existed: true,
                    before_fingerprint: fingerprint(Some(b"first-before")),
                    after_fingerprint: fingerprint(Some(b"first-after")),
                    mode: None,
                    backup_name: "0.before".to_string(),
                },
                TransactionFile {
                    role: "second".to_string(),
                    canonical_path: fs::canonicalize(&second)
                        .unwrap()
                        .to_string_lossy()
                        .to_string(),
                    existed: true,
                    before_fingerprint: fingerprint(Some(b"second-before")),
                    after_fingerprint: fingerprint(Some(b"second-after")),
                    mode: None,
                    backup_name: "1.before".to_string(),
                },
            ],
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        recover_transaction(&layout, "root").unwrap_err(),
        "hook_config_recovery_conflict"
    );
    assert_eq!(fs::read(&first).unwrap(), b"first-before");
    assert_eq!(fs::read(&second).unwrap(), b"external");
}

#[cfg(unix)]
#[test]
fn config_symlink_resolves_to_the_real_target() {
    use super::{resolve_config_file, ResolvedRoot};
    use std::fs;
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    fs::create_dir_all(&root).unwrap();
    let target = temp.path().join("settings-target.json");
    fs::write(&target, b"{}\n").unwrap();
    symlink(&target, root.join("settings.json")).unwrap();
    let resolved = ResolvedRoot {
        configured: root.to_string_lossy().to_string(),
        requested: root.clone(),
        canonical: fs::canonicalize(&root).unwrap(),
        hash: "hash".to_string(),
        existed: true,
    };
    let state = resolve_config_file(&resolved, "claudeSettings", "settings.json").unwrap();
    assert_eq!(state.canonical_path, fs::canonicalize(target).unwrap());
}

#[test]
fn unrelated_hook_event_shapes_are_preserved() {
    let value = json!({
        "hooks": {
            "FutureEvent": { "schema": 2 },
            "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "third-party" }] }]
        }
    });
    let expected = Source::Claude
        .hooks()
        .iter()
        .map(|(_, command_event, _)| (*command_event, format!("agent {command_event}")))
        .collect();
    assert_eq!(
        inspect_json(&value, Source::Claude, &expected).unwrap(),
        (0, false, false)
    );
    assert_eq!(value["hooks"]["FutureEvent"]["schema"], 2);
}

#[cfg(unix)]
#[test]
fn config_symlink_target_change_is_rejected() {
    use super::{resolve_config_file, ResolvedRoot};
    use std::fs;
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    fs::create_dir_all(&root).unwrap();
    let first = temp.path().join("first.json");
    let second = temp.path().join("second.json");
    fs::write(&first, b"{}\n").unwrap();
    fs::write(&second, b"{}\n").unwrap();
    let logical = root.join("settings.json");
    symlink(&first, &logical).unwrap();
    let resolved = ResolvedRoot {
        configured: root.to_string_lossy().to_string(),
        requested: root.clone(),
        canonical: fs::canonicalize(&root).unwrap(),
        hash: "hash".to_string(),
        existed: true,
    };
    let state = resolve_config_file(&resolved, "claudeSettings", "settings.json").unwrap();
    fs::remove_file(&logical).unwrap();
    symlink(&second, &logical).unwrap();
    assert_eq!(
        config_target_unchanged(&state).unwrap_err(),
        "hook_config_root_changed"
    );
}

#[cfg(unix)]
#[test]
fn config_root_symlink_target_change_before_planning_is_rejected() {
    use super::{resolve_config_file, resolve_root};
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let layout = test_layout(temp.path());
    fs::create_dir_all(&layout.home).unwrap();
    let first = layout.home.join("claude-a");
    let second = layout.home.join("claude-b");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let configured = layout.home.join("claude-current");
    symlink(&first, &configured).unwrap();
    let resolved = resolve_root(
        configured.to_string_lossy().as_ref(),
        Source::Claude,
        &layout,
        false,
    )
    .unwrap();

    fs::remove_file(&configured).unwrap();
    symlink(&second, &configured).unwrap();
    assert_eq!(
        resolve_config_file(&resolved, "claudeSettings", "settings.json").unwrap_err(),
        "hook_config_root_changed"
    );
}

#[cfg(unix)]
#[test]
fn deleted_custom_root_can_be_recovered_for_record_cleanup() {
    use super::resolve_uninstall_root;
    use crate::layout::AgentLayout;
    use std::fs;

    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let custom = home.join("custom-claude");
    fs::create_dir_all(&custom).unwrap();
    let canonical = fs::canonicalize(&custom).unwrap();
    fs::remove_dir(&custom).unwrap();
    let state_dir = temp.path().join("state");
    let layout = AgentLayout {
        home: home.clone(),
        data_dir: temp.path().join("data"),
        state_dir: state_dir.clone(),
        runtime_dir: temp.path().join("run"),
        installation_record: state_dir.join("installation.json"),
    };
    write_hook_record(&layout, Source::Claude, &custom, &canonical);
    let recovered = resolve_uninstall_root(
        custom.to_string_lossy().as_ref(),
        None,
        Source::Claude,
        &layout,
    )
    .unwrap();
    assert!(!recovered.existed);
    assert_eq!(recovered.canonical, canonical);
}

#[cfg(unix)]
#[test]
fn retained_uninstall_uses_recorded_root_after_symlink_retarget() {
    use super::{resolve_config_file, resolve_uninstall_root};
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let layout = test_layout(temp.path());
    fs::create_dir_all(&layout.home).unwrap();
    let first = layout.home.join("claude-a");
    let second = layout.home.join("claude-b");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let first = fs::canonicalize(first).unwrap();
    let second = fs::canonicalize(second).unwrap();
    let configured = layout.home.join("claude-current");
    symlink(&first, &configured).unwrap();
    write_hook_record(&layout, Source::Claude, &configured, &first);

    fs::remove_file(&configured).unwrap();
    symlink(&second, &configured).unwrap();

    let current = resolve_uninstall_root(
        configured.to_string_lossy().as_ref(),
        None,
        Source::Claude,
        &layout,
    )
    .unwrap();
    assert_eq!(current.canonical, second);
    assert_eq!(
        resolve_config_file(&current, "claudeSettings", "settings.json")
            .unwrap()
            .canonical_path,
        second.join("settings.json")
    );

    let retained = resolve_uninstall_root(
        configured.to_string_lossy().as_ref(),
        Some(first.to_string_lossy().as_ref()),
        Source::Claude,
        &layout,
    )
    .unwrap();
    assert_eq!(retained.canonical, first);
    assert_eq!(retained.requested, first);
    assert_eq!(
        resolve_config_file(&retained, "claudeSettings", "settings.json")
            .unwrap()
            .canonical_path,
        retained.canonical.join("settings.json")
    );
}
