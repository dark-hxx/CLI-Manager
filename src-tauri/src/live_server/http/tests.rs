use super::{find_ascii_case_insensitive, inject_reload_script, reload_script, RELOAD_ENDPOINT};

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
