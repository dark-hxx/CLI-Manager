use super::render::{from_stream, render, Item};
use super::*;
use std::{fs, path::Path};
use tempfile::TempDir;

fn isolated() -> (TempDir, Target) {
    let root = tempfile::tempdir().unwrap();
    let target = Target::local(
        root.path().join("profile with spaces"),
        root.path().join("private"),
    );
    (root, target)
}
fn current(t: &Target) -> Status {
    Loaded::read(t).unwrap().status(t)
}
fn apply(t: &Target, mode: Mode, confirmed: bool) -> Result<Status, String> {
    change(
        t,
        &current(t).revision,
        Change::Apply {
            mode,
            confirmed,
            layout: Layout::default(),
        },
    )
}
fn put(path: &Path, val: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(val).unwrap()).unwrap();
}
fn get(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn identical_guest_home_is_scoped_to_exact_distro_without_host_path_conversion() {
    let (root, local) = isolated();
    let home = "/home/demo name's";
    let target = |name: &str| Target::wsl_scope(name.into(), home, root.path().join("private"));
    let first = target("Alpha");
    assert_eq!(
        first.settings.to_str(),
        Some("/home/demo name's/.gemini/antigravity-cli/settings.json")
    );
    assert_ne!(first.library, target("Beta").library);
    assert_eq!(first.library, target("ALPHA").library);
    assert_ne!(first.library, local.library);
    assert!(!first.library.exists());
}

#[test]
fn first_view_and_sample_leave_target_and_profiles_absent() {
    let (_root, t) = isolated();
    assert_eq!(current(&t).ownership, "native");
    assert!(agy_statusline_preview(Layout::default(), 16)
        .unwrap()
        .contains('\n'));
    assert!(!t.settings.exists());
    assert!(!t.library.exists());
    assert!(!t.settings.parent().unwrap().exists());
}

#[test]
fn external_confirmation_preserves_unknowns_and_restores_exact_block() {
    let (_root, t) = isolated();
    let original =
        json!({"command":"never execute me","type":"command","padding":4,"unknown":[false,null]});
    put(&t.settings, &json!({"ui":{"x":7}, "statusLine":original}));
    let original_bytes = fs::read(&t.settings).unwrap();
    assert_eq!(current(&t).command.as_deref(), Some("never execute me"));
    assert!(matches!(apply(&t, Mode::Custom, false), Err(e) if e == "agy_confirm_required"));
    assert_eq!(fs::read(&t.settings).unwrap(), original_bytes);
    assert!(!t.library.exists());
    let s = apply(&t, Mode::Stacked, true).unwrap();
    assert_eq!(s.ownership, "managed");
    let installed = get(&t.settings);
    assert_eq!(installed["statusLine"]["stack_with_default"], true);
    assert_eq!(installed["statusLine"]["unknown"], original["unknown"]);
    let disabled = apply(&t, Mode::Native, false).unwrap();
    assert_eq!(disabled.mode, Mode::Native);
    assert_eq!(
        get(&t.settings)["statusLine"]["command"],
        installed["statusLine"]["command"]
    );
    let mut concurrent = get(&t.settings);
    concurrent["ui"]["x"] = json!(12);
    put(&t.settings, &concurrent);
    change(&t, &disabled.revision, Change::Restore).unwrap();
    assert_eq!(
        get(&t.settings),
        json!({"ui":{"x":12}, "statusLine":original})
    );
    assert_eq!(current(&t).ownership, "external");
}

#[test]
fn restores_absence_and_explicit_null_distinctly() {
    for initial in [json!({"a":1}), json!({"a":1,"statusLine":null})] {
        let (_root, t) = isolated();
        put(&t.settings, &initial);
        let s = apply(&t, Mode::Custom, true).unwrap();
        change(&t, &s.revision, Change::Restore).unwrap();
        assert_eq!(get(&t.settings), initial);
    }
}

#[test]
fn stale_confirmation_and_restore_never_overwrite_new_external_block() {
    let (_root, t) = isolated();
    let s = apply(&t, Mode::Custom, false).unwrap();
    let replaced = json!({"statusLine":{"command":"external edit"}});
    put(&t.settings, &replaced);
    assert!(matches!(change(&t, &s.revision, Change::Restore), Err(e) if e == "agy_changed"));
    assert_eq!(current(&t).ownership, "drifted");
    assert!(change(&t, &current(&t).revision, Change::Restore).is_err());
    assert!(apply(&t, Mode::Stacked, false).is_err());
    assert_eq!(get(&t.settings), replaced);
    let reclaimed = apply(&t, Mode::Custom, true).unwrap();
    change(&t, &reclaimed.revision, Change::Restore).unwrap();
    assert_eq!(get(&t.settings), replaced);
}

#[test]
fn save_profile_is_scoped_and_never_applies() {
    let (root, t) = isolated();
    let layout = Layout {
        items: vec![Item::Output, Item::Model],
        color: false,
    };
    let s = change(
        &t,
        &current(&t).revision,
        Change::SaveProfile {
            name: "My layout".into(),
            layout: layout.clone(),
        },
    )
    .unwrap();
    assert_eq!(s.layout, layout);
    let second = change(
        &t,
        &s.revision,
        Change::SaveProfile {
            name: "Other".into(),
            layout: Layout::default(),
        },
    )
    .unwrap();
    let chosen = change(
        &t,
        &second.revision,
        Change::SelectProfile {
            name: "My layout".into(),
        },
    )
    .unwrap();
    assert_eq!(chosen.layout, layout);
    assert_eq!(current(&t).selected.as_deref(), Some("My layout"));
    assert!(!t.settings.exists());
    let other = Target::local(
        root.path().join("another-home"),
        root.path().join("private"),
    );
    assert!(current(&other).profiles.is_empty());
    assert!(change(&other, &s.revision, Change::Restore).is_err());
}

#[test]
fn invalid_configuration_does_not_become_a_missing_block() {
    let (_root, t) = isolated();
    fs::create_dir_all(t.settings.parent().unwrap()).unwrap();
    fs::write(&t.settings, b"[broken").unwrap();
    assert!(Loaded::read(&t).is_err());
    assert_eq!(fs::read(&t.settings).unwrap(), b"[broken");
    assert!(!t.library.exists());
}

#[test]
fn identical_sample_runtime_and_preview_bytes_include_ansi_and_wrapping() {
    let sample = json!({"model":{"display_name":"Gemini"},"workspace":{"current_dir":"/work/demo"},"agent_state":"working","terminal_width":15,
        "context_window":{"used_percentage":14.2,"total_input_tokens":12400,"total_output_tokens":380}});
    let layout = Layout::default();
    let actual = from_stream(&layout.encode().unwrap(), sample.to_string().as_bytes()).unwrap();
    assert_eq!(actual, agy_statusline_preview(layout, 15).unwrap());
    assert!(actual.contains("\x1b[36mGemini\x1b[0m\n"));
}

#[test]
fn missing_model_and_tokens_stay_absent_and_untrusted_controls_are_filtered() {
    let mut layout = Layout::default();
    layout.color = false;
    assert_eq!(
        render(&layout, &json!({"model":null,"context_window":{}})).unwrap(),
        ""
    );
    let payload = json!({"context_window":{"total_input_tokens":0},"agent_state":"id\nle\u{1b}"});
    assert_eq!(render(&layout, &payload).unwrap(), "idle | ↓0");
    assert!(from_stream("corrupt", b"{}".as_slice()).is_none());
    assert!(from_stream(&layout.encode().unwrap(), vec![0; 300000].as_slice()).is_none());
}

#[test]
fn journal_recovery_reconciles_only_the_published_block_without_writing_on_read() {
    let (_root, t) = isolated();
    let desired = Block::Present(json!({"command":"fixture","enabled":true}));
    let pending = Pending {
        desired: desired.clone(),
        next: Some(Owner {
            original: Block::Missing,
            installed: desired.clone(),
            layout: Layout::default(),
        }),
    };
    let library = Library {
        pending: Some(pending),
        ..Library::default()
    };
    put(&t.library, &serde_json::to_value(library).unwrap());
    let bytes = fs::read(&t.library).unwrap();
    assert_eq!(current(&t).ownership, "native");
    put(
        &t.settings,
        &json!({"statusLine":desired.value(),"hooks":{"kept":true}}),
    );
    let after = current(&t);
    assert_eq!(after.ownership, "managed");
    assert_eq!(fs::read(&t.library).unwrap(), bytes);
    change(&t, &after.revision, Change::Restore).unwrap();
    assert_eq!(get(&t.settings), json!({"hooks":{"kept":true}}));
}

#[test]
fn external_identical_managed_command_can_be_adopted_and_released() {
    let (_root, t) = isolated();
    let layout = Layout::default();
    let original = json!({"type":"command", "command": t.command(&layout).unwrap(), "stack_with_default":false,"enabled":true});
    put(&t.settings, &json!({"statusLine":original}));
    let bytes = fs::read(&t.settings).unwrap();
    let status = apply(&t, Mode::Custom, true).unwrap();
    assert_eq!(status.ownership, "managed");
    assert_eq!(
        change(&t, &status.revision, Change::Restore)
            .unwrap()
            .ownership,
        "external"
    );
    assert_eq!(fs::read(&t.settings).unwrap(), bytes);
}

// 隔离端到端测试仅索取产品生成的命令串；不打开 Tauri、不访问用户配置、不执行外部命令。
#[test]
#[ignore = "called explicitly by scripts/testAgyStatuslineRuntime.py"]
fn command_for_runtime_smoke() {
    let exe = std::env::var("AGY_P5_FIXTURE_EXE").unwrap();
    let layout: Layout =
        serde_json::from_str(&std::env::var("AGY_P5_FIXTURE_LAYOUT").unwrap()).unwrap();
    let windows = cfg!(windows) && std::env::var_os("AGY_P5_FIXTURE_POSIX").is_none();
    let line = target::command_line(&exe, windows, &layout.encode().unwrap()).unwrap();
    println!("AGY_P5_COMMAND={line}");
}

#[test]
fn commands_quote_posix_and_never_expose_windows_metacharacters() {
    let token = Layout::default().encode().unwrap();
    assert_eq!(
        target::command_line(r"C:\Apps\a.exe", true, &token).unwrap(),
        format!(r"C:\Apps\a.exe __agy_statusline {token}")
    );
    if cfg!(windows) {
        let line = target::command_line(r"C:\%TEMP% & O'Brien\a.exe", true, &token).unwrap();
        assert!(line.contains(" -NoProfile -NonInteractive -EncodedCommand "));
        assert!(!line.contains(['%', '&', '\'']));
    }
    assert!(target::command_line("C:\\a.exe", true, "a';").is_err());
    assert_eq!(
        target::command_line("/home/u's dir/a", false, &token).unwrap(),
        format!("'/home/u'\\''s dir/a' __agy_statusline {token}")
    );
}
