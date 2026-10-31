//! Continue 的 intent 与提交证据分离：重启、超时及响应丢失均只核验，不重放 Git commit。
use git2::{Oid, RepositoryState, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use std::fs;
use super::{file_io, session_index, session_store::{self, Open, Stored, PAGE_SIZE}, session_write, types::*};

const PENDING: &str = "pending-commit.json";
const TRAILER: &str = "CLI-Manager-Conflict";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    schema_version: u32, session_id: String, operation_id: String, payload_hash: String,
    head_oid: String, base_oid: String, tree_oid: String, index_hash: String, message: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Audit { intent: Intent, completed_oid: Option<String> }

/// 不允许把未暂存修改或新增文件带进 continue；忽略文件由 Git 自身保留。
fn clean_work(open: &Open) -> Result<()> {
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false)
        .include_unreadable(true).include_unreadable_as_untracked(true);
    let dirty = Status::WT_NEW | Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_TYPECHANGE
        | Status::WT_RENAMED;
    if open.repo.statuses(Some(&mut options))?.iter().any(|entry| entry.status().intersects(dirty)) {
        return Err(Error::new("stale", "working tree contains changes outside verified resolutions"));
    }
    Ok(())
}

/// 活动身份、操作参数及固定父提交必须全部一致；不把未知 journal 当作可重试。
fn identity(open: &Open, stored: &Stored, intent: &Intent) -> Result<()> {
    super::session_abort::ensure_no_pending(open, stored)?;
    let active = open.active()?.ok_or_else(|| Error::new("stale", "active session missing"))?;
    file_io::key(&intent.operation_id)?;
    if active.manifest.snapshot.session_id != stored.manifest.snapshot.session_id
        || intent.schema_version != 1 || intent.session_id != stored.manifest.snapshot.session_id
        || intent.head_oid != stored.manifest.snapshot.head_oid || intent.base_oid != stored.manifest.snapshot.base_oid
        || open.repo.head()?.name() != Some(open.identity.branch.as_str()) {
        return Err(Error::new("recovery_required", "commit intent identity mismatch"));
    }
    Oid::from_str(&intent.tree_oid)?;
    open.no_foreign_locks()?;
    session_write::ensure_no_pending(open, stored)
}

/// HEAD 改变之后不能复用 owned；只接受确切 tree、父序、消息以及完整 index/工作凭据。
fn completed(open: &Open, stored: &Stored, intent: &Intent) -> Result<String> {
    identity(open, stored, intent)?;
    let commit = open.repo.head()?.peel_to_commit()?;
    let expected_message = format!("{}\n\n{TRAILER}: {}:{}\n", intent.message, intent.session_id, intent.operation_id);
    if open.repo.state() != RepositoryState::Clean || commit.parent_count() != 2
        || commit.parent_id(0)?.to_string() != intent.head_oid || commit.parent_id(1)?.to_string() != intent.base_oid
        || commit.tree_id().to_string() != intent.tree_oid || commit.message_bytes() != expected_message.as_bytes()
        || session_store::index_hash(&session_store::index_state(&open.repo)?)? != intent.index_hash {
        return Err(Error::new("recovery_required", "HEAD, commit, merge state or index differs from commit intent"));
    }
    let mut index = open.repo.index()?; index.read(true)?;
    if index.write_tree()?.to_string() != intent.tree_oid { return Err(Error::new("recovery_required", "commit tree differs from current index")); }
    for page in 0..stored.manifest.snapshot.total.div_ceil(PAGE_SIZE) {
        let entries: Vec<FileEntry> = file_io::read_json(&open.path(&intent.session_id, &format!("files-{page}.json"))?)?;
        if entries.len() != (stored.manifest.snapshot.total - page * PAGE_SIZE).min(PAGE_SIZE) {
            return Err(Error::new("recovery_required", "incomplete conflict collection"));
        }
        for entry in entries {
            let receipt: Receipt = file_io::read_json(&open.path(&intent.session_id, &format!("receipt-{}.json", file_io::key(&entry.file_id)?))?)?;
            session_index::check_work(open, &entry, &receipt)?;
        }
    }
    clean_work(open)?;
    // 核验期间外部 Git 若移动 ref，不能把之前读取的 commit 当作最终状态。
    if open.repo.head()?.target() != Some(commit.id()) { return Err(Error::new("stale", "HEAD changed during completion verification")); }
    Ok(commit.id().to_string())
}

/// 只修改会话日志。确定未提交则退回 ready；无法证明时保留 committing 和 intent。
pub fn reconcile(open: &Open, stored: &Stored) -> Result<Snapshot> {
    let mut stored = open.load(&stored.manifest.snapshot.session_id)?;
    let path = open.path(&stored.manifest.snapshot.session_id, PENDING)?;
    let intent: Intent = file_io::read_json(&path)?;
    identity(open, &stored, &intent)?;
    let head = open.repo.head()?.target().ok_or_else(|| Error::new("stale", "HEAD missing"))?.to_string();
    let completed_oid = if head == intent.head_oid {
        let valid = session_index::validate(open, &stored, true)?;
        clean_work(open)?;
        if session_store::index_hash(&valid.index)? != intent.index_hash {
            return Err(Error::new("recovery_required", "index changed during failed commit"));
        }
        None
    } else { Some(completed(open, &stored, &intent)?) };
    let state = if completed_oid.is_some() { State::Completed } else { State::Ready };
    if stored.manifest.snapshot.state != state || stored.manifest.completed_oid != completed_oid {
        stored.manifest.snapshot.revision = stored.manifest.snapshot.revision.checked_add(1)
            .ok_or_else(|| Error::new("recovery_required", "revision overflow"))?;
    }
    stored.manifest.snapshot.state = state;
    stored.manifest.completed_oid = completed_oid.clone();
    stored.manifest.pending_tree = None;
    open.save(&stored)?;
    let audit = Audit { intent, completed_oid };
    file_io::write_json(&open.path(&audit.intent.session_id, &format!("commit-{}.json", audit.intent.operation_id))?, &audit)?;
    if audit.completed_oid.is_some() {
        file_io::write_json(&open.path(&audit.intent.session_id, "terminal.json")?, &audit)?;
    }
    fs::remove_file(path)?;
    Ok(stored.manifest.snapshot)
}

/// 终态释放仍需确切提交证据；manifest 的 completed 标签本身不构成证明。
pub(super) fn verify_terminal(open: &Open, stored: &Stored) -> Result<()> {
    let audit: Audit = file_io::read_json(&open.path(&stored.manifest.snapshot.session_id, "terminal.json")?)?;
    if stored.manifest.snapshot.state != State::Completed || audit.completed_oid.is_none()
        || audit.completed_oid != stored.manifest.completed_oid
        || audit.completed_oid.as_deref() != Some(completed(open, stored, &audit.intent)?.as_str()) {
        return Err(Error::new("recovery_required", "terminal commit evidence differs from manifest"));
    }
    Ok(())
}

/// 标准 Git commit 保留 hooks；hook 改树或外部竞态不回滚未知修改，只保持恢复阻断。
pub fn continue_merge(open: &Open, stored: &Stored, expected_revision: u64, message: &str, operation_id: &str) -> Result<Snapshot> {
    super::session_abort::ensure_no_pending(open, stored)?;
    file_io::key(operation_id)?;
    if message.trim().is_empty() || message.len() > 64 * 1024 || message.contains('\0')
        || message.lines().any(|line| line.starts_with(TRAILER)) {
        return Err(Error::new("invalid_argument", "invalid commit message"));
    }
    let mut stored = open.load(&stored.manifest.snapshot.session_id)?;
    let id = stored.manifest.snapshot.session_id.clone();
    let payload_hash = file_io::hash(&serde_json::to_vec(&(&id, expected_revision, message))?);
    let pending_path = open.path(&id, PENDING)?;
    if pending_path.try_exists()? {
        let intent: Intent = file_io::read_json(&pending_path)?;
        if intent.operation_id != operation_id || intent.payload_hash != payload_hash {
            return Err(Error::new("recovery_required", "another commit intent requires reconciliation"));
        }
        let result = reconcile(open, &stored)?;
        return if result.state == State::Completed { Ok(result) } else { Err(Error::new("commit_not_created", "previous attempt did not commit; retry with a new operation id")) };
    }
    let audit_path = open.path(&id, &format!("commit-{operation_id}.json"))?;
    if audit_path.try_exists()? {
        let audit: Audit = file_io::read_json(&audit_path)?;
        if audit.intent.operation_id != operation_id || audit.intent.payload_hash != payload_hash { return Err(Error::new("stale", "operation id reused with different commit payload")); }
        if audit.completed_oid.is_none() { return Err(Error::new("commit_not_created", "previous attempt did not commit; retry with a new operation id")); }
        if audit.completed_oid.as_deref() != Some(completed(open, &stored, &audit.intent)?.as_str())
            || stored.manifest.snapshot.state != State::Completed { return Err(Error::new("recovery_required", "completion audit differs from manifest")); }
        return Ok(stored.manifest.snapshot);
    }
    session_write::ensure_no_pending(open, &stored)?;
    if !matches!(stored.manifest.snapshot.state, State::Ready | State::Resolving)
        || stored.manifest.snapshot.revision != expected_revision { return Err(Error::new("stale", "session state or revision changed")); }
    let valid = session_index::validate(open, &stored, true)?; clean_work(open)?;
    let mut index = open.repo.index()?; index.read(true)?;
    let intent = Intent { schema_version: 1, session_id: id.clone(), operation_id: operation_id.into(), payload_hash,
        head_oid: stored.manifest.snapshot.head_oid.clone(), base_oid: stored.manifest.snapshot.base_oid.clone(),
        tree_oid: index.write_tree()?.to_string(), index_hash: session_store::index_hash(&valid.index)?, message: message.into() };
    file_io::write_json(&pending_path, &intent)?;
    stored.manifest.snapshot.state = State::Committing;
    stored.manifest.snapshot.revision = stored.manifest.snapshot.revision.checked_add(1).ok_or_else(|| Error::new("recovery_required", "revision overflow"))?;
    stored.manifest.pending_tree = Some(intent.tree_oid.clone()); open.save(&stored)?;
    let fresh = session_index::validate(open, &stored, true)?; clean_work(open)?;
    let mut index = open.repo.index()?; index.read(true)?;
    if session_store::index_hash(&fresh.index)? != intent.index_hash || index.write_tree()?.to_string() != intent.tree_oid {
        return Err(Error::new("stale", "index changed before commit"));
    }
    let message = format!("{}\n\n{TRAILER}: {}:{}\n", intent.message, id, operation_id);
    let output = super::super::run_git_raw(&open.identity.worktree_root,
        &["commit".into(), "--cleanup=verbatim".into(), "-m".into(), message]);
    let result = reconcile(open, &stored)?;
    if result.state == State::Completed { return Ok(result); }
    let detail = match output { Ok(output) => output.stderr, Err(error) => error };
    Err(Error::new("commit_not_created", detail))
}
