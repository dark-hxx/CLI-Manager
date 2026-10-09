//! 完整索引 = prepare 基线 + 已核验解决凭据；不能仅检查 has_conflicts。
use std::collections::{BTreeMap, BTreeSet};
use super::{file_io, session_store::{self, Open, Stored, PAGE_SIZE}, types::*};

pub struct Validated { pub index: IndexState, pub receipts: BTreeMap<String, Receipt>, pub unresolved: usize }

/// 分片恢复 prepare 的全部索引，不只恢复冲突路径。哈希不符或重复项均视为损坏。
fn baseline(open: &Open, stored: &Stored) -> Result<IndexState> {
    let mut index = IndexState::new();
    for page in 0..stored.index_pages {
        let entries: Vec<(String, Vec<Stage>)> = file_io::read_json(
            &open.path(&stored.manifest.snapshot.session_id, &format!("index-{page}.json"))?)?;
        if entries.is_empty() || entries.len() > PAGE_SIZE || (page + 1 < stored.index_pages && entries.len() != PAGE_SIZE) {
            return Err(Error::new("recovery_required", "invalid baseline page length"));
        }
        for (path, stages) in entries {
            if stages.is_empty() || index.insert(path, stages).is_some() {
                return Err(Error::new("recovery_required", "duplicate or empty baseline entry"));
            }
        }
    }
    if stored.index_hash.as_deref() != Some(session_store::index_hash(&index)?.as_str()) {
        return Err(Error::new("recovery_required", "prepare baseline fingerprint mismatch"));
    }
    Ok(index)
}

/// 流式比较已解决文件内容；删除凭据只在文件实际缺失时有效。
pub(super) fn check_work(open: &Open, entry: &FileEntry, receipt: &Receipt) -> Result<()> {
    file_io::key(&receipt.operation_id)?;
    if receipt.file_id != entry.file_id || receipt.payload_hash.len() != 64
        || !receipt.payload_hash.bytes().all(|c| c.is_ascii_hexdigit())
        || receipt.stage.as_ref().is_some_and(|stage| stage.stage != 0 || !matches!(stage.mode, 0o100644 | 0o100755)
            || git2::Oid::from_str(&stage.oid).is_err()) {
        return Err(Error::new("recovery_required", "invalid resolution receipt"));
    }
    let hash = file_io::fingerprint(&file_io::safe_path(&open.identity.worktree_root, &entry.display_path)?)?;
    if hash != receipt.work_hash || (receipt.stage.is_none() && hash != "missing")
        || (receipt.stage.is_some() && hash == "missing") {
        return Err(Error::new("stale", "resolved working file changed outside this session"));
    }
    Ok(())
}

/// stage-all、改动自动合并文件、插入无关 stage-0 都不能绕过解决凭据。
pub fn validate(open: &Open, stored: &Stored, require_complete: bool) -> Result<Validated> {
    open.owned(stored)?;
    let mut expected = baseline(open, stored)?;
    let original_conflicts = expected.iter().filter(|(_, stages)| stages.iter().any(|stage| stage.stage != 0))
        .map(|(path, _)| path.clone()).collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new(); let mut ids = BTreeSet::new();
    let mut receipts = BTreeMap::new(); let mut unresolved = 0;
    let snapshot = &stored.manifest.snapshot;
    for page in 0..snapshot.total.div_ceil(PAGE_SIZE) {
        let entries: Vec<FileEntry> = file_io::read_json(&open.path(&snapshot.session_id, &format!("files-{page}.json"))?)?;
        let length = (snapshot.total - page * PAGE_SIZE).min(PAGE_SIZE);
        if entries.len() != length { return Err(Error::new("recovery_required", "incomplete original file collection")); }
        for entry in entries {
            file_io::key(&entry.file_id)?;
            if !original_conflicts.contains(&entry.display_path) || !seen.insert(entry.display_path.clone())
                || !ids.insert(entry.file_id.clone()) || expected.get(&entry.display_path) != Some(&entry.stages) {
                return Err(Error::new("recovery_required", "original conflicts do not match prepare baseline"));
            }
            let path = open.path(&snapshot.session_id, &format!("receipt-{}.json", entry.file_id))?;
            if !path.try_exists()? { unresolved += 1; continue; }
            let receipt: Receipt = file_io::read_json(&path)?;
            if entry.capability == "external_only" { return Err(Error::new("recovery_required", "unsupported file has resolution receipt")); }
            check_work(open, &entry, &receipt)?;
            if let Some(stage) = &receipt.stage { expected.insert(entry.display_path.clone(), vec![stage.clone()]); }
            else { expected.remove(&entry.display_path); }
            receipts.insert(entry.file_id, receipt);
        }
    }
    if seen != original_conflicts { return Err(Error::new("recovery_required", "conflict collection omits index paths")); }
    let actual = session_store::index_state(&open.repo)?;
    if actual != expected { return Err(Error::new("stale", "full index differs from prepare baseline and resolution receipts")); }
    if require_complete && (unresolved != 0 || actual.values().any(|stages| stages.iter().any(|stage| stage.stage != 0))) {
        return Err(Error::new("unresolved", "every original conflict needs a verified resolution receipt"));
    }
    open.owned(stored)?;
    Ok(Validated { index: actual, receipts, unresolved })
}
