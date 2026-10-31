//! 仅中止可证明属于本会话的 merge；未知内容、失败和响应丢失都不触发强制 reset。
use std::{fs, path::Path};
use git2::{DiffOptions, Index, Oid, RepositoryState};
use serde::{Deserialize, Serialize};
use super::{file_io, session_index, session_store::{self, Open, Stored}, session_write, types::*};

const PENDING: &str = "pending-abort.json";

/// Intent 先于 manifest 落盘，不能只凭 manifest.state 允许另一类写操作。
pub fn ensure_no_pending(open: &Open, stored: &Stored) -> Result<()> {
    if open.path(&stored.manifest.snapshot.session_id, PENDING)?.try_exists()? {
        return Err(Error::new("recovery_required", "pending abort requires reconciliation before other operations"));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    schema_version: u32, session_id: String, operation_id: String, payload_hash: String,
    head_oid: String, base_oid: String, index_hash: String, work_tree: String, previous_state: State,
}

#[derive(Debug, Serialize, Deserialize)]
struct Audit { intent: Intent, aborted: bool }

/// 内存索引只存元数据，不刷新或写入工作区真实 index。
fn tree_index(open: &Open, oid: &str) -> Result<Index> {
    let mut index = Index::new()?;
    index.read_tree(&open.repo.find_tree(Oid::from_str(oid)?)?)?;
    Ok(index)
}

/// 不跟随 reparse/symlink；Git 可能恢复的路径即使现在被 ignore，也不能覆盖新内容。
fn check_paths(open: &Open, expected: &Index, other: &Index) -> Result<()> {
    for entry in expected.iter().chain(other.iter()) {
        let relative = std::str::from_utf8(&entry.path).map_err(|e| Error::new("unsupported", e))?;
        if !matches!(entry.mode, 0o100644 | 0o100755) { return Err(Error::new("unsupported", "abort requires regular tracked files")); }
        let path = file_io::safe_path(&open.identity.worktree_root, relative)?;
        if expected.get_path(Path::new(relative), 0).is_none() && path.try_exists()? {
            return Err(Error::new("stale", "a path removed by the merge now contains external content"));
        }
    }
    Ok(())
}

/// 直接比较树和工作目录，不把 unresolved index 的状态位当成用户修改。
fn work_matches(open: &Open, expected_oid: &str, other_oid: &str) -> Result<()> {
    let expected = tree_index(open, expected_oid)?;
    check_paths(open, &expected, &tree_index(open, other_oid)?)?;
    let tree = open.repo.find_tree(Oid::from_str(expected_oid)?)?;
    let mut options = DiffOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false)
        .include_typechange(true).include_typechange_trees(true)
        .include_unreadable(true).include_unreadable_as_untracked(true);
    let diff = open.repo.diff_tree_to_workdir(Some(&tree), Some(&mut options))?;
    if diff.deltas().len() != 0 { return Err(Error::new("stale", "working tree differs from managed merge and resolution receipts")); }
    Ok(())
}

/// 准备检查点恢复复用同一工作树证明；缺 AUTO_MERGE 时不收养当前外部内容。
pub(super) fn verify_initial_work(open: &Open, stored: &Stored) -> Result<()> {
    let tree = stored.initial_work_tree.as_ref().ok_or_else(|| Error::new("recovery_required", "original merge tree unavailable"))?;
    let head = open.repo.find_commit(Oid::from_str(&stored.manifest.snapshot.head_oid)?)?.tree_id();
    work_matches(open, tree, &head.to_string())
}

/// ort 的 AUTO_MERGE 保存原始 marker 树；只叠加已确认 receipt，不信任后来任意 stage-all。
fn expected_work(open: &Open, stored: &Stored, valid: &session_index::Validated) -> Result<String> {
    let original = stored.initial_work_tree.as_ref().ok_or_else(|| Error::new("unsupported", "original merge tree unavailable; preserve merge for manual recovery"))?;
    let mut expected = tree_index(open, original)?;
    let mut actual = open.repo.index()?; actual.read(true)?;
    for (id, receipt) in &valid.receipts {
        let entry = session_store::file(open, stored, id)?;
        let path = Path::new(&entry.display_path);
        if receipt.stage.is_some() {
            let stage = actual.get_path(path, 0).ok_or_else(|| Error::new("stale", "resolved index entry missing"))?;
            expected.add(&stage)?;
        } else if expected.get_path(path, 0).is_some() { expected.remove_path(path)?; }
    }
    Ok(expected.write_tree_to(&open.repo)?.to_string())
}

/// 中止只能与一个无待恢复 write/commit 的活动会话绑定。
fn identity(open: &Open, stored: &Stored, intent: &Intent) -> Result<()> {
    file_io::key(&intent.operation_id)?;
    let active = open.active()?.ok_or_else(|| Error::new("stale", "active session missing"))?;
    if intent.schema_version != 1 || intent.session_id != stored.manifest.snapshot.session_id
        || active.manifest.snapshot.session_id != intent.session_id
        || intent.head_oid != stored.manifest.snapshot.head_oid || intent.base_oid != stored.manifest.snapshot.base_oid
        || !matches!(intent.previous_state, State::Resolving | State::Ready)
        || open.repo.head()?.name() != Some(open.identity.branch.as_str())
        || open.repo.head()?.target().map(|oid| oid.to_string()) != Some(intent.head_oid.clone()) {
        return Err(Error::new("recovery_required", "abort identity changed"));
    }
    open.no_foreign_locks()?;
    session_write::ensure_no_pending(open, stored)?;
    if open.path(&intent.session_id, "pending-commit.json")?.try_exists()? {
        return Err(Error::new("recovery_required", "commit must be reconciled before abort"));
    }
    Ok(())
}

/// clean 状态并不够：index、全部工作文件与最初 HEAD 必须一致，新内容一律保留并阻断。
fn aborted(open: &Open, stored: &Stored, intent: &Intent) -> Result<()> {
    identity(open, stored, intent)?;
    if open.repo.state() != RepositoryState::Clean { return Err(Error::new("recovery_required", "merge operation remains after abort")); }
    let head = open.repo.find_commit(Oid::from_str(&intent.head_oid)?)?.tree_id().to_string();
    let expected = tree_index(open, &head)?;
    let mut actual = open.repo.index()?; actual.read(true)?;
    if actual.has_conflicts() || actual.len() != expected.len() || expected.iter().any(|entry| {
        actual.get_path(Path::new(std::str::from_utf8(&entry.path).unwrap_or("")), 0)
            .is_none_or(|current| current.id != entry.id || current.mode != entry.mode)
    }) { return Err(Error::new("recovery_required", "index not restored to original HEAD")); }
    work_matches(open, &head, &intent.work_tree)?;
    identity(open, stored, intent)
}

/// 恢复只做证据核验，不重放 merge --abort；失败时允许新的显式操作 ID。
pub fn reconcile(open: &Open, stored: &Stored) -> Result<Snapshot> {
    let mut stored = open.load(&stored.manifest.snapshot.session_id)?;
    let path = open.path(&stored.manifest.snapshot.session_id, PENDING)?;
    let intent: Intent = file_io::read_json(&path)?;
    identity(open, &stored, &intent)?;
    let did_abort = open.repo.state() == RepositoryState::Clean;
    if did_abort { aborted(open, &stored, &intent)?; } else {
        let valid = session_index::validate(open, &stored, false)?;
        if session_store::index_hash(&valid.index)? != intent.index_hash { return Err(Error::new("recovery_required", "index changed during abort")); }
        let head_tree = open.repo.find_commit(Oid::from_str(&intent.head_oid)?)?.tree_id().to_string();
        work_matches(open, &intent.work_tree, &head_tree)?;
    }
    let state = if did_abort { State::Aborted } else { intent.previous_state.clone() };
    if stored.manifest.snapshot.state != state { stored.manifest.snapshot.revision = stored.manifest.snapshot.revision.checked_add(1)
        .ok_or_else(|| Error::new("recovery_required", "revision overflow"))?; }
    stored.manifest.snapshot.state = state;
    stored.manifest.pending_tree = None;
    open.save(&stored)?;
    let audit = Audit { intent, aborted: did_abort };
    file_io::write_json(&open.path(&audit.intent.session_id, &format!("abort-{}.json", audit.intent.operation_id))?, &audit)?;
    if did_abort { file_io::write_json(&open.path(&audit.intent.session_id, "terminal.json")?, &audit)?; }
    fs::remove_file(path)?;
    Ok(stored.manifest.snapshot)
}

/// 中止成功标签不能单独解除阻断，必须再次核验恢复到固定 HEAD 的完整现场。
pub(super) fn verify_terminal(open: &Open, stored: &Stored) -> Result<()> {
    let audit: Audit = file_io::read_json(&open.path(&stored.manifest.snapshot.session_id, "terminal.json")?)?;
    if stored.manifest.snapshot.state != State::Aborted || !audit.aborted {
        return Err(Error::new("recovery_required", "terminal abort evidence differs from manifest"));
    }
    aborted(open, stored, &audit.intent)
}

/// 验证原始冲突/自动合并/receipt 后才持久化中止 intent，永不自动 stash 或清理未知文件。
pub fn abort(open: &Open, stored: &Stored, expected_revision: u64, operation_id: &str) -> Result<Snapshot> {
    file_io::key(operation_id)?;
    let mut stored = open.load(&stored.manifest.snapshot.session_id)?;
    let id = stored.manifest.snapshot.session_id.clone();
    let payload_hash = file_io::hash(&serde_json::to_vec(&(&id, expected_revision))?);
    let pending = open.path(&id, PENDING)?;
    if pending.try_exists()? {
        let intent: Intent = file_io::read_json(&pending)?;
        if intent.operation_id != operation_id || intent.payload_hash != payload_hash { return Err(Error::new("recovery_required", "another abort must be reconciled")); }
        let snapshot = reconcile(open, &stored)?;
        return if snapshot.state == State::Aborted { Ok(snapshot) } else { Err(Error::new("abort_not_completed", "previous abort did not run; use a new operation id")) };
    }
    let audit = open.path(&id, &format!("abort-{operation_id}.json"))?;
    if audit.try_exists()? {
        let audit: Audit = file_io::read_json(&audit)?;
        if audit.intent.operation_id != operation_id || audit.intent.payload_hash != payload_hash { return Err(Error::new("stale", "abort operation id payload mismatch")); }
        if !audit.aborted { return Err(Error::new("abort_not_completed", "previous attempt did not abort")); }
        aborted(open, &stored, &audit.intent)?;
        if stored.manifest.snapshot.state != State::Aborted { return Err(Error::new("recovery_required", "abort audit differs from manifest")); }
        return Ok(stored.manifest.snapshot);
    }
    if stored.manifest.snapshot.revision != expected_revision || !matches!(stored.manifest.snapshot.state, State::Resolving | State::Ready) {
        return Err(Error::new("stale", "abort session revision or state changed"));
    }
    let valid = session_index::validate(open, &stored, false)?;
    let work_tree = expected_work(open, &stored, &valid)?;
    let head_tree = open.repo.find_commit(Oid::from_str(&stored.manifest.snapshot.head_oid)?)?.tree_id().to_string();
    let intent = Intent { schema_version: 1, session_id: id, operation_id: operation_id.into(), payload_hash,
        head_oid: stored.manifest.snapshot.head_oid.clone(), base_oid: stored.manifest.snapshot.base_oid.clone(),
        index_hash: session_store::index_hash(&valid.index)?, work_tree, previous_state: stored.manifest.snapshot.state.clone() };
    identity(open, &stored, &intent)?;
    work_matches(open, &intent.work_tree, &head_tree)?;
    file_io::write_json(&pending, &intent)?;
    stored.manifest.snapshot.state = State::Aborting;
    stored.manifest.snapshot.revision = stored.manifest.snapshot.revision.checked_add(1).ok_or_else(|| Error::new("recovery_required", "revision overflow"))?;
    open.save(&stored)?;
    let current = session_index::validate(open, &stored, false)?;
    if session_store::index_hash(&current.index)? != intent.index_hash { return Err(Error::new("stale", "index changed before abort")); }
    work_matches(open, &intent.work_tree, &head_tree)?;
    let output = super::super::run_git_raw(&open.identity.worktree_root, ["merge", "--abort"]);
    let snapshot = reconcile(open, &stored)?;
    if snapshot.state == State::Aborted { return Ok(snapshot); }
    Err(Error::new("abort_not_completed", output.map(|out| out.stderr).unwrap_or_else(|error| error)))
}
