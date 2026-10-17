use super::*;

#[test]
// 驗證索引刷新做全量強制掃描後，依來源讀取的目錄快取也看得到新出現的會話檔（例如 /clear 之後）。
fn full_scan_refreshes_per_source_session_file_cache() {
    let temp_dir = TempDir::new().unwrap();
    let claude = temp_dir.path().join(".claude");
    let project = claude.join("projects").join("proj");
    let roots = history_roots(Some(claude.to_string_lossy().into_owned()), None, None);
    write_file(&project.join("old.jsonl"));
    assert_eq!(collect_session_files(Some("claude"), &roots).len(), 1);

    write_file(&project.join("new.jsonl"));
    // 有效期內依來源讀取照舊沿用快取。
    assert_eq!(collect_session_files(Some("claude"), &roots).len(), 1);

    let all = collect_session_files_with_force(None, &roots, true);
    assert!(all.iter().any(|file| file.path.ends_with("new.jsonl")));
    let claude_files = collect_session_files(Some("claude"), &roots);
    assert_eq!(claude_files.len(), 2);
    assert!(claude_files
        .iter()
        .any(|file| file.path.ends_with("new.jsonl")));
}
