use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use cli_manager_web_protocol::{DeviceHostInfo, DeviceWallpaperUpload};
use display_info::DisplayInfo;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use std::path::{Path, PathBuf};
use std::process::Command;
use sysinfo::System;
use url::Url;
use uuid::Uuid;

const WALLPAPER_WIDTH: u32 = 480;
const WALLPAPER_HEIGHT: u32 = 270;
const WALLPAPER_QUALITY: u8 = 76;

pub struct DeviceIdentity {
    pub host_info: DeviceHostInfo,
    pub wallpaper: Option<DeviceWallpaperUpload>,
}

pub fn collect(upload_wallpaper: bool) -> DeviceIdentity {
    DeviceIdentity {
        host_info: collect_host_info(),
        wallpaper: upload_wallpaper
            .then(collect_wallpaper)
            .and_then(Result::ok),
    }
}

fn collect_host_info() -> DeviceHostInfo {
    let mut system = System::new_all();
    system.refresh_all();
    let display = DisplayInfo::all()
        .ok()
        .and_then(|displays| {
            displays
                .iter()
                .find(|display| display.is_primary)
                .or_else(|| displays.first())
                .map(|display| (display.width, display.height))
        })
        .unwrap_or((1, 1));
    DeviceHostInfo {
        host_name: System::host_name().unwrap_or_else(|| "Unknown host".to_string()),
        os_version: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
        cpu_arch: System::cpu_arch(),
        cpu_model: system
            .cpus()
            .first()
            .map(|cpu| cpu.brand().trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Unknown CPU".to_string()),
        total_memory_bytes: system.total_memory(),
        display_width: display.0,
        display_height: display.1,
    }
}

fn collect_wallpaper() -> Result<DeviceWallpaperUpload, String> {
    let raw_path = wallpaper::get().map_err(|error| format!("read system wallpaper: {error}"))?;
    let path = wallpaper_path(&raw_path)?;
    let image = load_wallpaper_image(&path)?;
    let thumbnail = image.resize_to_fill(WALLPAPER_WIDTH, WALLPAPER_HEIGHT, FilterType::Lanczos3);
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, WALLPAPER_QUALITY)
        .encode_image(&thumbnail)
        .map_err(|error| format!("encode wallpaper thumbnail: {error}"))?;
    Ok(DeviceWallpaperUpload {
        mime_type: "image/jpeg".to_string(),
        data_base64: STANDARD.encode(bytes),
        width: WALLPAPER_WIDTH,
        height: WALLPAPER_HEIGHT,
    })
}

fn wallpaper_path(raw: &str) -> Result<PathBuf, String> {
    if raw.starts_with("file:") {
        return Url::parse(raw)
            .map_err(|error| format!("parse wallpaper URI: {error}"))?
            .to_file_path()
            .map_err(|_| "wallpaper URI is not a local file".to_string());
    }
    Ok(PathBuf::from(raw))
}

fn load_wallpaper_image(path: &Path) -> Result<image::DynamicImage, String> {
    match image::open(path) {
        Ok(image) => Ok(image),
        Err(original_error) if cfg!(target_os = "macos") => {
            let temporary =
                std::env::temp_dir().join(format!("cli-manager-wallpaper-{}.jpg", Uuid::new_v4()));
            let status = Command::new("sips")
                .args(["-s", "format", "jpeg"])
                .arg(path)
                .arg("--out")
                .arg(&temporary)
                .status()
                .map_err(|error| format!("convert macOS wallpaper: {error}"))?;
            if !status.success() {
                return Err(format!("decode wallpaper: {original_error}"));
            }
            let converted = image::open(&temporary)
                .map_err(|error| format!("decode converted wallpaper: {error}"));
            let _ = std::fs::remove_file(temporary);
            converted
        }
        Err(error) => Err(format!("decode wallpaper: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uri_decodes_escaped_path() {
        let path = wallpaper_path("file:///tmp/My%20Wallpaper.jpg").unwrap();
        assert!(path.to_string_lossy().contains("My Wallpaper.jpg"));
    }
}
