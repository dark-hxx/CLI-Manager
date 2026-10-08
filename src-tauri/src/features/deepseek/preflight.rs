use super::DeepSeekTuiInfo;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

const TUI_PACKAGE: &str = "@deepseek-harness-tui/dsh-tui";

/// Read bounded metadata only; a selected package is never imported or executed here.
fn manifest(path: &Path, error: &str) -> Result<Value, String> {
    let metadata = path.metadata().map_err(|_| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(error.into());
    }
    let file = std::fs::File::open(path).map_err(|_| error.to_string())?;
    let mut reader = std::io::Read::take(file, 64 * 1024 + 1);
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut reader, &mut bytes).map_err(|_| error.to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err(error.into());
    }
    serde_json::from_slice(&bytes).map_err(|_| error.to_string())
}

fn env_value(env: &HashMap<String, String>, key: &str) -> Option<String> {
    let matched = env.iter().find(|(name, _)| {
        if cfg!(windows) {
            name.eq_ignore_ascii_case(key)
        } else {
            name.as_str() == key
        }
    });
    matched
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var(key).ok())
}

/// Match the native launch environment, avoiding current-directory PATH entries.
fn has_command(env: &HashMap<String, String>, name: &str) -> bool {
    let Some(path) = env_value(env, "PATH") else {
        return false;
    };
    let extensions = if cfg!(windows) {
        vec![".exe", ".com", ".cmd", ".bat"]
    } else {
        vec![""]
    };
    std::env::split_paths(&path)
        .filter(|path| path.is_absolute())
        .any(|directory| {
            extensions
                .iter()
                .any(|extension| directory.join(format!("{name}{extension}")).is_file())
        })
}

fn user_home(env: &HashMap<String, String>) -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env_value(env, key)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn dsh_home(env: &HashMap<String, String>) -> Result<PathBuf, String> {
    let home = user_home(env);
    let selected = env_value(env, "DSH_HOME").filter(|value| !value.trim().is_empty());
    let path = match selected {
        None => home.ok_or("deepseek_tui_home_invalid")?.join(".dsh"),
        Some(value) if value == "~" => home.ok_or("deepseek_tui_home_invalid")?,
        Some(value) if value.starts_with("~/") || value.starts_with("~\\") => {
            home.ok_or("deepseek_tui_home_invalid")?.join(&value[2..])
        }
        Some(value) => PathBuf::from(value),
    };
    if !path.is_absolute() {
        return Err("deepseek_tui_home_invalid".into());
    }
    Ok(path)
}

fn package_file(root: &Path, relative: &str) -> bool {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return false;
    }
    root.join(path).is_file()
}

fn inspect_host(root: &str) -> Result<(String, String), String> {
    let path = Path::new(root);
    if !path.is_absolute() {
        return Err("deepseek_source_invalid".into());
    }
    let path = path.canonicalize().map_err(|_| "deepseek_source_invalid")?;
    let package = manifest(&path.join("package.json"), "deepseek_source_invalid")?;
    if package["name"].as_str() != Some("@deepseek-ai/dsh-root") {
        return Err("deepseek_source_invalid".into());
    }
    let entry = path.join("apps/cli/lib/bin.js");
    if !entry.is_file() || !path.join("node_modules").is_dir() {
        return Err("deepseek_source_unbuilt".into());
    }
    Ok((
        entry.to_string_lossy().into_owned(),
        package["version"].as_str().unwrap_or("").into(),
    ))
}

fn inspect_profile(home: &Path, require_bridge: bool) -> Result<String, String> {
    let profile = home.join("profiles/dsh-tui");
    let config = manifest(
        &profile.join("package.json"),
        "deepseek_tui_profile_missing",
    )?;
    let mounted = config
        .pointer("/dsh/profile/bundles")
        .and_then(Value::as_array)
        .map(|bundles| {
            bundles
                .iter()
                .any(|name| name.as_str() == Some(TUI_PACKAGE))
        })
        .unwrap_or(false);
    if !mounted {
        return Err("deepseek_tui_profile_missing".into());
    }
    let root = profile.join("node_modules/@deepseek-harness-tui/dsh-tui");
    let package = manifest(&root.join("package.json"), "deepseek_tui_profile_unbuilt")?;
    if package["name"].as_str() != Some(TUI_PACKAGE) {
        return Err("deepseek_tui_profile_unbuilt".into());
    }
    let entry = package
        .pointer("/exports/./import")
        .and_then(Value::as_str)
        .or_else(|| package["main"].as_str())
        .unwrap_or("lib/types/index.js");
    let patches = package
        .pointer("/dsh/bundle/patch")
        .ok_or("deepseek_tui_profile_unbuilt")?;
    let patch_ready = match patches {
        Value::String(patch) => package_file(&root, patch),
        Value::Array(patches) if !patches.is_empty() && patches.len() <= 16 => patches
            .iter()
            .all(|patch| patch.as_str().is_some_and(|path| package_file(&root, path))),
        _ => false,
    };
    if !package_file(&root, entry) || !patch_ready {
        return Err("deepseek_tui_profile_unbuilt".into());
    }
    let version = package["version"]
        .as_str()
        .filter(|version| !version.is_empty() && version.len() <= 128)
        .ok_or("deepseek_tui_profile_unbuilt")?;
    let compatible = regex::Regex::new(r"^0\.12\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
        .expect("static TUI version pattern");
    if require_bridge
        && (!compatible.is_match(version)
            || !root
                .join("lib/types/adapter/channel/host-registry.js")
                .is_file())
    {
        return Err("deepseek_tui_bridge_unsupported".into());
    }
    Ok(version.into())
}

/// Validate the existing official host and installed TUI bundle; Web artifacts are irrelevant.
pub(super) fn inspect(
    source_root: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<DeepSeekTuiInfo, String> {
    inspect_with_bridge(source_root, env, false)
}

pub(super) fn inspect_bridge(
    source_root: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<DeepSeekTuiInfo, String> {
    inspect_with_bridge(source_root, env, true)
}

fn inspect_with_bridge(
    source_root: Option<&str>,
    env: &HashMap<String, String>,
    require_bridge: bool,
) -> Result<DeepSeekTuiInfo, String> {
    let host = source_root
        .filter(|value| !value.trim().is_empty())
        .map(inspect_host)
        .transpose()?;
    if !has_command(env, "node") {
        return Err("deepseek_tui_node_missing".into());
    }
    if host.is_none() && !has_command(env, "dsh") {
        return Err("deepseek_tui_host_missing".into());
    }
    if host.is_none() && !has_command(env, "dsh-tui") {
        return Err("deepseek_tui_launcher_missing".into());
    }
    let profile_version = inspect_profile(&dsh_home(env)?, require_bridge)?;
    let (host_entry_path, version) = host
        .map(|(entry, version)| (Some(entry), version))
        .unwrap_or((None, String::new()));
    Ok(DeepSeekTuiInfo {
        host_entry_path,
        version,
        profile_version,
        manager_patch_path: None,
    })
}
