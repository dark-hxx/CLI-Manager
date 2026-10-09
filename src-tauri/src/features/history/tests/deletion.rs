use super::super::deletion::{
    delete_session_file_with_backup_root, delete_session_files_with_backup_root,
};
use super::super::scope::resolve_session_file_ref_for_deletion;
use super::*;
use crate::commands::history_backup::backup_status_for_file;

// 每种读取器使用其原生目录和最小有效转录；备份及旁文件均留在临时目录。
fn write_delete_fixture(root: &Path, source: &str, id: &str) -> PathBuf {
    let (relative, content) = match source {
        "pi" => (
            format!("sessions/project/{id}.jsonl"),
            json!({"type": "session", "id": id}).to_string(),
        ),
        "gemini" => (
            format!("project/chats/session-{id}.json"),
            json!({"sessionId": id, "messages": [{"type": "user", "content": "hello"}]}).to_string(),
        ),
        "copilot" => (
            format!("{id}/events.jsonl"),
            json!({"type": "session.start", "data": {"sessionId": id}}).to_string(),
        ),
        "antigravity" => (
            format!("brain/{id}/.system_generated/logs/transcript.jsonl"),
            json!({"type": "USER_INPUT", "status": "DONE", "content": "hello"}).to_string(),
        ),
        "kiro" => (
            format!("project/{id}.json"),
            json!({"sessionId": id, "history": [{"message": {"role": "user", "content": "hello"}}]}).to_string(),
        ),
        "cursor" => (
            format!("project/agent-transcripts/{id}/{id}.jsonl"),
            json!({"role": "user", "message": {"content": "hello"}}).to_string(),
        ),
        "cline" => (
            format!("tasks/{id}/api_conversation_history.json"),
            json!([{"role": "user", "content": [{"type": "text", "text": "hello"}]}]).to_string(),
        ),
        _ => panic!("unsupported fixture source: {source}"),
    };
    let path = root.join(relative);
    write_text(&path, &content);
    path
}

// 通过真实来源枚举、路径校验、删除和重扫检查整个文件级删除链路。
fn assert_single_transcript_deletion(source: &str, collect: fn(&Path) -> Vec<SessionFileRef>) {
    let temp = TempDir::new().unwrap();
    let root = temp
        .path()
        .join(if source == "pi" { ".pi/agent" } else { source });
    let selected = write_delete_fixture(&root, source, "session-a");
    let other = write_delete_fixture(&root, source, "session-b");
    let before = fs::read(&selected).unwrap();
    let other_before = fs::read(&other).unwrap();
    let companions = [
        root.join("history.jsonl"),
        root.join("sessions.json"),
        root.join("state.db"),
        selected.parent().unwrap().join("metadata.json"),
        selected
            .parent()
            .unwrap()
            .join("subagents/agent-unrelated.jsonl"),
    ];
    for companion in &companions {
        write_text(companion, "preserve companion");
    }
    let candidates = collect(&root);
    assert_eq!(candidates.len(), 2, "{source} discovery");
    let project_key = candidates
        .iter()
        .find(|item| item.path == selected)
        .unwrap()
        .project_key
        .clone();
    let file_ref = resolve_session_file_ref_for_deletion(
        selected.to_str().unwrap(),
        source,
        &project_key,
        &[root.clone()],
        candidates,
    )
    .unwrap();
    let backups = temp.path().join("backups");

    assert_eq!(
        delete_session_file_with_backup_root(&file_ref, &backups).unwrap(),
        1
    );
    assert!(!selected.exists());
    assert!(selected.parent().unwrap().is_dir());
    assert_eq!(fs::read(&other).unwrap(), other_before);
    for companion in &companions {
        assert_eq!(fs::read_to_string(companion).unwrap(), "preserve companion");
    }
    let remaining = collect(&root);
    assert_eq!(remaining.len(), 1, "{source} rescan");
    assert_eq!(remaining[0].path, other);
    let backup = backup_status_for_file(&file_ref.path, &backups);
    assert!(backup.has_backup);
    let backup_path = backup.backup_path.unwrap();
    assert_eq!(fs::read(&backup_path).unwrap(), before);
    // 删除回滚使用明确快照复制；既有恢复 UI 的覆盖预检仍要求原文件存在。
    fs::copy(&backup_path, &file_ref.path).unwrap();
    assert_eq!(fs::read(&selected).unwrap(), before);
}

#[test]
fn history_delete_pi_preserves_adjacent_files() {
    assert_single_transcript_deletion("pi", collect_pi_session_files);
}

#[test]
fn history_delete_gemini_preserves_adjacent_files() {
    assert_single_transcript_deletion("gemini", collect_gemini_session_files);
}

#[test]
fn history_delete_copilot_preserves_adjacent_files() {
    assert_single_transcript_deletion("copilot", collect_copilot_session_files);
}

#[test]
fn history_delete_antigravity_preserves_adjacent_files() {
    assert_single_transcript_deletion("antigravity", collect_antigravity_session_files);
}

#[test]
fn history_delete_kiro_preserves_adjacent_files() {
    assert_single_transcript_deletion("kiro", collect_kiro_session_files);
}

#[test]
fn history_delete_cursor_preserves_adjacent_files() {
    assert_single_transcript_deletion("cursor", collect_cursor_session_files);
}

#[test]
fn history_delete_cline_preserves_adjacent_files() {
    assert_single_transcript_deletion("cline", collect_cline_session_files);
}

// 同名 Cline 转录可以分别来自多个合法根，但共同父目录不构成可信范围。
#[test]
fn history_delete_cline_validates_each_root_and_identity() {
    let temp = TempDir::new().unwrap();
    let roots = vec![temp.path().join("cli"), temp.path().join("extension")];
    let paths = roots
        .iter()
        .map(|root| write_delete_fixture(root, "cline", "task"))
        .collect::<Vec<_>>();
    let candidates = || {
        roots
            .iter()
            .flat_map(|root| collect_cline_session_files(root))
            .collect::<Vec<_>>()
    };
    for path in &paths {
        let project = candidates()
            .into_iter()
            .find(|item| item.path == *path)
            .unwrap()
            .project_key;
        assert!(resolve_session_file_ref_for_deletion(
            path.to_str().unwrap(),
            "cline",
            &project,
            &roots,
            candidates(),
        )
        .is_ok());
        for (source, project_key) in [("pi", project.as_str()), ("cline", "wrong-project")] {
            assert_eq!(
                expect_string_err(resolve_session_file_ref_for_deletion(
                    path.to_str().unwrap(),
                    source,
                    project_key,
                    &roots,
                    candidates(),
                )),
                "session_file_not_indexed"
            );
        }
    }
    let outside = write_delete_fixture(temp.path(), "cline", "outside");
    let outside_ref = collect_cline_session_files(temp.path());
    assert_eq!(
        expect_string_err(resolve_session_file_ref_for_deletion(
            outside.to_str().unwrap(),
            "cline",
            "outside",
            &roots,
            outside_ref,
        )),
        "session_file_outside_history_scope"
    );

    let unindexed = roots[0].join("unknown.json");
    write_text(&unindexed, "[]");
    assert_eq!(
        expect_string_err(resolve_session_file_ref_for_deletion(
            unindexed.to_str().unwrap(),
            "cline",
            "task",
            &roots,
            candidates(),
        )),
        "session_file_not_indexed"
    );
    for path in [
        roots[0].join("directory.json"),
        roots[0].join("state.db"),
        roots[0].join("missing.json"),
    ] {
        if path.ends_with("directory.json") {
            fs::create_dir(&path).unwrap();
        } else if path.ends_with("state.db") {
            write_text(&path, "database");
        }
        assert_eq!(
            expect_string_err(resolve_session_file_ref_for_deletion(
                path.to_str().unwrap(),
                "cline",
                "task",
                &roots,
                candidates(),
            )),
            "invalid_session_file"
        );
    }
    assert_eq!(
        expect_string_err(resolve_session_file_ref_for_deletion(
            paths[0].to_str().unwrap(),
            "cline",
            " ",
            &roots,
            candidates(),
        )),
        "invalid_project_key"
    );
    assert_eq!(
        expect_string_err(resolve_session_file_ref_for_deletion(
            paths[0].to_str().unwrap(),
            "cline",
            "task",
            &[],
            candidates(),
        )),
        "history_source_not_found"
    );
}

// 拒绝直接删除子代理、目录和未开放来源；备份失败前不移除源文件。
#[test]
fn history_delete_rejects_invalid_targets_and_backup_failure() {
    let temp = TempDir::new().unwrap();
    let path = write_delete_fixture(temp.path(), "copilot", "session");
    let mut target = SessionFileRef {
        source: "copilot".into(),
        project_key: "session".into(),
        path: path.clone(),
    };
    let blocked_backup = temp.path().join("blocked-backup");
    write_text(&blocked_backup, "not a directory");
    assert!(delete_session_file_with_backup_root(&target, &blocked_backup).is_err());
    assert!(path.is_file());
    let backups = temp.path().join("backups");
    target.source = "opencode".into();
    assert_eq!(
        delete_session_file_with_backup_root(&target, &backups).unwrap_err(),
        "unsupported_history_mutation_source"
    );
    target.source = "copilot".into();
    target.path = temp.path().join("subagents/agent-child.jsonl");
    write_file(&target.path);
    assert_eq!(
        delete_session_file_with_backup_root(&target, &backups).unwrap_err(),
        "history_subagent_mutation_not_allowed"
    );
    target.path = temp.path().to_path_buf();
    assert_eq!(
        delete_session_file_with_backup_root(&target, &backups).unwrap_err(),
        "invalid_session_file"
    );
    target.path = temp.path().join("state.db");
    write_text(&target.path, "preserve database");
    assert_eq!(
        delete_session_file_with_backup_root(&target, &backups).unwrap_err(),
        "invalid_session_file"
    );
    assert_eq!(
        fs::read_to_string(&target.path).unwrap(),
        "preserve database"
    );
    assert!(!backups.exists());
}

// Windows 句柄允许读取但禁止删除，第二个目标失败时第一个目标必须完整回滚。
#[cfg(windows)]
#[test]
fn history_delete_locked_file_restores_previously_removed_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = TempDir::new().unwrap();
    let first = temp.path().join("first.jsonl");
    let locked = temp.path().join("locked.jsonl");
    write_text(&first, "first before");
    write_text(&locked, "locked before");
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&locked)
        .unwrap();
    let target = SessionFileRef {
        source: "claude".into(),
        project_key: "project".into(),
        path: first.clone(),
    };
    let error = delete_session_files_with_backup_root(
        &target,
        vec![first.clone(), locked.clone()],
        &temp.path().join("backups"),
    )
    .unwrap_err();
    assert!(error.starts_with("failedRolledBack:"), "{error}");
    assert_eq!(fs::read_to_string(&first).unwrap(), "first before");
    assert_eq!(fs::read_to_string(&locked).unwrap(), "locked before");
    drop(handle);
}

// 规范化后的实际目标越出来源根时，即使候选路径在根内也拒绝变更。
#[cfg(any(unix, windows))]
#[test]
fn history_delete_rejects_link_escape() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    let outside = write_delete_fixture(&temp.path().join("outside"), "cline", "task");
    #[cfg(unix)]
    let link = {
        let link = root.join("api_conversation_history.json");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        link
    };
    #[cfg(windows)]
    let link = {
        use std::os::windows::process::CommandExt;
        // Junction 无需开发者模式特权；路径经环境参数传递，脚本不拼接外部文本。
        let junction = root.join("linked-task");
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:CLI_MANAGER_TEST_LINK -Target $env:CLI_MANAGER_TEST_TARGET | Out-Null",
            ])
            .env("CLI_MANAGER_TEST_LINK", &junction)
            .env("CLI_MANAGER_TEST_TARGET", outside.parent().unwrap())
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        junction.join("api_conversation_history.json")
    };
    let candidate = SessionFileRef {
        source: "cline".into(),
        project_key: "task".into(),
        path: link.clone(),
    };
    assert_eq!(
        expect_string_err(resolve_session_file_ref_for_deletion(
            link.to_str().unwrap(),
            "cline",
            "task",
            &[root],
            vec![candidate],
        )),
        "session_file_outside_history_scope"
    );
    assert!(outside.is_file());
    #[cfg(windows)]
    fs::remove_dir(link.parent().unwrap()).unwrap();
}
