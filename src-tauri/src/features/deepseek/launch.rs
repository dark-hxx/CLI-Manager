use super::DeepSeekTuiLaunchInfo;

pub(super) const BRIDGE_SOURCE: &str = include_str!("../../../resources/deepseek-tui-bridge.mjs");
pub(super) const PRELOAD_SOURCE: &str =
    include_str!("../../../resources/deepseek-tui-react-preload.mjs");
pub(super) const BRIDGE_PATCH: &str =
    "- insert:\n    - id: cli-manager-deepseek-tui-bridge\n      name: ./bridge.mjs\n";
pub(super) const CMD_TEMPLATE: &str =
    include_str!("../../../resources/deepseek-tui-node-options.cmd");

pub(super) fn prepare_patch(cache: &std::path::Path) -> Result<DeepSeekTuiLaunchInfo, String> {
    use sha2::{Digest, Sha256};
    // Immutable content-addressed overlays are safe to share across concurrent PTYs.
    // The bridge obtains tab/session state from each PTY's environment, never this cache.
    let mut digest = Sha256::new();
    digest.update(BRIDGE_SOURCE.as_bytes());
    digest.update(BRIDGE_PATCH.as_bytes());
    digest.update(PRELOAD_SOURCE.as_bytes());
    digest.update(CMD_TEMPLATE.as_bytes());
    let directory = cache
        .join("deepseek-tui")
        .join(format!("{:x}", digest.finalize()));
    std::fs::create_dir_all(&directory).map_err(|_| "deepseek_tui_patch_failed")?;
    write_immutable(&directory.join("bridge.mjs"), BRIDGE_SOURCE.as_bytes())?;
    let patch = directory.join("bridge.yml");
    write_immutable(&patch, BRIDGE_PATCH.as_bytes())?;
    let preload = directory.join("react-preload.mjs");
    write_immutable(&preload, PRELOAD_SOURCE.as_bytes())?;
    let preload_url = url::Url::from_file_path(&preload)
        .map_err(|_| "deepseek_tui_patch_failed")?
        .to_string()
        .replace('!', "%21");
    let cmd_preload = directory.join("node-options.cmd");
    let cmd_source = CMD_TEMPLATE.replace("{{PRELOAD_URL}}", &preload_url.replace('%', "%%"));
    write_immutable(&cmd_preload, cmd_source.as_bytes())?;
    Ok(DeepSeekTuiLaunchInfo {
        patch_path: patch.to_string_lossy().into_owned(),
        preload_path: preload.to_string_lossy().into_owned(),
        preload_url,
        cmd_preload_path: cmd_preload.to_string_lossy().into_owned(),
    })
}

/// Publish complete files atomically; a second launch may reuse the same content.
fn write_immutable(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    use std::io::{Read, Write};
    let matches = || {
        let file = std::fs::File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(content.len() as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        Some(bytes == content)
    };
    if matches() == Some(true) {
        return Ok(());
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "deepseek_tui_patch_failed".to_string())?;
        file.write_all(content)
            .map_err(|_| "deepseek_tui_patch_failed")?;
        file.sync_all().map_err(|_| "deepseek_tui_patch_failed")?;
        drop(file);
        match std::fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(_) if matches() == Some(true) => Ok(()),
            Err(_) => Err("deepseek_tui_patch_failed".into()),
        }
    })();
    let _ = std::fs::remove_file(temporary);
    result
}
