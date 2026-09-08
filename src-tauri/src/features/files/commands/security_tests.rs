use super::*;
use std::fs;
use tempfile::TempDir;

#[test]
fn overwrite_move_rejects_the_same_source_without_deleting_it() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("same.txt");
    fs::write(&source, "preserve me").unwrap();
    let root = root.canonicalize().unwrap();
    let source = source.canonicalize().unwrap();

    assert_eq!(
        move_path(&root, &source, &source, true).unwrap_err(),
        "source_equals_target"
    );
    assert_eq!(fs::read_to_string(source).unwrap(), "preserve me");
}

#[test]
// 验证写入目标检查拒绝指向已有文件的符号链接。
fn file_write_rejects_symlink_targets() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("real.txt"), "real").unwrap();
    let root = root.canonicalize().unwrap();
    let link = root.join("link.txt");

    #[cfg(unix)]
    if std::os::unix::fs::symlink(root.join("real.txt"), &link).is_err() {
        return;
    }
    #[cfg(target_os = "windows")]
    if std::os::windows::fs::symlink_file(root.join("real.txt"), &link).is_err() {
        return;
    }

    assert_eq!(
        ensure_target_safe_for_write(&root, &link).unwrap_err(),
        "path_is_symlink"
    );
}

#[test]
// 验证递归复制拒绝源目录中的符号链接。
fn copy_rejects_nested_symlink_sources() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("real.txt"), "real").unwrap();
    let root = root.canonicalize().unwrap();
    let link = root.join("src").join("link.txt");

    #[cfg(unix)]
    if std::os::unix::fs::symlink(root.join("real.txt"), &link).is_err() {
        return;
    }
    #[cfg(target_os = "windows")]
    if std::os::windows::fs::symlink_file(root.join("real.txt"), &link).is_err() {
        return;
    }

    let err = copy_path(&root, &root.join("src"), &root.join("dst")).unwrap_err();
    assert_eq!(err, "path_is_symlink");
}
