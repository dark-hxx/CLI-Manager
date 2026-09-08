use super::*;

#[test]
// 验证未选运行项目时清单显示待接管说明。
fn project_list_uses_standby_copy_without_a_runtime_target() {
    let project = tempfile::tempdir().unwrap();
    let profile = sample_profile(project.path());
    let list = render_project_list(
        &profile,
        &[sample_registered_project(
            "project-1",
            "Example",
            project.path(),
        )],
    );
    assert!(list.contains("等待宠物选择托管会话"));
    assert!(!list.contains("[当前]"));
}

#[test]
// 验证项目单行显示、可用性、稳定切换令牌及脚本边界。
fn project_list_and_switch_tokens_are_stable_and_safe() {
    let current = tempfile::tempdir().unwrap();
    let unavailable = current.path().join("missing");
    let mut profile = sample_profile(current.path());
    profile.project_name = "Current\nProject".to_string();
    profile.runtime_project_id = Some("project-1".to_string());
    let projects = vec![
        sample_registered_project("project-1", "Current\nProject", current.path()),
        sample_registered_project("project-2", "Missing", &unavailable),
    ];
    let list = render_project_list(&profile, &projects);
    assert!(list.contains("1. Current Project [当前]"));
    assert!(list.contains("2. Missing [路径不可用]"));
    assert!(list.contains("/cli_manager_switch <序号>"));
    assert!(!list.contains("Current\nProject"));

    let first = project_switch_token("project-1");
    let second = project_switch_token("project-2");
    assert_eq!(first.len(), 32);
    assert_eq!(first, project_switch_token("project-1"));
    assert_ne!(first, second);
    assert!(switch_result_path(&first).is_ok());
    assert!(switch_result_path("../invalid").is_err());
    assert_eq!(powershell_single_quoted("a'b"), "'a''b'");
    let request_id = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        remote_switch_request_from_args(&[
            "cli-manager.exe".to_string(),
            format!("{REMOTE_SWITCH_ARG_PREFIX}{first}:{request_id}"),
        ]),
        Some(RemoteSwitchRequest {
            project_token: first.clone(),
            request_id: request_id.to_string(),
        })
    );
    assert_eq!(
        remote_switch_request_from_args(&[
            "cli-manager.exe".to_string(),
            format!("{REMOTE_SWITCH_ARG_PREFIX}{first}"),
        ]),
        Some(RemoteSwitchRequest {
            project_token: first.clone(),
            request_id: first.clone(),
        })
    );
    assert_eq!(
        remote_switch_request_from_args(&["cli-manager.exe".to_string()]),
        None
    );
    let script = render_project_switch_script(
        &profile,
        &projects,
        Path::new(r"C:\Program Files\CLI-Manager\cli-manager.exe"),
    )
    .unwrap();
    assert!(script.find(&first).unwrap() < script.find(&second).unwrap());
    assert!(script.contains("$args.Count -ne 1"));
    assert!(script.contains("'^[1-9][0-9]*$'"));
    assert!(script.contains("[Guid]::NewGuid().ToString('N')"));
    assert!(!script.contains(&path_string(current.path())));
}

#[test]
// 验证分组清单通过 Agent、Provider 和语言区分同名项目。
fn project_list_groups_directories_and_disambiguates_provider() {
    let project_dir = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project_dir.path());
    profile.project_id = "claude-amazon".to_string();
    profile.project_name = "amazon".to_string();
    profile.runtime_project_id = Some("claude-amazon".to_string());

    let mut claude = sample_registered_project("claude-amazon", "amazon", project_dir.path());
    claude.group_path = vec![
        RegisteredGroupSegment {
            id: "claude-root".to_string(),
            name: "claude".to_string(),
        },
        RegisteredGroupSegment {
            id: "claude-amazon-group".to_string(),
            name: "amazon".to_string(),
        },
    ];
    claude.provider_name = Some("anyRouter-fable5".to_string());

    let mut codex = sample_registered_project("codex-amazon", "amazon", project_dir.path());
    codex.agent = CcConnectAgent::Codex;
    codex.group_path = vec![
        RegisteredGroupSegment {
            id: "codex-root".to_string(),
            name: "codex".to_string(),
        },
        RegisteredGroupSegment {
            id: "codex-amazon-group".to_string(),
            name: "amazon".to_string(),
        },
    ];
    codex.provider_name = Some("Amz项目".to_string());
    codex.provider_is_global = false;

    let mut ungrouped = sample_registered_project("ungrouped-amazon", "amazon", project_dir.path());
    ungrouped.provider_name = Some("muyuan".to_string());

    let projects = vec![claude, codex, ungrouped];
    let list = render_project_list(&profile, &projects);
    assert!(list.contains(
        "CLI-Manager 项目（当前：amazon · Claude Code · Provider：anyRouter-fable5（全局））"
    ));
    assert!(list.contains("📁 claude\n  📁 amazon\n    1. amazon [当前]"));
    assert!(list.contains("Claude Code · Provider：anyRouter-fable5（全局）"));
    assert!(list.contains("📁 codex\n  📁 amazon\n    2. amazon"));
    assert!(list.contains("Codex · Provider：Amz项目"));
    assert!(list.contains("📁 未分组\n  3. amazon"));
    assert!(list.contains("Claude Code · Provider：muyuan（全局）"));

    profile.language = CcConnectLanguage::En;
    let english = render_project_list(&profile, &projects);
    assert!(english.contains("Provider: anyRouter-fable5 (global)"));
    assert!(english.contains("📁 Ungrouped"));
    assert!(english.contains("Path: "));
}

#[test]
// 验证项目 Provider 覆盖优先并解析全局或目录名称。
fn project_provider_prefers_project_override_and_resolves_global_names() {
    let mut catalog = ProviderCatalog::default();
    catalog.current_by_app.insert(
        "claude".to_string(),
        ProviderCatalogEntry {
            id: "provider-global-claude".to_string(),
            name: "anyRouter-fable5".to_string(),
        },
    );
    catalog.names_by_app_and_id.insert(
        ("codex".to_string(), "provider-codex".to_string()),
        "Amz项目".to_string(),
    );

    assert_eq!(
        project_provider(CcConnectAgent::Claude, "{}", &catalog),
        (
            Some("provider-global-claude".to_string()),
            Some("anyRouter-fable5".to_string()),
            true
        )
    );
    assert_eq!(
        project_provider(
            CcConnectAgent::Claude,
            r#"{"claude":{"providerId":"provider-claude","providerName":"muyuan"}}"#,
            &catalog,
        ),
        (
            Some("provider-claude".to_string()),
            Some("muyuan".to_string()),
            false
        )
    );
    assert_eq!(
        project_provider(
            CcConnectAgent::Codex,
            r#"{"codex":{"providerId":"provider-codex","providerName":null}}"#,
            &catalog,
        ),
        (
            Some("provider-codex".to_string()),
            Some("Amz项目".to_string()),
            false
        )
    );
    assert_eq!(
        project_provider(CcConnectAgent::Codex, "not-json", &catalog),
        (None, None, true)
    );
}

#[test]
// 验证项目按侧栏树顺序排列并保留孤立和未分组项目。
fn registered_projects_follow_sidebar_tree_order_and_keep_ungrouped_entries() {
    let project_dir = tempfile::tempdir().unwrap();
    let groups = vec![
        sample_group("terminal", "终端", None, 0),
        sample_group("terminal-app", "应用", Some("terminal"), 0),
        sample_group("claude", "claude", None, 0),
        sample_group("claude-amazon", "amazon", Some("claude"), 0),
        sample_group("orphan", "遗留目录", Some("missing-parent"), 2),
    ];
    let projects = vec![
        sample_project_row(
            "ungrouped",
            "同名项目",
            project_dir.path(),
            CcConnectAgent::Codex,
            None,
            0,
            "{}",
        ),
        sample_project_row(
            "claude-project",
            "同名项目",
            project_dir.path(),
            CcConnectAgent::Claude,
            Some("claude-amazon"),
            0,
            "{}",
        ),
        sample_project_row(
            "terminal-project",
            "终端项目",
            project_dir.path(),
            CcConnectAgent::Claude,
            Some("terminal-app"),
            0,
            "{}",
        ),
        sample_project_row(
            "orphan-project",
            "遗留项目",
            project_dir.path(),
            CcConnectAgent::Claude,
            Some("orphan"),
            0,
            "{}",
        ),
    ];
    let ordered = order_registered_projects(groups, projects, &ProviderCatalog::default());
    assert_eq!(
        ordered
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "terminal-project",
            "claude-project",
            "orphan-project",
            "ungrouped"
        ]
    );
    assert_eq!(
        ordered[0]
            .group_path
            .iter()
            .map(|group| group.name.as_str())
            .collect::<Vec<_>>(),
        vec!["终端", "应用"]
    );
    assert_eq!(
        ordered[2]
            .group_path
            .iter()
            .map(|group| group.name.as_str())
            .collect::<Vec<_>>(),
        vec!["遗留目录"]
    );
    assert!(ordered[3].group_path.is_empty());
}

#[cfg(target_os = "windows")]
#[test]
// 通过 PowerShell 读取临时清单验证 UTF-8 输出。
fn project_list_command_returns_utf8_manifest() {
    let project = tempfile::tempdir().unwrap();
    let profile = sample_profile(project.path());
    let list_path = project.path().join("projects.txt");
    fs::write(&list_path, "项目一\n1. 示例").unwrap();
    let (commands, _) =
        build_remote_project_commands(&profile, &list_path, &project.path().join("switch.ps1"))
            .unwrap();
    let command = commands[0].exec.replace("{{0:}}", "");
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "项目一\n1. 示例"
    );
}

#[cfg(target_os = "windows")]
#[test]
// 运行临时切换脚本验证无效及越界输入在启动应用前被拒绝。
fn project_switch_script_rejects_invalid_or_out_of_range_arguments() {
    let project = tempfile::tempdir().unwrap();
    let profile = sample_profile(project.path());
    let projects = vec![
        sample_registered_project("project-1", "First", project.path()),
        sample_registered_project("project-2", "Second", project.path()),
    ];
    let script_path = project.path().join("switch.ps1");
    fs::write(
        &script_path,
        render_project_switch_script(
            &profile,
            &projects,
            Path::new(r"C:\does-not-run\cli-manager.exe"),
        )
        .unwrap(),
    )
    .unwrap();
    let run = |encoded: Option<String>| {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script_path);
        if let Some(encoded) = encoded {
            command.arg(encoded);
        }
        command.output().unwrap()
    };
    assert!(run(None).status.success());
    for raw in ["", "0", "-1", "abc", "1;Write-Output hacked", "1 extra"] {
        let output = run(Some(base64_utf8(raw)));
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("请输入有效的项目序号"));
        assert!(!stdout.contains("hacked"));
    }
    let output = run(Some("not-base64".to_string()));
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("请输入有效的项目序号"));
    let output = run(Some(base64_utf8("3")));
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("项目序号超出范围"));
}

#[cfg(target_os = "windows")]
#[test]
// 模拟远端参数编码并验证 PowerShell 注入片段不被执行。
fn project_switch_command_encodes_user_arguments() {
    // 模拟固定 cc-connect 版本的空白分词与 ASCII 引号处理。
    fn split_cc_connect_v1_4_1_args(raw: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut current = String::new();
        let mut in_single = false;
        let mut in_double = false;
        for ch in raw.chars() {
            match ch {
                '\'' if !in_double => in_single = !in_single,
                '"' if !in_single => in_double = !in_double,
                ' ' | '\t' if !in_single && !in_double => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(ch),
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
        tokens
    }

    let project = tempfile::tempdir().unwrap();
    let profile = sample_profile(project.path());
    let projects = vec![sample_registered_project(
        "project-1",
        "First",
        project.path(),
    )];
    let script_path = project.path().join("switch.ps1");
    fs::write(
        &script_path,
        render_project_switch_script(
            &profile,
            &projects,
            Path::new(r"C:\does-not-run\cli-manager.exe"),
        )
        .unwrap(),
    )
    .unwrap();
    let list_path = project.path().join("projects.txt");
    let (commands, _) = build_remote_project_commands(&profile, &list_path, &script_path).unwrap();
    let ascii_footer_attempt =
        split_cc_connect_v1_4_1_args("/cli_manager_switch 1\n'@\nWrite-Output hacked\n#")[1..]
            .join(" ");
    for raw in [
        "1;Write-Output hacked",
        "1\nWrite-Output hacked",
        "1’; Write-Output hacked; #",
        "1‘; Write-Output hacked; #",
        "1‛; Write-Output hacked; #",
        "1\n’@\nWrite-Output hacked\n#",
        &ascii_footer_attempt,
    ] {
        let command = commands[1].exec.replace("{{args:}}", raw);
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
            .output()
            .unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(!stdout.lines().any(|line| line.trim() == "hacked"));
        if output.status.success() {
            assert!(stdout.contains("请输入有效的项目序号"));
        }
    }
}
