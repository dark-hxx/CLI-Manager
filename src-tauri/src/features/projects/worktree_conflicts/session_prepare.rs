//! 准备的最终清单落盘前保留完整检查点；缺证据时保留现场，绝不重放 merge。
use serde::{Deserialize, Serialize};
use super::{file_io, session_abort, session_index, session_store::{self, Open, Stored, PAGE_SIZE}, types::*};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint { schema_version: u32, stored: Stored, pages: Vec<(String, String)> }

fn pages(stored: &Stored) -> Vec<String> {
    (0..stored.index_pages).map(|page| format!("index-{page}.json"))
        .chain((0..stored.manifest.snapshot.total.div_ceil(PAGE_SIZE)).map(|page| format!("files-{page}.json"))).collect()
}

/// 只读取已写入的元数据页，不加载工作文件，也不把整个索引塞进一个 JSON。
pub fn checkpoint(open: &Open, stored: &Stored) -> Result<()> {
    let session = &stored.manifest.snapshot.session_id;
    let mut fingerprints = Vec::new();
    for leaf in pages(stored) {
        let hash = file_io::fingerprint(&open.path(session, &leaf)?)?;
        if hash == "missing" { return Err(Error::new("recovery_required", "preparation page missing")); }
        fingerprints.push((leaf, hash));
    }
    file_io::write_json(&open.path(session, "prepared.json")?, &Checkpoint { schema_version: 1, stored: stored.clone(), pages: fingerprints })
}

/// 仅 Preparing 初始 intent 与已持久化检查点完全一致时恢复；不会调用 Git 写命令。
pub fn reconcile(open: &Open, current: &Stored) -> Result<Snapshot> {
    let start = &current.manifest.snapshot;
    let path = open.path(&start.session_id, "prepared.json")?;
    if start.state != State::Preparing || start.revision != 1 || start.total != 0 || start.resolved != 0 || start.draft_count != 0
        || current.index_pages != 0 || current.index_hash.is_some() || current.initial_work_tree.is_some() || !path.try_exists()? {
        return Err(Error::new("recovery_required", "preparation has no provable completed checkpoint; preserve Git state"));
    }
    let record: Checkpoint = file_io::read_json(&path)?;
    let saved = &record.stored; let snapshot = &saved.manifest.snapshot;
    if record.schema_version != 1 || saved.manifest.schema_version != 1 || saved.identity != current.identity
        || saved.prepare_payload != current.prepare_payload || saved.manifest.operation_id != current.manifest.operation_id
        || serde_json::to_vec(&saved.manifest.context)? != serde_json::to_vec(&current.manifest.context)?
        || snapshot.session_id != start.session_id || snapshot.head_oid != start.head_oid || snapshot.base_oid != start.base_oid
        || snapshot.list_snapshot_id != start.list_snapshot_id || snapshot.base_branch != start.base_branch
        || snapshot.worktree_branch != start.worktree_branch || snapshot.revision != 2 || snapshot.resolved != 0
        || snapshot.draft_count != 0 || snapshot.unresolved != snapshot.total || saved.manifest.completed_oid.is_some()
        || saved.manifest.pending_tree.is_some() || snapshot.state != if snapshot.total == 0 { State::Ready } else { State::Resolving } {
        return Err(Error::new("recovery_required", "preparation checkpoint identity mismatch"));
    }
    for leaf in ["pending-write.json", "pending-commit.json", "pending-abort.json"] {
        if open.path(&start.session_id, leaf)?.try_exists()? { return Err(Error::new("recovery_required", "unexpected operation during preparation")); }
    }
    if record.pages.iter().map(|(leaf, _)| leaf.clone()).collect::<Vec<_>>() != pages(saved) {
        return Err(Error::new("recovery_required", "preparation checkpoint page collection mismatch"));
    }
    for (leaf, expected) in &record.pages {
        if file_io::fingerprint(&open.path(&start.session_id, leaf)?)? != *expected {
            return Err(Error::new("recovery_required", "preparation metadata changed after checkpoint"));
        }
    }
    open.owned(saved)?;
    let valid = session_index::validate(open, saved, false)?;
    if !valid.receipts.is_empty() || valid.unresolved != snapshot.total {
        return Err(Error::new("recovery_required", "preparation checkpoint already contains resolutions"));
    }
    session_abort::verify_initial_work(open, saved)?;
    open.owned(saved)?;
    if session_store::index_state(&open.repo)? != valid.index { return Err(Error::new("stale", "index changed during recovery")); }
    open.save(saved)?;
    Ok(snapshot.clone())
}
