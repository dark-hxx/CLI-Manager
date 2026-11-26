use super::*;

const ID: &str = "1bb38313-c9a6-4a91-a4a1-1dd923f5c2ba";
const NIL: &str = "00000000-0000-0000-0000-000000000000";
const CWD: &str = "/Users/Example/Repo";

fn transcript(root: &Path, id: &str, cwd: &str) {
    write_text(
        &root.join("history.jsonl"),
        &serde_json::json!({ "conversationId":id, "workspace":cwd }).to_string(),
    );
    write_text(
        &root
            .join("brain")
            .join(id)
            .join(".system_generated/logs/transcript.jsonl"),
        r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","content":"fixture"}"#,
    );
}

#[test]
fn antigravity_bound_disk_requires_primary_and_current_unambiguous_mapping() {
    let temp = TempDir::new().unwrap();
    let primary = temp.path().join(".gemini/antigravity-cli");
    let legacy = primary.with_file_name("antigravity");
    let roots = HistoryRoots::default().with_antigravity_config_dir(Some(path_to_key(&primary)));
    transcript(&legacy, ID, CWD);
    assert_eq!(resolve_antigravity_history_root(&roots), legacy);
    assert!(antigravity::bound_summary(&legacy, ID, CWD, "").is_none());
    assert!(antigravity::bound_summary(&primary, ID, CWD, "").is_none());
    transcript(&primary, ID, CWD);
    assert_eq!(resolve_antigravity_history_root(&roots), primary);
    assert!(antigravity::bound_summary(&primary, ID, CWD, "").is_some());
    for mismatched in [
        "/Users/Example/repo",
        "/Users/Other/Repo",
        "/Users/Example/Repo/worktree",
    ] {
        assert!(antigravity::bound_summary(&primary, ID, mismatched, "").is_none());
    }
    assert!(antigravity::bound_summary(&primary, ID, CWD, "ubuntu").is_none());
    let map = primary.join("history.jsonl");
    let duplicate = format!(
        "{}\n{}",
        serde_json::json!({"conversationId":ID,"workspace":CWD}),
        serde_json::json!({"conversationId":ID,"workspace":"/other"})
    );
    write_text(&map, &duplicate);
    assert!(antigravity::bound_summary(&primary, ID, CWD, "").is_none());
    transcript(&primary, NIL, CWD);
    assert!(antigravity::bound_summary(&primary, NIL, CWD, "").is_none());
}

#[test]
fn antigravity_path_identity_preserves_roots_posix_case_and_distro() {
    let file = Path::new("/Users/Example/.gemini/antigravity-cli/brain/session");
    assert!(antigravity::cwd_matches(file, "/", "/"));
    assert!(antigravity::cwd_matches(file, CWD, "/Users/Example/Repo/"));
    assert!(!antigravity::cwd_matches(file, CWD, "/users/example/repo"));
    assert!(antigravity::cwd_matches(file, "C:/", "c:/"));
    assert!(!antigravity::cwd_matches(file, "C:/", "C:"));
    let wsl_file = Path::new(r"\\wsl.localhost\Ubuntu\home\user\brain");
    assert!(antigravity::cwd_matches(
        wsl_file,
        "/home/Repo",
        r"\\wsl$\ubuntu\home\Repo"
    ));
    assert!(!antigravity::cwd_matches(
        wsl_file,
        "/home/Repo",
        r"\\wsl$\Debian\home\Repo"
    ));
    assert!(!antigravity::cwd_matches(
        wsl_file,
        "/home/Repo",
        "/home/repo"
    ));
}

#[tokio::test]
async fn antigravity_conversation_summaries_db_maps_uris_and_falls_back_to_history() {
    use sqlx::{Connection, SqliteConnection};

    let temp = TempDir::new().unwrap();
    let root = temp.path().join(".gemini/antigravity-cli");
    std::fs::create_dir_all(root.join("brain")).unwrap();

    let id_posix = "aaaaaaaa-1111-4444-8888-111111111111";
    let id_win = "bbbbbbbb-2222-4444-8888-222222222222";
    let id_wsl = "cccccccc-3333-4444-8888-333333333333";
    let id_multi = "dddddddd-4444-4444-8888-444444444444";
    let id_fallback = "eeeeeeee-5555-4444-8888-555555555555";

    let db_path = root.join("conversation_summaries.db");
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);
    let mut conn = SqliteConnection::connect_with(&opts).await.unwrap();
    sqlx::query(
        "CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            workspace_uris TEXT NOT NULL
        )",
    )
    .execute(&mut conn)
    .await
    .unwrap();

    for (cid, uris) in [
        (id_posix, r#"["file:///Users/My%20App/%E4%B8%AD%E6%96%87"]"#),
        (id_win, r#"["file:///c%3A/Work/Repo"]"#),
        (id_wsl, r#"["file://wsl.localhost/Ubuntu/home/dev/proj"]"#),
        (id_multi, r#"["file:///Users/a","file:///Users/b"]"#),
        (id_fallback, r#"[]"#),
    ] {
        sqlx::query(
            "INSERT INTO conversation_summaries(conversation_id, workspace_uris) VALUES (?1, ?2)",
        )
        .bind(cid)
        .bind(uris)
        .execute(&mut conn)
        .await
        .unwrap();
    }
    drop(conn);

    write_text(
        &root.join("history.jsonl"),
        &format!(
            "{}\n{}",
            serde_json::json!({ "conversationId": id_multi, "workspace": "/Users/fallback-ignored" }),
            serde_json::json!({ "conversationId": id_fallback, "workspace": "/Users/from-history" }),
        ),
    );

    let map = load_antigravity_workspace_map(&root);
    assert_eq!(map.get(id_posix).map(String::as_str), Some("/Users/My App/中文"));
    assert_eq!(map.get(id_win).map(String::as_str), Some("c:/Work/Repo"));
    assert_eq!(
        map.get(id_wsl).map(String::as_str),
        Some("//wsl.localhost/Ubuntu/home/dev/proj")
    );
    assert!(!map.contains_key(id_multi));
    assert_eq!(
        map.get(id_fallback).map(String::as_str),
        Some("/Users/from-history")
    );

    let transcript_file = root
        .join("brain")
        .join(id_posix)
        .join(".system_generated/logs/transcript.jsonl");
    write_text(
        &transcript_file,
        r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","content":"hi"}"#,
    );
    assert_eq!(
        antigravity_workspace_from_path(&transcript_file).as_deref(),
        Some("/Users/My App/中文")
    );

    let id_added = "ffffffff-6666-4444-8888-666666666666";
    let mut conn = SqliteConnection::connect_with(&opts).await.unwrap();
    sqlx::query(
        "INSERT INTO conversation_summaries(conversation_id, workspace_uris) VALUES (?1, ?2)",
    )
    .bind(id_added)
    .bind(r#"["file:///Users/newly-added"]"#)
    .execute(&mut conn)
    .await
    .unwrap();
    drop(conn);

    let refreshed = load_antigravity_workspace_map(&root);
    assert_eq!(
        refreshed.get(id_added).map(String::as_str),
        Some("/Users/newly-added")
    );
}

#[test]
fn antigravity_default_roots_use_os_home() {
    let expected = super::detect_home_dir().map(|home| home.join(".gemini").join("antigravity-cli"));
    assert_eq!(history_roots(None, None, None).antigravity_config_dir, expected);
}

#[test]
fn antigravity_full_transcript_path_and_catalog_fingerprint() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join(".gemini/antigravity-cli");
    let logs = root
        .join("brain")
        .join(ID)
        .join(".system_generated/logs");
    let compact = logs.join("transcript.jsonl");
    let full = logs.join("transcript_full.jsonl");
    write_text(
        &compact,
        r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","content":"hi"}"#,
    );

    assert!(antigravity::full_transcript_path(&compact).is_none());
    let base_fp = session_file_fingerprint(&compact);
    assert!(antigravity::catalog_file_fingerprint(&compact) == base_fp);

    write_text(&full, r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","content":"hello full"}"#);
    assert!(antigravity::full_transcript_path(&compact).is_some());
    let fp_with_full = antigravity::catalog_file_fingerprint(&compact);
    assert!(fp_with_full.size > base_fp.size);

    write_text(
        &full,
        r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","content":"hello full extended content"}"#,
    );
    let fp_grown = antigravity::catalog_file_fingerprint(&compact);
    assert!(fp_grown.size > fp_with_full.size);

    std::fs::remove_file(&full).unwrap();
    assert!(antigravity::full_transcript_path(&compact).is_none());
    assert!(antigravity::catalog_file_fingerprint(&compact) == base_fp);

    let outside = temp.path().join("outside-full.jsonl");
    write_text(&outside, "secret");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, &full).unwrap();
        assert!(antigravity::full_transcript_path(&compact).is_none());
        std::fs::remove_file(&full).unwrap();
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(&outside, &full).is_ok() {
            assert!(antigravity::full_transcript_path(&compact).is_none());
            let _ = std::fs::remove_file(&full);
        } else {
            use std::os::windows::process::CommandExt;
            let outside_dir = temp.path().join("outside-dir");
            std::fs::create_dir_all(&outside_dir).unwrap();
            let output = std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:CLI_MANAGER_TEST_LINK -Target $env:CLI_MANAGER_TEST_TARGET | Out-Null",
                ])
                .env("CLI_MANAGER_TEST_LINK", &full)
                .env("CLI_MANAGER_TEST_TARGET", &outside_dir)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(antigravity::full_transcript_path(&compact).is_none());
            let _ = std::fs::remove_dir(&full);
        }
    }
}
