use super::*;

#[cfg(unix)]
#[test]
// 验证 Unix 脚本写入及内容未变时均修复可执行权限。
fn executable_atomic_write_sets_and_repairs_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("codex");
    let payload = b"#!/bin/sh\nexit 0\n";

    write_executable_file_atomically_if_changed(&path, payload, "test wrapper").unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o755
    );

    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o644);
    fs::set_permissions(&path, permissions).unwrap();
    write_executable_file_atomically_if_changed(&path, payload, "test wrapper").unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
// 验证 UTF-8 和 GBK 诊断解码且 stdout 优先。
fn process_output_decodes_utf8_and_gbk_diagnostics() {
    assert_eq!(output_text(b"ready", b"ignored"), "ready");
    let (encoded, _, had_errors) = encoding_rs::GBK.encode("系统找不到指定的路径。\r\n");
    assert!(!had_errors);
    assert_eq!(output_text(&[], &encoded), "系统找不到指定的路径。");
}

#[test]
// 验证代理 URL 规范化及协议、凭据和主机拒绝规则。
fn proxy_url_is_normalized_and_rejects_unsafe_values() {
    assert_eq!(
        normalize_proxy_url(Some(" http://127.0.0.1:10808 ")).unwrap(),
        Some("http://127.0.0.1:10808/".to_string())
    );
    assert_eq!(
        normalize_proxy_url(Some("socks5h://proxy.example.com:7890")).unwrap(),
        Some("socks5h://proxy.example.com:7890".to_string())
    );
    assert_eq!(normalize_proxy_url(Some("   ")).unwrap(), None);
    assert!(normalize_proxy_url(Some("ftp://proxy.example.com:21")).is_err());
    assert!(normalize_proxy_url(Some("http://user:secret@proxy.example.com:8080")).is_err());
    assert!(normalize_proxy_url(Some("http://")).is_err());
}

#[test]
// 通过临时回环监听器验证优先选择首个可连接端口。
fn local_proxy_detection_uses_the_first_reachable_port() {
    let first = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let second = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let first_port = first.local_addr().unwrap().port();
    let second_port = second.local_addr().unwrap().port();
    assert_eq!(
        detect_local_proxy_on_ports(&[first_port, second_port]),
        Some(format!("http://127.0.0.1:{first_port}/"))
    );
    assert_eq!(
        detect_local_proxy_on_ports(&[0, second_port]),
        Some(format!("http://127.0.0.1:{second_port}/"))
    );
    assert_eq!(detect_local_proxy_on_ports(&[]), None);
}

#[test]
// 验证显式代理优先于本机临时监听端口。
fn configured_proxy_takes_priority_over_local_detection() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let local_port = listener.local_addr().unwrap().port();
    assert_eq!(
        resolve_proxy_url(Some("https://proxy.example.com:8443"), &[local_port]).unwrap(),
        Some(ResolvedProxy {
            url: "https://proxy.example.com:8443/".to_string(),
            source: ProxySource::Configured,
        })
    );
}

#[test]
// 验证常见大小写代理变量及回环绕过配置。
fn proxy_environment_covers_common_case_variants() {
    let environment = proxy_environment("http://127.0.0.1:7890/")
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        assert_eq!(
            environment.get(key).map(String::as_str),
            Some("http://127.0.0.1:7890/")
        );
    }
    assert_eq!(
        environment.get("NO_PROXY").map(String::as_str),
        Some("localhost,127.0.0.1,[::1]")
    );
}

#[test]
// 验证禁用代理不选择候选并清除子进程继承代理环境。
fn disabled_proxy_ignores_manual_and_local_proxy_and_scrubs_inherited_environment() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let local_port = listener.local_addr().unwrap().port();
    let proxy =
        resolve_proxy_url_if_enabled(false, Some("http://proxy.example.com:8080"), &[local_port])
            .unwrap();
    assert_eq!(proxy, None);

    let mut command = Command::new("cc-connect");
    for key in PROXY_ENV_KEYS {
        command.env(key, "http://inherited.example.com:3128");
    }
    apply_proxy_environment(&mut command, false, proxy.as_ref());
    let environment = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().to_ascii_lowercase(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for key in ["http_proxy", "https_proxy", "all_proxy"] {
        assert!(environment.get(key).and_then(Option::as_ref).is_none());
    }
    assert_eq!(environment.get("no_proxy"), Some(&Some("*".to_string())));
}

#[test]
// 验证禁用代理时忽略存储的无效手动 URL。
fn disabled_proxy_does_not_validate_a_stored_manual_url() {
    let project = tempfile::tempdir().unwrap();
    let mut profile = sample_profile(project.path());
    profile.proxy_enabled = false;
    profile.proxy_url = Some("not a URL".to_string());
    assert!(!profile_issue_codes(&profile)
        .iter()
        .any(|code| code == "proxy_invalid"));
    profile.proxy_enabled = true;
    assert!(profile_issue_codes(&profile)
        .iter()
        .any(|code| code == "proxy_invalid"));
}

#[cfg(windows)]
#[test]
// 验证 Windows 项目 Git 信任只追加一个规范化目录。
fn git_safe_directory_is_scoped_to_the_registered_project() {
    let environment =
        git_safe_directory_environment(Path::new(r"\\?\F:\test\work\amz\amazon"), Some("2"))
            .into_iter()
            .collect::<BTreeMap<_, _>>();

    assert_eq!(
        environment.get("GIT_CONFIG_COUNT").map(String::as_str),
        Some("3")
    );
    assert_eq!(
        environment.get("GIT_CONFIG_KEY_2").map(String::as_str),
        Some("safe.directory")
    );
    assert_eq!(
        environment.get("GIT_CONFIG_VALUE_2").map(String::as_str),
        Some("F:/test/work/amz/amazon")
    );
    assert!(!environment.contains_key("GIT_CONFIG_KEY_0"));
}

#[test]
// 验证远程 POSIX Git 信任只追加指定目录。
fn remote_git_safe_directory_is_scoped_to_the_registered_posix_path() {
    let environment = git_safe_directory_environment_for_value("/srv/project", Some("1"))
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        environment.get("GIT_CONFIG_COUNT").map(String::as_str),
        Some("2")
    );
    assert_eq!(
        environment.get("GIT_CONFIG_KEY_1").map(String::as_str),
        Some("safe.directory")
    );
    assert_eq!(
        environment.get("GIT_CONFIG_VALUE_1").map(String::as_str),
        Some("/srv/project")
    );
    assert!(!environment.contains_key("GIT_CONFIG_KEY_0"));
}

#[test]
// 验证缺失跳板主机拒绝接管而直接代理不要求跳板。
fn ssh_handoff_jump_routing_fails_closed_when_the_host_is_missing() {
    assert_eq!(
        selected_ssh_jump_host_id("none", None, "none").unwrap(),
        None
    );
    assert_eq!(
        selected_ssh_jump_host_id("host", None, "none").unwrap_err(),
        "handoff_ssh_jump_host_missing"
    );
    assert_eq!(
        selected_ssh_jump_host_id("host", Some("  jump-1  "), "none").unwrap(),
        Some("jump-1")
    );
    assert_eq!(
        selected_ssh_jump_host_id("host", None, "socks5").unwrap(),
        None
    );
}

#[cfg(target_os = "windows")]
#[test]
// 验证不可信临时 exe 仅返回路径摘要且不执行版本探测。
fn explicit_executable_inspection_returns_a_user_path_and_digest() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("cc-connect.exe");
    fs::write(&executable, b"not an official cc-connect binary").unwrap();

    let status = CcConnectManager::new().inspect_executable(&path_string(&executable));

    assert!(status.installed);
    assert!(!status.compatible);
    assert_eq!(status.version, None);
    assert_eq!(status.sha256, Some(sha256_file(&executable).unwrap()));
    assert_eq!(
        status.executable_path,
        user_path_string(&executable.canonicalize().unwrap())
    );
    assert!(!status.executable_path.starts_with(r"\\?\"));
    assert_eq!(status.detection_error, None);
}

#[test]
// 验证注册 CLI 工具只识别四种受支持 Agent 启动名。
fn registered_cli_tool_parser_accepts_supported_launchers_and_rejects_other_agents() {
    for (value, expected) in [
        ("claude", Some(CcConnectAgent::Claude)),
        (
            r#""D:\npm\codex.cmd" --profile managed"#,
            Some(CcConnectAgent::Codex),
        ),
        (r#"C:\tools\pi.bat --model test"#, Some(CcConnectAgent::Pi)),
        ("opencode.exe --continue", Some(CcConnectAgent::Opencode)),
        ("grok", None),
        ("npm run dev", None),
    ] {
        assert_eq!(cc_connect_agent_from_cli_tool(value), expected, "{value}");
    }
}

#[test]
// 验证命令分词、会话参数剥离及残留会话选择拒绝。
fn registered_launcher_parser_preserves_argv_and_rejects_shell_fragments() {
    assert_eq!(
        parse_registered_command(r#""D:\Tools\claude.cmd" --model "test model""#).unwrap(),
        vec![
            r#"D:\Tools\claude.cmd"#.to_string(),
            "--model".to_string(),
            "test model".to_string()
        ]
    );
    assert!(parse_registered_command("codex && whoami").is_err());
    assert_eq!(
        strip_registered_launcher_session_arguments(
            CcConnectAgent::Codex,
            vec!["resume".to_string(), "thread-original".to_string()]
        ),
        Vec::<String>::new()
    );
    assert_eq!(
        strip_registered_launcher_session_arguments(
            CcConnectAgent::Codex,
            vec![
                "resume".to_string(),
                "--no-alt-screen".to_string(),
                "thread-original".to_string(),
                "-c".to_string(),
                "model_reasoning_effort=high".to_string(),
            ]
        ),
        vec!["-c".to_string(), "model_reasoning_effort=high".to_string()]
    );
    assert_eq!(
        strip_registered_launcher_session_arguments(
            CcConnectAgent::Claude,
            vec![
                "--resume".to_string(),
                "session-1".to_string(),
                "--verbose".to_string(),
            ]
        ),
        vec!["--verbose".to_string()]
    );
    assert_eq!(
        strip_registered_launcher_session_arguments(
            CcConnectAgent::Pi,
            vec![
                "--session".to_string(),
                "session-1".to_string(),
                "--verbose".to_string(),
            ]
        ),
        vec!["--verbose".to_string()]
    );
    assert_eq!(
        strip_registered_launcher_session_arguments(
            CcConnectAgent::Opencode,
            vec![
                "-s".to_string(),
                "ses_123".to_string(),
                "--log-level".to_string(),
                "debug".to_string(),
            ]
        ),
        vec!["--log-level".to_string(), "debug".to_string()]
    );
    assert_eq!(
        validate_registered_launcher_arguments(
            CcConnectAgent::Codex,
            &["resume".to_string(), "other-session".to_string()]
        ),
        Err("handoff_agent_launcher_session_arg".to_string())
    );
}

#[cfg(target_os = "windows")]
#[test]
// 验证 PowerShell 启动器使用结构化宿主参数。
fn powershell_launcher_uses_a_structured_host_command() {
    let command = managed_agent_command(&ResolvedAgentLauncher {
        executable: PathBuf::from(r"C:\Tools\pi.ps1"),
        args: vec!["--model".to_string(), "test".to_string()],
    });
    assert_eq!(
        command,
        vec![
            "powershell.exe",
            "-NoProfile",
            "-File",
            "C:/Tools/pi.ps1",
            "--model",
            "test"
        ]
    );
}
