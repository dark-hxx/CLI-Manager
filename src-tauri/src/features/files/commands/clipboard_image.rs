//! 终端图片附件预算与标准化；文件预览和旧 SSH 协议保持各自上限。
use image::{DynamicImage, ImageDecoder, ImageFormat};
use std::io::Cursor;

pub(super) const MAX_BYTES: usize = 20 * 1024 * 1024;
pub(super) const MAX_PIXELS: u64 = 40_000_000;
pub(super) const MAX_NATIVE_BYTES: usize = MAX_PIXELS as usize * 4 + 1024 * 1024;

#[cfg(target_os = "windows")]
#[path = "clipboard_image_windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "clipboard_image_macos.rs"]
pub(super) mod platform;

// 在解码与分配像素前检查 dimensions；与预览预算分离。
pub(super) fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("clipboard_image_dimensions_invalid".into());
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("clipboard_image_dimensions_too_large".into());
    }
    Ok(())
}

// 所有来源都先验真实图像尺寸并应用 EXIF 方向；不以文件名/MIME 代替解码。
pub(super) fn decode(bytes: &[u8], dib: bool) -> Result<DynamicImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_NATIVE_BYTES {
        return Err("clipboard_image_too_large".into());
    }
    if dib {
        let bmp = super::clipboard_dib::to_bmp(bytes)?;
        let decoder = image::codecs::bmp::BmpDecoder::new(Cursor::new(bmp))
            .map_err(|_| "clipboard_image_unsupported")?;
        let (width, height) = decoder.dimensions();
        validate_dimensions(width, height)?;
        return DynamicImage::from_decoder(decoder)
            .map_err(|_| "clipboard_image_unsupported".into());
    }
    let mut decoder = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "clipboard_image_unsupported")?
        .into_decoder()
        .map_err(|_| "clipboard_image_unsupported")?;
    let (width, height) = decoder.dimensions();
    validate_dimensions(width, height)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|_| "clipboard_image_unsupported")?;
    image.apply_orientation(orientation);
    Ok(image)
}

// PNG 过大时按比例缩小，保持既有文件截图行为；返回值严格限制为 20 MiB。
pub(super) fn encode_png(mut image: DynamicImage) -> Result<Vec<u8>, String> {
    validate_dimensions(image.width(), image.height())?;
    for _ in 0..5 {
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, ImageFormat::Png)
            .map_err(|_| "clipboard_image_png_encode_failed")?;
        let bytes = png.into_inner();
        if bytes.len() <= MAX_BYTES {
            return Ok(bytes);
        }
        let scale = (MAX_BYTES as f64 / bytes.len() as f64).sqrt() * 0.9;
        let width = ((f64::from(image.width()) * scale) as u32).max(1);
        let height = ((f64::from(image.height()) * scale) as u32).max(1);
        image = image.resize(width, height, image::imageops::FilterType::Lanczos3);
    }
    Err("clipboard_image_too_large".into())
}

// 同一剪贴板的优先格式损坏时尝试其他表示，全部失败才报告首个错误。
pub(super) fn first_decodable(
    candidates: impl IntoIterator<Item = Result<(Vec<u8>, bool), String>>,
) -> Result<Option<DynamicImage>, String> {
    let mut error = None;
    for candidate in candidates {
        match candidate.and_then(|(bytes, dib)| decode(&bytes, dib)) {
            Ok(image) => return Ok(Some(image)),
            Err(err) => {
                error.get_or_insert(err);
            }
        }
    }
    match error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

// 原始像素留在后端，避免大 RGBA 经 WebView IPC 来回复制。
pub(super) fn read(app: &tauri::AppHandle) -> Result<Option<DynamicImage>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let _ = app;
        platform::read()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        match app.clipboard().read_image() {
            Ok(image) => {
                validate_dimensions(image.width(), image.height())?;
                let buffer = image::RgbaImage::from_raw(image.width(), image.height(), image.rgba().to_vec())
                    .ok_or("clipboard_image_rgba_length_invalid")?;
                Ok(Some(DynamicImage::ImageRgba8(buffer)))
            }
            Err(err) if err.to_string() == "The clipboard contents were not available in the requested format or the clipboard is empty." => Ok(None),
            Err(_) => Err("clipboard_image_read_failed".into()),
        }
    }
}

#[cfg(test)]
#[path = "clipboard_image_tests.rs"]
mod tests;
