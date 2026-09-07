use std::fs;

use tempfile::tempdir;

use super::{
    find_ascii_case_insensitive, inject_reload_script, load_asset, reload_script,
    reload_version_for_asset, AssetContents, MAX_HTML_BYTES, RELOAD_ENDPOINT,
};
use crate::live_server::paths::open_root_dir;

#[test]
fn injects_reload_script_before_case_insensitive_body_close() {
    let html = b"<HTML><BODY>Hello</BoDy></HTML>".to_vec();
    let injected = String::from_utf8(inject_reload_script(html, 7)).unwrap();
    let script = injected.find("data-cli-manager-live-server").unwrap();
    let body_close = injected.to_ascii_lowercase().find("</body>").unwrap();
    assert!(script < body_close);
    assert!(injected.contains(RELOAD_ENDPOINT));
    assert!(injected.contains("version=\"7\""));
}

#[test]
fn appends_reload_script_when_body_close_is_missing() {
    let injected = inject_reload_script(b"<main>Hello</main>".to_vec(), 3);
    assert!(injected.ends_with(&reload_script(3)));
}

#[test]
fn finds_ascii_without_case_sensitivity() {
    assert_eq!(find_ascii_case_insensitive(b"abcDEF", b"CdE"), Some(2));
    assert_eq!(find_ascii_case_insensitive(b"abc", b"xyz"), None);
}

#[test]
fn keeps_the_pre_read_version_when_a_change_overlaps_loading() {
    assert_eq!(reload_version_for_asset(7, 7), 7);
    assert_eq!(reload_version_for_asset(7, 8), 7);
}

#[test]
fn streams_non_html_assets_and_limits_html_buffering() {
    let temp = tempdir().unwrap();
    fs::write(temp.path().join("asset.bin"), vec![0x5a; 1024 * 1024]).unwrap();
    fs::write(
        temp.path().join("large.html"),
        vec![b'x'; (MAX_HTML_BYTES + 1) as usize],
    )
    .unwrap();
    let root = open_root_dir(&temp.path().canonicalize().unwrap()).unwrap();

    let asset = load_asset(&root, "/asset.bin", false).unwrap();
    assert!(matches!(asset.contents, AssetContents::File(_)));
    assert_eq!(asset.content_length, 1024 * 1024);
    assert!(matches!(
        load_asset(&root, "/large.html", false),
        Err(error) if error == "asset_too_large"
    ));
}
