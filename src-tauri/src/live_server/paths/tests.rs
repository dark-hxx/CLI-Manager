use std::fs;

use tempfile::tempdir;

use super::{build_page_url, resolve_request_file, validate_start_request};

#[test]
fn validates_html_entry_and_encodes_unicode_url() {
    let temp = tempdir().unwrap();
    let relative = "页面 files/首页.html";
    fs::create_dir(temp.path().join("页面 files")).unwrap();
    fs::write(temp.path().join(relative), "<html></html>").unwrap();

    let validated = validate_start_request(temp.path().to_str().unwrap(), relative).unwrap();
    assert_eq!(validated.relative_path, relative);
    assert_eq!(
        build_page_url("http://127.0.0.1:1234", relative),
        "http://127.0.0.1:1234/%E9%A1%B5%E9%9D%A2%20files/%E9%A6%96%E9%A1%B5.html"
    );
}

#[test]
fn rejects_invalid_entry_paths() {
    let temp = tempdir().unwrap();
    fs::write(temp.path().join("index.html"), "ok").unwrap();
    let root = temp.path().to_str().unwrap();

    assert_error(root, "../index.html", "path_contains_parent_segment");
    assert_error(root, "./index.html", "path_contains_current_segment");
    assert_error(root, "nested\\index.html", "path_contains_backslash");
    assert_error(root, "index.txt", "entry_not_html");
    assert_error(root, "missing.html", "entry_not_found");
}

#[test]
fn resolves_index_and_rejects_encoded_traversal() {
    let temp = tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("index.html"), "root").unwrap();
    fs::write(root.join("nested/index.html"), "nested").unwrap();

    assert_eq!(
        resolve_request_file(&root, "/").unwrap(),
        root.join("index.html")
    );
    assert_eq!(
        resolve_request_file(&root, "/nested/").unwrap(),
        root.join("nested/index.html")
    );
    assert_eq!(
        resolve_request_file(&root, "/%2e%2e/secret.txt").unwrap_err(),
        "path_contains_parent_segment"
    );
}

fn assert_error(root: &str, relative: &str, expected: &str) {
    assert_eq!(
        validate_start_request(root, relative).unwrap_err(),
        expected
    );
}
