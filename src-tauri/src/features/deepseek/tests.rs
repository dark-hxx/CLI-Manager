use super::launch::{prepare_patch, BRIDGE_PATCH, BRIDGE_SOURCE, CMD_TEMPLATE, PRELOAD_SOURCE};
use super::*;
use std::fs;
use std::path::Path;

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn environment(root: &Path) -> HashMap<String, String> {
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    fs::write(bin.join(format!("node{suffix}")), "not executed").unwrap();
    fs::write(bin.join(format!("dsh{suffix}")), "not executed").unwrap();
    fs::write(bin.join(format!("dsh-tui{suffix}")), "not executed").unwrap();
    HashMap::from([
        ("PATH".into(), bin.to_string_lossy().into_owned()),
        (
            "DSH_HOME".into(),
            root.join("home").to_string_lossy().into_owned(),
        ),
    ])
}

fn profile(root: &Path) {
    let profile = root.join("home/profiles/dsh-tui");
    write(
        &profile.join("package.json"),
        r#"{"dsh":{"profile":{"bundles":["@deepseek-harness-tui/dsh-tui"]}}}"#,
    );
    let package = profile.join("node_modules/@deepseek-harness-tui/dsh-tui");
    write(
        &package.join("package.json"),
        r#"{"name":"@deepseek-harness-tui/dsh-tui","version":"0.12.0","main":"lib/types/index.js","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}"#,
    );
    write(&package.join("lib/types/index.js"), "// never imported");
    write(
        &package.join("lib/types/adapter/channel/host-registry.js"),
        "// never imported",
    );
    write(&package.join("cordis.patch.yml"), "[]");
}

#[test]
fn source_tui_preflight_needs_host_and_plugin_artifacts_without_web() {
    let root = tempfile::tempdir().unwrap();
    let env = environment(root.path());
    profile(root.path());
    let host = root.path().join("host source");
    write(
        &host.join("package.json"),
        r#"{"name":"@deepseek-ai/dsh-root","version":"0.1.7-rc.2"}"#,
    );
    assert_eq!(
        preflight::inspect(Some(host.to_str().unwrap()), &env).unwrap_err(),
        "deepseek_source_unbuilt"
    );
    write(
        &host.join("apps/cli/lib/bin.js"),
        "throw new Error('must never run')",
    );
    fs::create_dir_all(host.join("node_modules")).unwrap();
    // Source-host advanced mode does not depend on global host/launcher commands.
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    fs::remove_file(root.path().join(format!("bin/dsh{suffix}"))).unwrap();
    fs::remove_file(root.path().join(format!("bin/dsh-tui{suffix}"))).unwrap();
    let info = preflight::inspect(Some(host.to_str().unwrap()), &env).unwrap();
    assert_eq!(info.version, "0.1.7-rc.2");
    assert_eq!(info.profile_version, "0.12.0");
    assert!(info.host_entry_path.unwrap().ends_with("bin.js"));
    assert!(!host.join("apps/web").exists());
}

#[test]
fn profile_must_mount_an_existing_built_tui_bundle() {
    let root = tempfile::tempdir().unwrap();
    let env = environment(root.path());
    assert_eq!(
        preflight::inspect(None, &env).unwrap_err(),
        "deepseek_tui_profile_missing"
    );
    profile(root.path());
    assert!(preflight::inspect(None, &env).is_ok());
    let package = root
        .path()
        .join("home/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui");
    fs::remove_file(package.join("lib/types/index.js")).unwrap();
    assert_eq!(
        preflight::inspect(None, &env).unwrap_err(),
        "deepseek_tui_profile_unbuilt"
    );
    write(&package.join("lib/types/index.js"), "");
    write(
        &root.path().join("home/profiles/dsh-tui/package.json"),
        r#"{"dsh":{"profile":{"bundles":[]}}}"#,
    );
    assert_eq!(
        preflight::inspect(None, &env).unwrap_err(),
        "deepseek_tui_profile_missing"
    );
}

#[test]
fn preflight_rejects_invalid_roots_missing_commands_and_oversized_metadata() {
    let root = tempfile::tempdir().unwrap();
    let mut env = environment(root.path());
    profile(root.path());
    assert_eq!(
        preflight::inspect(Some("relative"), &env).unwrap_err(),
        "deepseek_source_invalid"
    );
    let host = root.path().join("host");
    write(&host.join("package.json"), &" ".repeat(65537));
    assert_eq!(
        preflight::inspect(Some(host.to_str().unwrap()), &env).unwrap_err(),
        "deepseek_source_invalid"
    );
    env.insert("PATH".into(), String::new());
    assert_eq!(
        preflight::inspect(None, &env).unwrap_err(),
        "deepseek_tui_node_missing"
    );
    env = environment(root.path());
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    fs::remove_file(root.path().join(format!("bin/dsh{suffix}"))).unwrap();
    assert_eq!(
        preflight::inspect(None, &env).unwrap_err(),
        "deepseek_tui_host_missing"
    );
    env = environment(root.path());
    env.insert("DSH_HOME".into(), "relative".into());
    assert_eq!(
        preflight::inspect(None, &env).unwrap_err(),
        "deepseek_tui_home_invalid"
    );
}

#[test]
fn metadata_preflight_does_not_install_or_mutate_profile() {
    let root = tempfile::tempdir().unwrap();
    let env = environment(root.path());
    profile(root.path());
    let manifest = root.path().join("home/profiles/dsh-tui/package.json");
    let original = fs::read(&manifest).unwrap();
    preflight::inspect(None, &env).unwrap();
    assert_eq!(fs::read(&manifest).unwrap(), original);
    assert!(!root
        .path()
        .join("home/profiles/dsh-tui/cordis.yml")
        .exists());
}

#[test]
fn bridge_cache_publication_is_complete_and_shared_without_tab_state() {
    let root = tempfile::Builder::new()
        .prefix("dsh cache space !")
        .tempdir()
        .unwrap();
    let paths: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| prepare_patch(root.path()).unwrap()))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    assert!(paths.iter().all(|info| {
        info.patch_path == paths[0].patch_path
            && info.preload_path == paths[0].preload_path
            && info.preload_url == paths[0].preload_url
            && info.cmd_preload_path == paths[0].cmd_preload_path
    }));
    let patch = std::path::Path::new(&paths[0].patch_path);
    assert_eq!(fs::read_to_string(patch).unwrap(), BRIDGE_PATCH);
    let directory = patch.parent().unwrap();
    assert_eq!(
        fs::read_to_string(directory.join("bridge.mjs")).unwrap(),
        BRIDGE_SOURCE
    );
    let preload = std::path::Path::new(&paths[0].preload_path);
    assert_eq!(preload.parent(), Some(directory));
    assert_eq!(fs::read_to_string(preload).unwrap(), PRELOAD_SOURCE);
    assert_eq!(
        url::Url::parse(&paths[0].preload_url)
            .unwrap()
            .to_file_path()
            .unwrap(),
        preload
    );
    assert!(paths[0].preload_url.contains("%20"));
    let cmd_preload = std::path::Path::new(&paths[0].cmd_preload_path);
    assert_eq!(cmd_preload.parent(), Some(directory));
    assert_eq!(
        fs::read_to_string(cmd_preload).unwrap(),
        CMD_TEMPLATE.replace("{{PRELOAD_URL}}", &paths[0].preload_url.replace('%', "%%")),
    );
    assert!(!paths[0].preload_url.contains('!'));
    assert!(paths[0].preload_url.contains("%21"));
    let cmd_contents = fs::read_to_string(cmd_preload).unwrap();
    assert!(cmd_contents.contains("%%21"));
    assert!(!cmd_contents.contains("space%%20!"));
    assert_eq!(fs::read_dir(directory).unwrap().count(), 4);
    assert_eq!(
        fs::read_dir(root.path().join("deepseek-tui"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn bridge_preflight_rejects_missing_registry_and_other_release_lines() {
    let root = tempfile::tempdir().unwrap();
    let env = environment(root.path());
    profile(root.path());
    let package = root
        .path()
        .join("home/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui");
    fs::remove_file(package.join("lib/types/adapter/channel/host-registry.js")).unwrap();
    assert!(
        preflight::inspect(None, &env).is_ok(),
        "native launcher does not use the private registry"
    );
    assert_eq!(
        preflight::inspect_bridge(None, &env).unwrap_err(),
        "deepseek_tui_bridge_unsupported"
    );
    write(
        &package.join("lib/types/adapter/channel/host-registry.js"),
        "",
    );
    let manifest = fs::read_to_string(package.join("package.json"))
        .unwrap()
        .replace("0.12.0", "0.13.0");
    fs::write(package.join("package.json"), manifest).unwrap();
    assert_eq!(
        preflight::inspect(None, &env).unwrap().profile_version,
        "0.13.0"
    );
    assert_eq!(
        preflight::inspect_bridge(None, &env).unwrap_err(),
        "deepseek_tui_bridge_unsupported"
    );
}

#[test]
fn installed_preflight_distinguishes_missing_tui_launcher() {
    let root = tempfile::tempdir().unwrap();
    let env = environment(root.path());
    profile(root.path());
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    fs::remove_file(root.path().join(format!("bin/dsh-tui{suffix}"))).unwrap();
    assert_eq!(
        preflight::inspect(None, &env).unwrap_err(),
        "deepseek_tui_launcher_missing"
    );
}
