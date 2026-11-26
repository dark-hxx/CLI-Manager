use super::*;
use std::fs;
use tempfile::tempdir;

fn fixture() -> (tempfile::TempDir, Scope) {
    let root = tempdir().unwrap();
    let scope = Scope::local(
        root.path().into(),
        "/Applications/CLI Manager.app/Contents/MacOS/cli-manager".into(),
        false,
    )
    .unwrap();
    (root, scope)
}

#[test]
fn antigravity_inspection_uninstall_and_reinstall_are_idempotent() {
    let (root, scope) = fixture();
    let p = root.path().join(".gemini/config/hooks.json");
    for op in [Action::Inspect, Action::Uninstall] {
        assert_eq!(apply(&scope, op).unwrap().status, Status::NotInstalled);
    }
    assert!(!p.parent().unwrap().exists());
    assert_eq!(
        apply(&scope, Action::Install).unwrap().status,
        Status::Installed
    );
    let original = fs::read(&p).unwrap();
    assert_eq!(
        apply(&scope, Action::Install).unwrap().status,
        Status::Installed
    );
    assert_eq!(fs::read(&p).unwrap(), original);
    let mut tree: Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(tree[OWNER].as_object().unwrap().len(), 3);
    tree["external-rule"] =
        json!({"enabled":false,"PreToolUse":[{"command":"unchanged"}],"future":{"未知":123}});
    tree[OWNER].as_object_mut().unwrap().remove("Stop");
    fs::write(&p, serde_json::to_vec(&tree).unwrap()).unwrap();
    assert_eq!(
        apply(&scope, Action::Inspect).unwrap().status,
        Status::PartialInstalled
    );
    assert_eq!(
        apply(&scope, Action::Install).unwrap().status,
        Status::Installed
    );
    assert_eq!(
        apply(&scope, Action::Uninstall).unwrap().status,
        Status::NotInstalled
    );
    assert_eq!(
        apply(&scope, Action::Uninstall).unwrap().status,
        Status::NotInstalled
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&p).unwrap()).unwrap(),
        json!({"external-rule":tree["external-rule"]})
    );
}

#[test]
fn antigravity_invalid_root_broken_json_and_same_name_conflicts_stay_byte_identical() {
    let (root, scope) = fixture();
    let dir = root.path().join(".gemini/config");
    fs::create_dir_all(&dir).unwrap();
    let p = dir.join("hooks.json");
    let unrelated =
        json!({"type":"command","command":"echo __hook --source antigravity --event Stop"});
    let our_stop =
        desired_definition(&scope.exe, scope.windows_native, None).unwrap()["Stop"].to_string();
    let ambiguous =
        format!(r#"{{"{OWNER}":{{"Stop":[{{"command":"other user hook"}}],"Stop":{our_stop}}}}}"#);
    for raw in [
        ambiguous,
        String::new(),
        "  ".into(),
        "{broken".into(),
        "[]".into(),
        r#"{"a":{}, "\u0061":{}}"#.into(),
        json!({OWNER: {"enabled":true}}).to_string(),
        json!({OWNER:{"Stop":[unrelated]}}).to_string(),
        json!({OWNER:null}).to_string(),
    ] {
        fs::write(&p, &raw).unwrap();
        for action in [Action::Inspect, Action::Install, Action::Uninstall] {
            assert_eq!(apply(&scope, action).unwrap().status, Status::Conflict);
        }
        assert_eq!(fs::read_to_string(&p).unwrap(), raw);
    }
}

#[test]
fn antigravity_preserves_foreign_order_whitespace_and_large_numbers() {
    let (root, scope) = fixture();
    let dir = root.path().join(".gemini/config");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("hooks.json");
    let first = r#""z-last" : {"unknown":100000000000000000001, "raw": "\u0041"}"#;
    let second = r#""a-first" : [ {"command":"unchanged"}  ]"#;
    let original = format!("{{\r\n  {first},\n {second}\n}}\r\n");
    fs::write(&path, &original).unwrap();
    for action in [Action::Install, Action::Uninstall] {
        apply(&scope, action).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains(&format!("{first},\n {second}")));
    }
}

#[test]
fn antigravity_stale_changes_and_other_homes_are_never_overwritten() {
    let (a, scope_a) = fixture();
    let (b, scope_b) = fixture();
    let installed = apply(&scope_a, Action::Install).unwrap();
    assert!(installed
        .config_path
        .starts_with(&*a.path().to_string_lossy()));
    assert_eq!(
        apply(&scope_b, Action::Inspect).unwrap().status,
        Status::NotInstalled
    );
    assert!(!b.path().join(".gemini").exists());
    let original = scope_a.read().unwrap().unwrap();
    let p = a.path().join(".gemini/config/hooks.json");
    fs::write(&p, b"{\"other\": {}} ").unwrap();
    assert!(scope_a.publish(Some(&original), b"{}").is_err());
    assert_eq!(fs::read(p).unwrap(), b"{\"other\": {}} ");
    for d in ["", "-d", "Ubuntu\\home", "../test"] {
        assert!(Scope::resolve(Some(d)).is_err());
    }
}

#[test]
fn antigravity_windows_posix_and_wsl_commands_preserve_executable_and_bind_distro() {
    let safe = hook_command(r"F:\bin\cli-manager.exe", "Stop", true).unwrap();
    assert_eq!(
        safe,
        r"F:\bin\cli-manager.exe __hook --source antigravity --event Stop"
    );
    let verbatim = hook_command(r"\\?\F:\bin\cli-manager.exe", "Stop", true).unwrap();
    assert_eq!(verbatim, safe);
    // 复杂 Windows 路径和 UNC 路径要求系统 PowerShell 绝对路径；它不是 POSIX 上的依赖。
    #[cfg(windows)]
    {
        let path = r"C:\Users\O'Brien ’ & Co\cli-manager.exe";
        let complex = hook_command(path, "Stop", true).unwrap();
        let data = STANDARD
            .decode(complex.split_whitespace().last().unwrap())
            .unwrap();
        let units = data
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&units).unwrap();
        assert!(script.starts_with(PS_PREAMBLE));
        assert!(script.contains(&STANDARD.encode(path.as_bytes())));
        assert!(!script.contains(path));
        assert!(script.contains("__hook --source antigravity --event Stop"));

        let unc = hook_command(r"\\server\share\cli-manager.exe", "Stop", true).unwrap();
        assert!(unc.contains(PS_ENCODED_FLAGS));
    }
    assert_eq!(hook_command("/Applications/O'Brien App.app/Contents/MacOS/cli-manager","Stop",false).unwrap(),"'/Applications/O'\\''Brien App.app/Contents/MacOS/cli-manager' __hook --source antigravity --event Stop");
    let wsl = desired_definition(
        "/mnt/c/Program Files/cli-manager.exe",
        false,
        Some("Ubuntu-24.04"),
    )
    .unwrap();
    assert_eq!(wsl["Stop"][0]["command"],"'/mnt/c/Program Files/cli-manager.exe' __hook --source antigravity --event Stop --agy-wsl-distro 'Ubuntu-24.04'");
    assert_eq!(wsl["Stop"][0]["timeout"], 10);
}

#[test]
fn antigravity_outdated_owned_entries_are_repairable_and_removable_while_foreign_stay_conflict() {
    let root = tempdir().unwrap();
    let dir = root.path().join(".gemini").join("config");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("hooks.json");
    let scope = Scope::local(root.path().into(), r"F:\new\CLI-Manager\cli-manager.exe".into(), true)
        .unwrap();

    // Legacy forward-slash path + timeout 5 + old path -> PartialInstalled (repairable & removable).
    let outdated = json!({
        "user-hook": { "Stop": [{ "type": "command", "command": "echo keep" }] },
        OWNER: {
            "SessionStart": [{ "type": "command", "command": "F:/soft/CLI-Manager/cli-manager.exe __hook --source antigravity --event SessionStart", "timeout": 5 }],
            "PreInvocation": [{ "type": "command", "command": "D:\\old\\cli-manager.exe __hook --source antigravity --event PreInvocation", "timeout": 5 }],
            "Stop": [{ "type": "command", "command": "F:/soft/CLI-Manager/cli-manager.exe __hook --source antigravity --event Stop" }]
        }
    });
    fs::write(&path, serde_json::to_vec_pretty(&outdated).unwrap()).unwrap();
    assert_eq!(
        apply(&scope, Action::Inspect).unwrap().status,
        Status::PartialInstalled
    );
    assert_eq!(
        apply(&scope, Action::Install).unwrap().status,
        Status::Installed
    );
    let repaired: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        repaired[OWNER]["Stop"][0]["command"],
        r"F:\new\CLI-Manager\cli-manager.exe __hook --source antigravity --event Stop"
    );
    assert_eq!(repaired[OWNER]["Stop"][0]["timeout"], 10);
    assert_eq!(repaired["user-hook"], outdated["user-hook"]);

    // Outdated entry can also be directly uninstalled without manual file edits.
    fs::write(&path, serde_json::to_vec_pretty(&outdated).unwrap()).unwrap();
    assert_eq!(
        apply(&scope, Action::Uninstall).unwrap().status,
        Status::NotInstalled
    );
    let after_remove: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(after_remove.get(OWNER).is_none());
    assert_eq!(after_remove["user-hook"], outdated["user-hook"]);

    // Legacy PowerShell template (without preamble) for complex path -> PartialInstalled.
    let legacy_ps_script = format!(
        "{PS_BODY_PREFIX}{}'));$s.Arguments='__hook --source antigravity --event Stop';\
         $p=[Diagnostics.Process]::Start($s);$p.WaitForExit();exit $p.ExitCode",
        STANDARD.encode(r"C:\Program Files\CLI Manager\cli-manager.exe".as_bytes())
    );
    let legacy_ps_encoded = STANDARD.encode(
        legacy_ps_script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let legacy_ps_cmd = format!(
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe{PS_ENCODED_FLAGS}{legacy_ps_encoded}"
    );
    let legacy_ps = json!({
        OWNER: { "Stop": [{ "type": "command", "command": legacy_ps_cmd, "timeout": 5 }] }
    });
    fs::write(&path, serde_json::to_vec(&legacy_ps).unwrap()).unwrap();
    assert_eq!(
        apply(&scope, Action::Inspect).unwrap().status,
        Status::PartialInstalled
    );

    // Foreign / spoofed commands must remain Conflict.
    for foreign in [
        json!({ OWNER: { "Stop": [{ "type": "command", "command": "echo __hook --source antigravity --event Stop", "timeout": 10 }] } }),
        json!({ OWNER: { "Stop": [{ "type": "command", "command": r"C:\Windows\System32\evil.exe __hook --source antigravity --event Stop", "timeout": 10 }] } }),
        json!({ OWNER: { "Stop": [{ "type": "command", "command": r"F:\new\CLI-Manager\cli-manager.exe __hook --source antigravity --event Stop", "timeout": 0 }] } }),
    ] {
        fs::write(&path, serde_json::to_vec(&foreign).unwrap()).unwrap();
        assert_eq!(
            apply(&scope, Action::Inspect).unwrap().status,
            Status::Conflict
        );
    }

    // Mismatched WSL distro remains Conflict; matching moved WSL exe is PartialInstalled.
    let wsl_desired = desired_definition("/mnt/f/new/cli-manager.exe", false, Some("Ubuntu")).unwrap();
    let wsl_moved = json!({
        "Stop": [{ "type": "command", "command": "'/mnt/f/old/cli-manager.exe' __hook --source antigravity --event Stop --agy-wsl-distro 'Ubuntu'", "timeout": 5 }]
    });
    assert_eq!(
        status(Some(wsl_moved), &wsl_desired, false, Some("Ubuntu")),
        Status::PartialInstalled
    );
    let wsl_wrong_distro = json!({
        "Stop": [{ "type": "command", "command": "'/mnt/f/old/cli-manager.exe' __hook --source antigravity --event Stop --agy-wsl-distro 'Debian'", "timeout": 5 }]
    });
    assert_eq!(
        status(Some(wsl_wrong_distro), &wsl_desired, false, Some("Ubuntu")),
        Status::Conflict
    );
}

#[test]
fn antigravity_config_display_uses_native_separators_and_document_tolerates_utf8_bom() {
    let (root, scope) = fixture();
    let display = scope.config_display();
    #[cfg(windows)]
    {
        assert!(!display.contains('/'), "unexpected mixed slash in {display}");
        assert!(display.ends_with(r"\.gemini\config\hooks.json"));
    }
    #[cfg(not(windows))]
    {
        assert!(display.ends_with("/.gemini/config/hooks.json"));
    }

    let dir = root.path().join(".gemini").join("config");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("hooks.json");
    let mut with_bom = b"\xEF\xBB\xBF".to_vec();
    with_bom.extend_from_slice(br#"{"external": {"enabled": false}}"#);
    fs::write(&path, &with_bom).unwrap();
    assert_eq!(
        apply(&scope, Action::Inspect).unwrap().status,
        Status::NotInstalled
    );
    assert_eq!(
        apply(&scope, Action::Install).unwrap().status,
        Status::Installed
    );
    let written = fs::read(&path).unwrap();
    assert!(!written.starts_with(b"\xEF\xBB\xBF"));
    let parsed: Value = serde_json::from_slice(&written).unwrap();
    assert_eq!(parsed["external"], json!({"enabled": false}));
    assert!(parsed.get(OWNER).is_some());
}

#[cfg(unix)]
#[test]
fn antigravity_rejects_intermediate_symlink_and_dangling_hook() {
    let (root, scope) = fixture();
    let other = tempdir().unwrap();
    let link = root.path().join(".gemini");
    std::os::unix::fs::symlink(other.path(), &link).unwrap();
    assert!(apply(&scope, Action::Install).is_err());
    assert!(!other.path().join("config").exists());
    fs::remove_file(link).unwrap();
    let dir = root.path().join(".gemini/config");
    fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(other.path().join("missing"), dir.join("hooks.json")).unwrap();
    assert!(apply(&scope, Action::Install).is_err());
}
