use std::path::Path;

// 仅保护旧托管记录引用的供应商快照，不启动服务、不修改或删除用户数据。
pub(crate) fn retained_provider_snapshot_id() -> Result<Option<String>, String> {
    read_snapshot_id(&crate::app_paths::cli_manager_data_dir()?.join("remote-manager/handoff.json"))
}

fn read_snapshot_id(path: &Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read legacy handoff metadata failed: {error}")),
    };
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("legacy_handoff_record_invalid".into());
    }
    let value: serde_json::Value = serde_json::from_slice(
        &std::fs::read(path).map_err(|error| format!("read legacy handoff record failed: {error}"))?,
    ).map_err(|error| format!("parse legacy handoff record failed: {error}"))?;
    if !value.is_object() {
        return Err("legacy_handoff_record_invalid".into());
    }
    match value.get("providerSnapshotId") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(id)) if !id.trim().is_empty() => Ok(Some(id.clone())),
        _ => Err("legacy_handoff_record_invalid".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_snapshot_without_touching_legacy_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handoff.json");
        assert_eq!(read_snapshot_id(&path).unwrap(), None);
        let raw = br#"{"providerSnapshotId":"snapshot-123","agent":"codex"}"#;
        std::fs::write(&path, raw).unwrap();
        assert_eq!(read_snapshot_id(&path).unwrap().as_deref(), Some("snapshot-123"));
        assert_eq!(std::fs::read(&path).unwrap(), raw);
        std::fs::write(&path, "{broken").unwrap();
        assert!(read_snapshot_id(&path).is_err());
        std::fs::write(&path, r#"{"providerSnapshotId":123}"#).unwrap();
        assert!(read_snapshot_id(&path).is_err());
    }
}
