use super::*;
use image::{DynamicImage, ImageFormat};
use std::io::Cursor;
// 用真实编码器构造平台可能提供的 PNG/TIFF/BMP，而非只断言实现字符串。
fn encoded(format: ImageFormat) -> Vec<u8> {
    let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        3,
        2,
        image::Rgba([12, 34, 56, 255]),
    ));
    let mut output = Cursor::new(Vec::new());
    image.write_to(&mut output, format).unwrap();
    output.into_inner()
}

// 旧 5 MiB 以上到新边界的文件可进入标准化；超过边界在读取/解码前拒绝。
#[test]
fn clipboard_image_file_accepts_20mib_and_rejects_one_byte_more() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("capture.png");
    let attachments = dir.path().join("attachments");
    std::fs::create_dir(&attachments).unwrap();
    for size in [6 * 1024 * 1024, MAX_BYTES, MAX_BYTES + 1] {
        let mut bytes = encoded(ImageFormat::Png);
        bytes.resize(size, 0);
        std::fs::write(&source, bytes).unwrap();
        let result = super::super::convert_clipboard_image_file(&source, &attachments);
        if size > MAX_BYTES {
            assert_eq!(result.unwrap_err(), "clipboard_image_too_large");
        } else {
            assert_eq!(image::image_dimensions(result.unwrap()).unwrap(), (3, 2));
        }
    }
}
