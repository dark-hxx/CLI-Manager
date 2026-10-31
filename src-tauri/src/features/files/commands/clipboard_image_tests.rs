use super::*;

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

#[test]
fn png_tiff_and_dib_normalize_to_valid_png() {
    for format in [ImageFormat::Png, ImageFormat::Tiff, ImageFormat::Bmp] {
        let bytes = encoded(format);
        let input = if format == ImageFormat::Bmp {
            &bytes[14..]
        } else {
            &bytes[..]
        };
        let decoded = decode(input, format == ImageFormat::Bmp).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (3, 2));
        let png = encode_png(decoded).unwrap();
        assert_eq!(image::guess_format(&png).unwrap(), ImageFormat::Png);
        assert_eq!(
            image::load_from_memory(&png)
                .unwrap()
                .to_rgba8()
                .get_pixel(0, 0)
                .0,
            [12, 34, 56, 255]
        );
    }
}

#[test]
fn corrupt_preferred_png_falls_back_to_dib_or_tiff() {
    let bmp = encoded(ImageFormat::Bmp);
    for (bytes, dib) in [
        (bmp[14..].to_vec(), true),
        (encoded(ImageFormat::Tiff), false),
    ] {
        let result =
            first_decodable([Ok((b"broken PNG".to_vec(), false)), Ok((bytes, dib))]).unwrap();
        assert_eq!(result.unwrap().width(), 3);
    }
}

#[test]
fn absent_image_is_distinct_from_failed_read_or_invalid_data() {
    assert!(first_decodable([]).unwrap().is_none());
    assert_eq!(
        first_decodable([Err("clipboard_image_read_failed".into())]).unwrap_err(),
        "clipboard_image_read_failed"
    );
    assert!(decode(b"not a picture.png", false).is_err());
    assert!(decode(&[0; 8], true).is_err());
}

#[test]
fn accepts_8k_and_exact_40mp_but_rejects_over_limit_before_pixels() {
    assert!(validate_dimensions(7680, 4320).is_ok());
    assert!(validate_dimensions(8000, 5000).is_ok());
    assert_eq!(
        validate_dimensions(8000, 5001).unwrap_err(),
        "clipboard_image_dimensions_too_large"
    );
    let mut bmp = encoded(ImageFormat::Bmp);
    bmp[18..22].copy_from_slice(&8000u32.to_le_bytes());
    bmp[22..26].copy_from_slice(&5001u32.to_le_bytes());
    assert_eq!(
        decode(&bmp[14..], true).unwrap_err(),
        "clipboard_image_dimensions_too_large"
    );
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

// 覆盖 V5 内嵌掩码、BI_RGB alpha 提示和截断/非法调色板，防止仅修一种头。
#[test]
fn dib_v5_alpha_and_malformed_headers() {
    let bitmap = encoded(ImageFormat::Bmp);
    let mut dib = bitmap[14..].to_vec();
    assert_eq!(u32::from_le_bytes(dib[..4].try_into().unwrap()), 108);
    dib.splice(108..108, [0u8; 16]);
    dib[..4].copy_from_slice(&124u32.to_le_bytes());
    for compression in [3u32, 0] {
        dib[16..20].copy_from_slice(&compression.to_le_bytes());
        assert_eq!(
            decode(&dib, true).unwrap().to_rgba8().get_pixel(0, 0).0,
            [12, 34, 56, 255]
        );
    }
    assert!(decode(&dib[..123], true).is_err());
    dib[32..36].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode(&dib, true).is_err());
}
