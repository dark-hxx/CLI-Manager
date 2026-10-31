//! Explicit clipboard imports into a project, not ephemeral terminal attachments.
use super::*;
use std::io::Cursor;
use tauri_plugin_clipboard_manager::ClipboardExt;

const IMPORT_IMAGE_MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImportEntry {
    path: String,
    name: String,
    kind: String,
    is_symlink: bool,
    data_base64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSnapshot {
    unchanged: bool,
    entries: Vec<ClipboardImportEntry>,
}

#[tauri::command]
pub fn clipboard_get_revision() -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        let revision =
            unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
        (revision != 0).then_some(revision)
    }
    #[cfg(not(target_os = "windows"))]
    None
}

#[tauri::command]
pub async fn file_clipboard_write(window: tauri::Window, root_path: String, paths: Vec<String>, mode: String) -> Result<u32, String> {
    if mode != "copy" && mode != "move" { return Err("clipboard_invalid_mode".into()); }
    #[cfg(target_os = "windows")]
    let owner = window.hwnd().map_err(|error| format!("clipboard_window_unavailable: {error}"))?.0 as usize;
    #[cfg(not(target_os = "windows"))]
    let _ = window;
    let sources = tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        if paths.is_empty() || paths.len() > 4096 { return Err("clipboard_invalid_file_count".into()); }
        paths.iter().map(|path| resolve_mutation_source(&root, path)).collect::<Result<Vec<_>, _>>()
    }).await.map_err(|error| error.to_string())??;
    #[cfg(target_os = "windows")]
    {
        if mode == "move" {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            window.run_on_main_thread(move || {
                let _ = sender.send(super::clipboard_shell::write_shell_cut_file_paths(&sources));
            }).map_err(|error| format!("clipboard_window_unavailable: {error}"))?;
            receiver.await.map_err(|error| format!("clipboard_window_unavailable: {error}"))??;
        } else {
            tokio::task::spawn_blocking(move || super::clipboard_files::write_clipboard_file_paths(&sources, owner))
                .await.map_err(|error| error.to_string())??;
        }
        clipboard_get_revision().ok_or_else(|| "clipboard_write_failed".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = sources;
        Err("clipboard_write_unsupported".into())
    }
}

#[tauri::command]
pub async fn file_clipboard_read(
    app: AppHandle,
    known_revision: Option<u32>,
) -> Result<ClipboardSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        let revision = clipboard_get_revision();
        if revision.is_some() && revision == known_revision {
            return Ok(ClipboardSnapshot { unchanged: true, entries: vec![] });
        }
        let paths = read_clipboard_file_paths()?;
        let mut entries = Vec::new();
        for path in paths {
            let source = Path::new(&path);
            let name = source.file_name().ok_or("invalid_name")?.to_string_lossy().into_owned();
            // Missing/inaccessible sources remain entries: batch reports their individual failures.
            let metadata = fs::symlink_metadata(source).ok();
            entries.push(ClipboardImportEntry {
                path: path.replace('\\', "/"), name,
                kind: if metadata.as_ref().is_some_and(|m| m.is_dir()) { "directory" } else { "file" }.into(),
                is_symlink: metadata.as_ref().is_some_and(is_symlink_or_reparse),
                data_base64: None,
            });
        }
        if entries.is_empty() {
            match app.clipboard().read_image() {
                Ok(image) => {
                    validate_image_pixel_count(image.width(), image.height())?;
                    let rgba = image::RgbaImage::from_raw(image.width(), image.height(), image.rgba().to_vec())
                        .ok_or("clipboard_image_invalid")?;
                    let mut png = Cursor::new(Vec::new());
                    image::DynamicImage::ImageRgba8(rgba).write_to(&mut png, image::ImageFormat::Png)
                        .map_err(|err| format!("clipboard_image_invalid: {err}"))?;
                    if png.get_ref().len() > IMPORT_IMAGE_MAX_BYTES { return Err("clipboard_image_too_large".into()); }
                    let id = uuid::Uuid::new_v4().simple().to_string();
                    let name = format!("screenshot-{}-{}.png", chrono::Local::now().format("%Y%m%d-%H%M%S"), &id[..8]);
                    entries.push(ClipboardImportEntry {
                        path: format!("clipboard-image:{id}"), name, kind: "file".into(), is_symlink: false,
                        data_base64: Some(general_purpose::STANDARD.encode(png.into_inner())),
                    });
                }
                // Plugin erases arboard's enum, so match only its exact no-content error.
                Err(err) if err.to_string() == "The clipboard contents were not available in the requested format or the clipboard is empty." => {}
                Err(err) => return Err(format!("clipboard_read_failed: {err}")),
            }
        }
        if revision != clipboard_get_revision() { return Err("clipboard_changed".into()); }
        Ok(ClipboardSnapshot { unchanged: false, entries })
    }).await.map_err(|err| err.to_string())?
}

/// Stricter than legacy text-file names: no Win32 devices, ADS, normalization or aliases.
fn validate_import_name(name: &str) -> Result<(), String> {
    validate_child_name(name).map_err(str::to_string)?;
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if name != name.trim()
        || name.ends_with('.')
        || device
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return Err("invalid_name".into());
    }
    Ok(())
}

fn import_target(root_path: &str, parent: &str, name: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_root(root_path)?;
    validate_relative_path(parent).map_err(str::to_string)?;
    for part in parent.split('/').filter(|part| !part.is_empty()) {
        validate_import_name(part)?;
    }
    validate_import_name(name)?;
    // Unlike browsing, importing may not traverse a link/junction at any destination component.
    resolve_mutation_source(&root, parent)?;
    let target = resolve_named_target(&root, parent, name)?;
    ensure_target_safe_for_write(&root, &target)?;
    Ok((root, target))
}

fn external_source(path: &str) -> Result<PathBuf, String> {
    let source = Path::new(path);
    if !source.is_absolute() {
        return Err("source_not_absolute".into());
    }
    // Check components before canonicalizing, so a copied symlink cannot become its target.
    let mut candidate = PathBuf::new();
    for component in source.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("invalid_source_path".into());
        }
        candidate.push(component);
        if matches!(component, Component::Normal(_)) {
            let metadata = fs::symlink_metadata(&candidate)
                .map_err(|err| format!("metadata_failed: {err}"))?;
            if is_symlink_or_reparse(&metadata) {
                return Err("path_is_symlink".into());
            }
        }
    }
    let source = source
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    if source.parent().is_none() {
        return Err("cannot_modify_root".into());
    }
    Ok(source)
}

fn guard_import_overlap(source: &Path, target: &Path, protected: &[String]) -> Result<(), String> {
    if source == target {
        return Err("source_equals_target".into());
    }
    if target.starts_with(source) {
        return Err("target_inside_source".into());
    }
    if source.starts_with(target) {
        return Err("target_overlaps_selection".into());
    }
    for path in protected {
        // Missing unrelated source should fail only its own item, not the whole batch.
        if let Ok(other) = Path::new(path).canonicalize() {
            if other.starts_with(target) {
                return Err("target_overlaps_selection".into());
            }
        }
    }
    Ok(())
}

struct ImportStage {
    path: PathBuf,
    preserve: bool,
}
impl Drop for ImportStage {
    fn drop(&mut self) {
        if !self.preserve {
            if let Err(err) = fs::remove_dir_all(&self.path) {
                log::warn!(
                    "Failed to clean import staging directory {}: {err}",
                    self.path.display()
                );
            }
        }
    }
}

fn staged_import(
    root: &Path,
    target: &Path,
    overwrite: bool,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    ensure_target_safe_for_write(root, target)?;
    if target.exists() && !overwrite {
        return Err("target_exists".into());
    }
    let parent = target.parent().ok_or("missing_parent")?;
    let stage_path = parent.join(format!(".cli-manager-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&stage_path).map_err(|err| format!("import_stage_failed: {err}"))?;
    let mut stage = ImportStage {
        path: stage_path,
        preserve: false,
    };
    let staged = stage.path.join("new");
    write(&staged)?; // Complete source read before changing an existing destination.
    ensure_existing_child_within_root(root, parent)?;
    ensure_target_safe_for_write(root, target)?;
    let backup = stage.path.join("previous");
    let had_target = target.exists();
    if had_target {
        if !overwrite {
            return Err("target_exists".into());
        }
        fs::rename(target, &backup).map_err(|err| format!("import_backup_failed: {err}"))?;
    }
    let publish = publish_without_replace(&staged, target);
    if let Err(err) = publish {
        if had_target {
            // Never destroy an independently recreated destination to perform a rollback.
            if target.exists() || fs::rename(&backup, target).is_err() {
                stage.preserve = true;
                return Err(format!(
                    "import_recovery_required: {} ({err})",
                    stage.path.display()
                ));
            }
        }
        return Err(if err.kind() == std::io::ErrorKind::AlreadyExists {
            "target_exists".into()
        } else {
            format!("import_publish_failed: {err}")
        });
    }
    Ok(())
}

fn publish_without_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // Unlike std::fs::rename (REPLACE_EXISTING), flags=0 cannot clobber a racer.
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                0,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        if source.is_file() {
            fs::hard_link(source, target)
        } else {
            fs::rename(source, target)
        }
    }
}

fn copy_import_path(root: &Path, source: &Path, target: &Path, depth: usize) -> Result<(), String> {
    if depth > 128 {
        return Err("import_directory_too_deep".into());
    }
    let metadata = ensure_copy_source_safe(root, source)?;
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|err| format!("copy_dir_create_failed: {err}"))?;
        for item in fs::read_dir(source).map_err(|err| format!("copy_dir_read_failed: {err}"))? {
            let entry = item.map_err(|err| format!("copy_dir_entry_failed: {err}"))?;
            let name = entry.file_name();
            validate_import_name(name.to_str().ok_or("invalid_name")?)?;
            copy_import_path(root, &entry.path(), &target.join(name), depth + 1)?;
        }
        Ok(())
    } else if metadata.is_file() {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|err| format!("copy_file_failed: {err}"))
    } else {
        Err("unsupported_file_type".into())
    }
}

#[tauri::command]
pub async fn file_import_external(
    root_path: String,
    source_path: String,
    target_parent_path: String,
    name: String,
    overwrite: bool,
    protected_source_paths: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        import_external(
            &root_path,
            &source_path,
            &target_parent_path,
            &name,
            overwrite,
            &protected_source_paths,
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

fn import_external(
    root: &str,
    source: &str,
    parent: &str,
    name: &str,
    overwrite: bool,
    protected: &[String],
) -> Result<(), String> {
    let (root, target) = import_target(root, parent, name)?;
    let source = external_source(source)?;
    guard_import_overlap(
        &source,
        &target.canonicalize().unwrap_or_else(|_| target.clone()),
        protected,
    )?;
    staged_import(&root, &target, overwrite, |staged| {
        let source_root = if source.is_dir() {
            source.as_path()
        } else {
            source.parent().ok_or("missing_parent")?
        };
        copy_import_path(source_root, &source, staged, 0)
    })
}

#[tauri::command]
pub async fn file_import_image(
    root_path: String,
    target_parent_path: String,
    name: String,
    data_base64: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        import_image(
            &root_path,
            &target_parent_path,
            &name,
            &data_base64,
            overwrite,
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

fn import_image(
    root: &str,
    parent: &str,
    name: &str,
    data: &str,
    overwrite: bool,
) -> Result<(), String> {
    if data.len() > IMPORT_IMAGE_MAX_BYTES.div_ceil(3) * 4 {
        return Err("clipboard_image_too_large".into());
    }
    let bytes = general_purpose::STANDARD
        .decode(data)
        .map_err(|err| format!("decode_failed: {err}"))?;
    if bytes.len() > IMPORT_IMAGE_MAX_BYTES {
        return Err("clipboard_image_too_large".into());
    }
    let reader = image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|err| format!("clipboard_image_invalid: {err}"))?;
    validate_image_pixel_count(width, height)?;
    image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|err| format!("clipboard_image_invalid: {err}"))?;
    if !name.to_ascii_lowercase().ends_with(".png") {
        return Err("invalid_name".into());
    }
    let (root, target) = import_target(root, parent, name)?;
    staged_import(&root, &target, overwrite, |staged| {
        fs::write(staged, &bytes).map_err(|err| format!("write_failed: {err}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn assert_no_stage(root: &Path) {
        assert!(!fs::read_dir(root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".cli-manager-import-")));
    }
    fn png() -> String {
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            2,
            2,
            image::Rgba([255, 0, 0, 255]),
        ))
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
        general_purpose::STANDARD.encode(out.into_inner())
    }

    #[test]
    fn imports_unicode_binary_and_empty_files_into_nested_directory_without_moving_source() {
        let source = tempdir().unwrap();
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("图片 空格")).unwrap();
        for (name, bytes) in [("中文.bin", vec![0, 255, 3, 128]), ("empty.txt", vec![])] {
            let file = source.path().join(name);
            fs::write(&file, &bytes).unwrap();
            import_external(
                &text(root.path()),
                &text(&file),
                "图片 空格",
                name,
                false,
                &[],
            )
            .unwrap();
            assert_eq!(
                fs::read(root.path().join("图片 空格").join(name)).unwrap(),
                bytes
            );
            assert_eq!(fs::read(file).unwrap(), bytes);
        }
        assert_no_stage(&root.path().join("图片 空格"));
    }

    #[test]
    fn folder_conflict_requires_confirmation_and_replaces_not_merges() {
        let source = tempdir().unwrap();
        let root = tempdir().unwrap();
        let folder = source.path().join("folder");
        fs::create_dir_all(folder.join("nested")).unwrap();
        fs::write(folder.join("nested/new.txt"), "new").unwrap();
        fs::create_dir(root.path().join("folder")).unwrap();
        fs::write(root.path().join("folder/old.txt"), "old").unwrap();
        assert_eq!(
            import_external(&text(root.path()), &text(&folder), "", "folder", false, &[])
                .unwrap_err(),
            "target_exists"
        );
        assert!(root.path().join("folder/old.txt").exists());
        import_external(&text(root.path()), &text(&folder), "", "folder", true, &[]).unwrap();
        assert!(!root.path().join("folder/old.txt").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("folder/nested/new.txt")).unwrap(),
            "new"
        );
        assert!(folder.join("nested/new.txt").exists());
        assert_no_stage(root.path());
    }

    #[test]
    fn failed_staging_leaves_existing_target_and_cleans_partial_copy() {
        let root = tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let target = root.join("file.txt");
        fs::write(&target, "keep").unwrap();
        let result = staged_import(&root, &target, true, |stage| {
            fs::write(stage, "partial").unwrap();
            Err("source_read_failed".into())
        });
        assert_eq!(result.unwrap_err(), "source_read_failed");
        assert_eq!(fs::read_to_string(target).unwrap(), "keep");
        assert_no_stage(&root);
    }

    #[test]
    fn failed_publish_restores_original() {
        let root = tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let target = root.join("file.txt");
        fs::write(&target, "keep").unwrap();
        // Writer returns without a staged item: publication must fail and roll back.
        assert!(staged_import(&root, &target, true, |_| Ok(()))
            .unwrap_err()
            .contains("import_publish_failed"));
        assert_eq!(fs::read_to_string(target).unwrap(), "keep");
        assert_no_stage(&root);
    }

    #[test]
    fn destination_created_during_staging_is_not_overwritten() {
        let root = tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let target = root.join("new.txt");
        let result = staged_import(&root, &target, false, |stage| {
            fs::write(stage, "clipboard").unwrap();
            fs::write(&target, "other process").unwrap();
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "target_exists");
        assert_eq!(fs::read_to_string(target).unwrap(), "other process");
        assert_no_stage(&root);
    }

    #[test]
    fn publication_never_replaces_an_existing_file() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source");
        let target = dir.path().join("target");
        fs::write(&source, "new").unwrap();
        fs::write(&target, "keep").unwrap();
        assert!(publish_without_replace(&source, &target).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
    }

    #[test]
    fn image_is_saved_as_real_png_and_conflicts_preserve_original() {
        let root = tempdir().unwrap();
        let data = png();
        import_image(&text(root.path()), "", "screenshot.png", &data, false).unwrap();
        let bytes = fs::read(root.path().join("screenshot.png")).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 2);
        assert_eq!(
            import_image(&text(root.path()), "", "screenshot.png", &data, false).unwrap_err(),
            "target_exists"
        );
        assert_eq!(fs::read(root.path().join("screenshot.png")).unwrap(), bytes);
        assert_no_stage(root.path());
    }

    #[test]
    fn invalid_image_and_invalid_names_never_replace_files() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("old.png"), "keep").unwrap();
        for data in [
            "!bad-base64!".to_string(),
            general_purpose::STANDARD.encode(b"not a png"),
        ] {
            assert!(import_image(&text(root.path()), "", "old.png", &data, true).is_err());
        }
        assert_eq!(
            fs::read_to_string(root.path().join("old.png")).unwrap(),
            "keep"
        );
        for name in [
            "../escape.png",
            "..",
            "CON.png",
            "a:b.png",
            "a\\b.png",
            "a. ",
            " leading.png",
            "LPT1",
            "NUL.txt",
            "a\0.png",
        ] {
            assert!(validate_import_name(name).is_err(), "{name:?}");
        }
        assert!(validate_import_name("中文 screenshot.png").is_ok());
        assert_no_stage(root.path());
    }

    #[test]
    fn rejects_traversal_missing_parent_and_relative_source() {
        let source = tempdir().unwrap();
        let root = tempdir().unwrap();
        let file = source.path().join("f");
        fs::write(&file, "x").unwrap();
        for parent in ["../", "a/../../", "/outside", "missing", "sub:stream"] {
            assert!(
                import_external(&text(root.path()), &text(&file), parent, "f", false, &[]).is_err()
            );
        }
        assert!(
            import_external(&text(root.path()), "relative", "", "f", false, &[])
                .unwrap_err()
                .contains("source_not_absolute")
        );
        assert!(fs::read_dir(root.path()).unwrap().next().is_none());
    }

    #[test]
    fn rejects_self_descendant_ancestor_and_other_batch_source_targets() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("folder/sub")).unwrap();
        let file = root.path().join("folder/file");
        fs::write(&file, "keep").unwrap();
        assert_eq!(
            import_external(
                &text(root.path()),
                &text(&file),
                "folder",
                "file",
                true,
                &[]
            )
            .unwrap_err(),
            "source_equals_target"
        );
        assert_eq!(
            import_external(
                &text(root.path()),
                &text(&root.path().join("folder")),
                "folder/sub",
                "nested",
                true,
                &[]
            )
            .unwrap_err(),
            "target_inside_source"
        );
        assert_eq!(
            import_external(&text(root.path()), &text(&file), "", "folder", true, &[]).unwrap_err(),
            "target_overlaps_selection"
        );
        let other = root.path().join("other");
        fs::write(&other, "other").unwrap();
        assert_eq!(
            import_external(
                &text(root.path()),
                &text(&other),
                "",
                "folder",
                true,
                &[text(&file)]
            )
            .unwrap_err(),
            "target_overlaps_selection"
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "keep");
        assert_no_stage(root.path());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn case_alias_does_not_rewrite_the_copied_source() {
        let root = tempdir().unwrap();
        let file = root.path().join("MixedCase.txt");
        fs::write(&file, "keep").unwrap();
        assert_eq!(
            import_external(
                &text(root.path()),
                &text(&file),
                "",
                "mixedcase.txt",
                true,
                &[]
            )
            .unwrap_err(),
            "source_equals_target"
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "keep");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn source_and_destination_links_are_rejected_without_replacing_old_data() {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let source = tempdir().unwrap();
        let root = tempdir().unwrap();
        let file = source.path().join("file");
        fs::write(&file, "source").unwrap();
        if let Err(error) = symlink_file(&file, source.path().join("link")) {
            if error.raw_os_error() == Some(1314) {
                eprintln!("symlink test unavailable: enable Developer Mode or symlink privilege");
                return;
            }
            panic!("cannot create test symlink: {error}");
        }
        fs::write(root.path().join("target"), "keep").unwrap();
        assert!(import_external(
            &text(root.path()),
            &text(&source.path().join("link")),
            "",
            "target",
            true,
            &[]
        )
        .unwrap_err()
        .contains("path_is_symlink"));
        // A nested link must fail staging, without deleting the old destination folder.
        fs::create_dir(root.path().join("folder")).unwrap();
        fs::write(root.path().join("folder/old"), "keep").unwrap();
        assert!(import_external(
            &text(root.path()),
            &text(source.path()),
            "",
            "folder",
            true,
            &[]
        )
        .unwrap_err()
        .contains("path_is_symlink"));
        assert!(root.path().join("folder/old").exists());
        symlink_dir(source.path(), root.path().join("redirect")).unwrap();
        assert!(import_external(
            &text(root.path()),
            &text(&file),
            "redirect",
            "new",
            false,
            &[]
        )
        .unwrap_err()
        .contains("path_is_symlink"));
        assert!(!source.path().join("new").exists());
        assert_no_stage(root.path());
    }
}
