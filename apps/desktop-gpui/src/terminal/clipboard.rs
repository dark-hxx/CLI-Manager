use super::{path_drop, SessionHandle};
use cli_manager_core::clipboard_image;
use gpui::{ClipboardEntry, ClipboardItem, Image};
use std::path::{Path, PathBuf};

pub(crate) enum Content {
    Paths(Vec<PathBuf>),
    Image(Image),
    Text(String),
    Empty,
}

pub(crate) fn content(item: ClipboardItem) -> Content {
    let mut paths = Vec::new();
    let mut image = None;
    let mut text = String::new();
    for entry in item.into_entries() {
        match entry {
            ClipboardEntry::ExternalPaths(files) => paths.extend(files.0),
            ClipboardEntry::Image(candidate) if image.is_none() => image = Some(candidate),
            ClipboardEntry::String(value) => text.push_str(&value.text),
            _ => {}
        }
    }
    if !paths.is_empty() {
        Content::Paths(paths)
    } else if let Some(image) = image {
        Content::Image(image)
    } else if !text.is_empty() {
        Content::Text(text)
    } else {
        Content::Empty
    }
}

pub(crate) async fn paste_image(
    session_id: &str,
    handle: &SessionHandle,
    image: Image,
) -> Result<(), &'static str> {
    if handle.cancellation.is_cancelled() {
        return Ok(());
    }
    let target = handle.clone();
    let task = tokio::task::spawn_blocking(move || -> Result<Option<PathBuf>, &'static str> {
        if target.cancellation.is_cancelled() {
            return Ok(None);
        }
        let database = crate::paths::database_path().map_err(|_| "terminal.image.failed")?;
        let root = database.parent().ok_or("terminal.image.failed")?;
        let path = save_image(root, &image)?;
        if target.cancellation.is_cancelled() {
            let _ = std::fs::remove_file(&path);
            return Ok(None);
        }
        Ok(Some(path))
    });
    let path = task.await.map_err(|_| "terminal.image.failed")??;
    let Some(path) = path else {
        return Ok(());
    };
    path_drop::write_paths(session_id, handle, &[path]).await
}

fn save_image(root: &Path, image: &Image) -> Result<PathBuf, &'static str> {
    let decoded = clipboard_image::decode(image.bytes(), false).map_err(error_key)?;
    let png = clipboard_image::encode_png(decoded).map_err(error_key)?;
    clipboard_image::save_png(root, &png).map_err(error_key)
}

fn error_key(error: String) -> &'static str {
    match error.as_str() {
        "clipboard_image_too_large" | "clipboard_image_dimensions_too_large" => {
            "terminal.image.tooLarge"
        }
        "clipboard_image_unsupported" | "clipboard_image_dimensions_invalid" => {
            "terminal.image.invalid"
        }
        _ => "terminal.image.failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_paths_are_not_concatenated_as_unquoted_text() {
        let item = ClipboardItem::from(ClipboardEntry::ExternalPaths(gpui::ExternalPaths(
            [PathBuf::from(r"C:\first file"), PathBuf::from(r"D:\第二个")].into(),
        )));
        let Content::Paths(paths) = content(item) else {
            panic!("expected paths")
        };
        assert_eq!(
            paths,
            [PathBuf::from(r"C:\first file"), PathBuf::from(r"D:\第二个")]
        );
        assert!(
            matches!(content(ClipboardItem::new_string("hello".into())), Content::Text(text) if text == "hello")
        );
    }

    #[test]
    fn malformed_image_is_not_treated_as_empty_or_saved() {
        let root = tempfile::tempdir().unwrap();
        let image = Image::from_bytes(gpui::ImageFormat::Png, b"invalid".to_vec());
        assert!(matches!(
            content(ClipboardItem::new_image(&image)),
            Content::Image(_)
        ));
        assert_eq!(
            save_image(root.path(), &image),
            Err("terminal.image.invalid")
        );
        assert!(!root.path().join("attachments").exists());
    }

    #[test]
    fn clipboard_priority_is_paths_then_image_then_text() {
        let entries = vec![
            ClipboardEntry::from("do not paste this fallback".to_owned()),
            ClipboardEntry::Image(Image::empty()),
            ClipboardEntry::ExternalPaths(gpui::ExternalPaths(vec![PathBuf::from(r"C:\file")].into())),
        ];
        assert!(matches!(
            content(ClipboardItem {
                entries: entries.clone()
            }),
            Content::Paths(_)
        ));
        assert!(matches!(
            content(ClipboardItem {
                entries: entries[..2].to_vec()
            }),
            Content::Image(_)
        ));
        assert!(matches!(
            content(ClipboardItem { entries: vec![] }),
            Content::Empty
        ));
    }

    #[test]
    fn bitmap_snapshot_is_normalized_to_shared_png_attachment() {
        let mut bitmap = vec![0u8; 58];
        bitmap[..2].copy_from_slice(b"BM");
        bitmap[2..6].copy_from_slice(&58u32.to_le_bytes());
        bitmap[10..14].copy_from_slice(&54u32.to_le_bytes());
        bitmap[14..18].copy_from_slice(&40u32.to_le_bytes());
        bitmap[18..22].copy_from_slice(&1u32.to_le_bytes());
        bitmap[22..26].copy_from_slice(&1u32.to_le_bytes());
        bitmap[26..28].copy_from_slice(&1u16.to_le_bytes());
        bitmap[28..30].copy_from_slice(&24u16.to_le_bytes());
        bitmap[54..57].copy_from_slice(&[12, 34, 56]);
        let image = Image::from_bytes(gpui::ImageFormat::Bmp, bitmap);
        let root = tempfile::tempdir().unwrap();
        let target = save_image(root.path(), &image).unwrap();
        assert_eq!(target.parent().unwrap(), root.path().join("attachments"));
        let png = std::fs::read(target).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        let decoded = clipboard_image::decode(&png, false).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1, 1));
        assert_eq!(decoded.to_rgb8().get_pixel(0, 0).0, [56, 34, 12]);
    }

    #[tokio::test]
    async fn cancelled_image_paste_does_not_resolve_data_root_or_write() {
        use super::super::{model, AttachCancellation, TerminalConnection};
        use std::sync::Arc;
        let cancellation = Arc::new(AttachCancellation::new());
        cancellation.cancel();
        let handle = SessionHandle::new(
            model("cancelled-image".into()).unwrap(),
            cancellation,
            Arc::new(TerminalConnection::new()),
        );
        assert_eq!(
            paste_image("cancelled-image", &handle, Image::empty()).await,
            Ok(())
        );
    }
}
