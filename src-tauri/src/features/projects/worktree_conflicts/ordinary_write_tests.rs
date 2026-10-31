use std::fs;
use crate::commands::git::{git_stage_file, git_unstage_all, git_unstage_file, git_unstage_paths};
use super::{file_io, session_tests::{git, Fixture}};

#[tokio::test]
async fn ordinary_unstage_commands_preserve_work_files_on_clean_and_unborn_branches() {
    let fixture = Fixture::new(1);
    let unborn = fixture.root.join("unborn");
    fs::create_dir_all(&unborn).unwrap();
    git(&unborn, &["init", "-b", "main"]);
    for root in [&fixture.worktree, &unborn] {
        let project = root.to_string_lossy().into_owned();
        let name = "new-file.txt";
        fs::write(root.join(name), b"keep local content\n").unwrap();
        for kind in 0..3 {
            git_stage_file(project.clone(), name.into()).await.unwrap();
            match kind {
                0 => git_unstage_file(project.clone(), name.into()).await.unwrap(),
                1 => git_unstage_paths(project.clone(), vec![name.into()]).await.unwrap(),
                _ => git_unstage_all(project.clone()).await.unwrap(),
            }
            assert!(git(root, &["diff", "--cached", "--name-only"]).is_empty());
            assert_eq!(fs::read(root.join(name)).unwrap(), b"keep local content\n");
        }
    }
}

#[tokio::test]
async fn ordinary_unstage_commands_never_remove_managed_conflict_stages() {
    let fixture = Fixture::new(1); fixture.prepare();
    let project = fixture.worktree.to_string_lossy().into_owned();
    let repo = git2::Repository::open(&fixture.worktree).unwrap();
    let before = file_io::fingerprint(&repo.path().join("index")).unwrap();
    let work = fs::read(fixture.worktree.join("file-0000.txt")).unwrap();
    assert!(git_unstage_file(project.clone(), "file-0000.txt".into()).await.is_err());
    assert!(git_unstage_paths(project.clone(), vec!["file-0000.txt".into()]).await.is_err());
    assert!(git_unstage_all(project).await.is_err());
    assert_eq!(file_io::fingerprint(&repo.path().join("index")).unwrap(), before);
    assert_eq!(fs::read(fixture.worktree.join("file-0000.txt")).unwrap(), work);
    assert!(repo.path().join("MERGE_HEAD").exists());
}
