pub(super) use cli_manager_core::clipboard_image::{decode, encode_png, MAX_BYTES};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use cli_manager_core::clipboard_image::{first_decodable, MAX_NATIVE_BYTES};
#[cfg(target_os = "windows")]
#[path = "clipboard_image_windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "clipboard_image_macos.rs"]
pub(super) mod platform;

pub(super) fn read(app: &tauri::AppHandle) -> Result<Option<image::DynamicImage>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let _ = app;
        platform::read()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        use cli_manager_core::clipboard_image::validate_dimensions;
        use tauri_plugin_clipboard_manager::ClipboardExt;
        match app.clipboard().read_image() {
            Ok(image) => {
                validate_dimensions(image.width(), image.height())?;
                let buffer = image::RgbaImage::from_raw(image.width(), image.height(), image.rgba().to_vec())
                    .ok_or("clipboard_image_rgba_length_invalid")?;
                Ok(Some(image::DynamicImage::ImageRgba8(buffer)))
            }
            Err(err) if err.to_string() == "The clipboard contents were not available in the requested format or the clipboard is empty." => Ok(None),
            Err(_) => Err("clipboard_image_read_failed".into()),
        }
    }
}

#[cfg(test)]
#[path = "clipboard_image_tests.rs"]
mod tests;
