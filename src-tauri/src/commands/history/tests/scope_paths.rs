use super::*;

#[test]
fn parse_wsl_find_session_file_line_extracts_path_metadata_and_project() {
    let hit = parse_wsl_find_session_file_line(
        "/home/me/.claude/projects/proj/session.jsonl\t42\t1719234567.2500000000",
        &|path| claude_project_key_from_wsl_linux_path(path),
    )
    .unwrap();

    assert_eq!(
        hit.linux_path,
        "/home/me/.claude/projects/proj/session.jsonl"
    );
    assert_eq!(hit.project_key, "proj");
    assert_eq!(hit.fingerprint.size, 42);
    assert_eq!(hit.fingerprint.updated_at, 1_719_234_567_250);
    assert_eq!(hit.fingerprint.created_at, 1_719_234_567_250);
}

#[test]
fn session_matches_project_path_matches_wsl_encoded_claude_key() {
    // CLI-Manager 项目为 Windows 路径，claude 在 WSL 内按 /mnt/d 编码出此目录名（现场真实值）
    let file_ref = SessionFileRef {
        source: "claude".to_string(),
        project_key: "-mnt-d-work-pythonProject-CLI-Manager".to_string(),
        path: PathBuf::from("dummy.jsonl"),
    };
    let target = normalize_history_path(r"D:\work\pythonProject\CLI-Manager");
    assert!(session_matches_project_path(&file_ref, &target));
}

#[test]
fn session_matches_project_path_rejects_unrelated_claude_key() {
    let file_ref = SessionFileRef {
        source: "claude".to_string(),
        project_key: "-mnt-d-some-other-project".to_string(),
        path: PathBuf::from("nonexistent-xyz-key.jsonl"),
    };
    let target = normalize_history_path(r"D:\work\pythonProject\CLI-Manager");
    assert!(!session_matches_project_path(&file_ref, &target));
}

#[test]
fn resolve_session_file_ref_accepts_indexed_jsonl() {
    let temp_dir = TempDir::new().unwrap();
    let base = temp_dir.path().join("history");
    let file = base.join("project-a").join("session.jsonl");
    write_file(&file);

    let result = resolve_session_file_ref(
        file.to_str().unwrap(),
        "claude",
        "project-a",
        &base.canonicalize().unwrap(),
        vec![SessionFileRef {
            source: "claude".to_string(),
            project_key: "project-a".to_string(),
            path: file.clone(),
        }],
    )
    .unwrap();

    assert_eq!(result.source, "claude");
    assert_eq!(result.project_key, "project-a");
    assert_eq!(result.path, file.canonicalize().unwrap());
}

#[test]
fn resolve_session_file_ref_reconciles_codex_project_key_from_cwd() {
    let temp_dir = TempDir::new().unwrap();
    let base = temp_dir.path().join("sessions");
    let file = base.join("2026").join("07").join("rollout-session.jsonl");
    write_text(
        &file,
        "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/data/tabGo\"}}\n",
    );

    let candidate = SessionFileRef {
        source: "codex".to_string(),
        project_key: "2026".to_string(),
        path: file.clone(),
    };
    let result = resolve_session_file_ref(
        file.to_str().unwrap(),
        "codex",
        "tabGo",
        &base.canonicalize().unwrap(),
        vec![candidate.clone()],
    )
    .unwrap();
    let wrong_project = expect_string_err(resolve_session_file_ref(
        file.to_str().unwrap(),
        "codex",
        "other-project",
        &base.canonicalize().unwrap(),
        vec![candidate],
    ));

    assert_eq!(result.source, "codex");
    assert_eq!(result.project_key, "tabGo");
    assert_eq!(result.path, file.canonicalize().unwrap());
    assert_eq!(wrong_project, "session_file_not_indexed");
}

#[test]
fn resolve_session_file_ref_rejects_non_jsonl() {
    let temp_dir = TempDir::new().unwrap();
    let base = temp_dir.path().join("history");
    let file = base.join("project-a").join("session.txt");
    write_file(&file);

    let err = expect_string_err(resolve_session_file_ref(
        file.to_str().unwrap(),
        "claude",
        "project-a",
        &base.canonicalize().unwrap(),
        Vec::new(),
    ));

    assert_eq!(err, "invalid_session_file");
}

#[test]
fn resolve_session_file_ref_rejects_path_outside_history_scope() {
    let temp_dir = TempDir::new().unwrap();
    let base = temp_dir.path().join("history");
    let file = temp_dir.path().join("outside").join("session.jsonl");
    write_file(&base.join("project-a").join("known.jsonl"));
    write_file(&file);

    let err = expect_string_err(resolve_session_file_ref(
        file.to_str().unwrap(),
        "claude",
        "project-a",
        &base.canonicalize().unwrap(),
        Vec::new(),
    ));

    assert_eq!(err, "session_file_outside_history_scope");
}

#[test]
fn path_within_history_scope_accepts_equivalent_wsl_unc_prefixes() {
    let requested = PathBuf::from(
        r"\\wsl.localhost\Ubuntu\home\silver\.codex\sessions\2026\06\29\rollout.jsonl",
    );
    let history_base = PathBuf::from(r"\\wsl$\Ubuntu\home\silver\.codex\sessions");

    assert!(path_within_history_scope(&requested, &history_base));
}

#[test]
fn path_within_history_scope_accepts_verbatim_wsl_unc_prefixes() {
    let requested = PathBuf::from(
        r"\\?\UNC\wsl.localhost\Ubuntu\home\silver\.codex\sessions\2026\06\29\rollout.jsonl",
    );
    let history_base = PathBuf::from(r"\\?\UNC\wsl$\Ubuntu\home\silver\.codex\sessions");

    assert!(path_within_history_scope(&requested, &history_base));
}

#[test]
fn codex_runtime_path_uses_linux_path_for_wsl_unc() {
    let standard = PathBuf::from(
        r"\\wsl.localhost\Ubuntu-22.04\home\dministrator\.codex\sessions\2026\07\rollout.jsonl",
    );
    let verbatim = PathBuf::from(
        r"\\?\UNC\wsl$\Ubuntu-22.04\home\dministrator\.codex\sessions\2026\07\rollout.jsonl",
    );
    let native = PathBuf::from(r"C:\Users\Administrator\.codex\sessions\rollout.jsonl");

    assert_eq!(
        codex_runtime_path(&standard),
        "/home/dministrator/.codex/sessions/2026/07/rollout.jsonl"
    );
    assert_eq!(
        codex_runtime_path(&verbatim),
        "/home/dministrator/.codex/sessions/2026/07/rollout.jsonl"
    );
    assert_eq!(codex_runtime_path(&native), native.to_string_lossy());
}

#[test]
fn codex_state_registration_is_disabled_for_wsl_database() {
    let wsl_db =
        PathBuf::from(r"\\wsl.localhost\Ubuntu-22.04\home\dministrator\.codex\state_5.sqlite");
    let native_db = PathBuf::from(r"C:\Users\Administrator\.codex\state_5.sqlite");

    assert!(!should_register_codex_state_db(&wsl_db));
    assert!(should_register_codex_state_db(&native_db));
}

#[test]
fn path_within_history_scope_rejects_wsl_paths_outside_base() {
    let requested = PathBuf::from(r"\\wsl.localhost\Ubuntu\home\silver\.codex\other\rollout.jsonl");
    let history_base = PathBuf::from(r"\\wsl$\Ubuntu\home\silver\.codex\sessions");

    assert!(!path_within_history_scope(&requested, &history_base));
}

#[test]
fn resolve_session_file_ref_rejects_source_or_project_mismatch() {
    let temp_dir = TempDir::new().unwrap();
    let base = temp_dir.path().join("history");
    let file = base.join("project-a").join("session.jsonl");
    write_file(&file);

    let wrong_project = expect_string_err(resolve_session_file_ref(
        file.to_str().unwrap(),
        "claude",
        "project-a",
        &base.canonicalize().unwrap(),
        vec![SessionFileRef {
            source: "claude".to_string(),
            project_key: "project-b".to_string(),
            path: file.clone(),
        }],
    ));
    let wrong_source = expect_string_err(resolve_session_file_ref(
        file.to_str().unwrap(),
        "claude",
        "project-a",
        &base.canonicalize().unwrap(),
        vec![SessionFileRef {
            source: "codex".to_string(),
            project_key: "project-a".to_string(),
            path: file.clone(),
        }],
    ));

    assert_eq!(wrong_project, "session_file_not_indexed");
    assert_eq!(wrong_source, "session_file_not_indexed");
}
