//! 单文件解决事务：先 intent，再工作文件，再精确暂存，最后 receipt。
//! 不把工作文件与 Git index 宣称为原子事务；中断只核验，不自动重写。
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use super::{file_io, parser, session_files, session_index, session_store::{self, Open, Stored}, types::*};

const PENDING: &str = "pending-write.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Action { Draft { revision: u64 }, Side(Side) }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    schema_version: u32, session_id: String, file_id: String, revision: u64,
    old_work_hash: String, before_index_hash: String, after_index_hash: String, receipt: Receipt,
}

/// 仅回收本次创建的候选文件及其空父目录，不递归删除未知内容。
struct Scratch { root: PathBuf, relative: String }
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Ok(path) = file_io::safe_path(&self.root, &self.relative) {
            if fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) { let _ = fs::remove_file(&path); }
            let mut parent = path.parent();
            while let Some(directory) = parent {
                if directory == self.root { break; }
                if !directory.starts_with(&self.root) || fs::remove_dir(directory).is_err() { break; }
                parent = directory.parent();
            }
        }
        let _ = fs::remove_dir(&self.root);
    }
}

/// 不允许新的文件写入越过一次尚未核验完成的写事务。
pub fn ensure_no_pending(open: &Open, stored: &Stored) -> Result<()> {
    if open.path(&stored.manifest.snapshot.session_id, PENDING)?.try_exists()? {
        return Err(Error::new("recovery_required", "pending file write requires evidence reconciliation"));
    }
    Ok(())
}

/// Git 的完整退出状态决定成功；路径参数始终使用 literal pathspec。
fn git(open: &Open, arguments: &[String]) -> Result<String> {
    let output = super::super::run_git_raw(&open.identity.worktree_root, arguments)
        .map_err(|e| Error::new("git_failed", e))?;
    if !output.success { return Err(Error::new("git_failed", output.stderr)); }
    Ok(output.stdout.trim().into())
}

/// 按已保存的全部选择重建，保留源中所有非冲突字节，不接受部分定稿。
fn rebuild(detail: &Detail, revision: u64) -> Result<Vec<u8>> {
    if detail.capability != "blocks" || detail.draft.revision != revision {
        return Err(Error::new("stale", "draft capability or revision changed"));
    }
    let source = detail.source.as_ref().ok_or_else(|| Error::new("unsupported", "no editable source"))?;
    if detail.draft.choices.len() != detail.blocks.len() || detail.blocks.is_empty() {
        return Err(Error::new("unresolved", "every block requires a saved choice"));
    }
    let blocks = parser::parse(source.as_bytes(), detail.marker_size).map_err(|e| Error::new("unsupported", format!("{e:?}")))?;
    let choices = detail.blocks.iter().map(|block| {
        Ok(match detail.draft.choices.get(&block.id).ok_or_else(|| Error::new("unresolved", "missing block choice"))? {
            Selection::BaseBranch => parser::Choice::Base, Selection::Worktree => parser::Choice::Worktree,
            Selection::Both => parser::Choice::Both, Selection::Edited(value) => parser::Choice::Edited(value.as_bytes().to_vec()),
        })
    }).collect::<Result<Vec<_>>>()?;
    parser::rebuild(source.as_bytes(), &blocks, &choices).map_err(|e| Error::new("limit_exceeded", format!("{e:?}")))
}

/// 候选文件只写私有 scratch；整侧由 Git checkout-index 应用属性和过滤器。
fn candidate(open: &Open, stored: &Stored, entry: &FileEntry, detail: &Detail, action: &Action) -> Result<(Option<PathBuf>, Option<Stage>, Scratch)> {
    let scratch = open.path(&stored.manifest.snapshot.session_id, &format!("candidate-{}", uuid::Uuid::new_v4()))?;
    fs::create_dir(&scratch)?;
    let cleanup = Scratch { root: scratch.clone(), relative: match action { Action::Draft { .. } => "result".into(), Action::Side(_) => entry.display_path.clone() } };
    let (path, mode, expected_oid) = match action {
        Action::Draft { revision } => {
            let path = file_io::safe_path(&scratch, "result")?;
            file_io::atomic(&path, &rebuild(detail, *revision)?)?;
            let mode = entry.stages.iter().find(|s| s.stage == 2).or_else(|| entry.stages.iter().find(|s| s.stage == 3))
                .ok_or_else(|| Error::new("unsupported", "no regular file side"))?.mode;
            (path, mode, None)
        }
        Action::Side(side) => {
            let number = if *side == Side::BaseBranch { 3 } else { 2 };
            let Some(stage) = entry.stages.iter().find(|s| s.stage == number) else { return Ok((None, None, cleanup)); };
            let prefix = format!("{}/", super::super::strip_windows_extended_path_prefix(&scratch.to_string_lossy()).replace(char::from(92), "/"));
            git(open, &["-c".into(), "core.longpaths=true".into(), "--literal-pathspecs".into(), "checkout-index".into(), format!("--stage={number}"),
                format!("--prefix={prefix}"), "--".into(), entry.display_path.clone()])?;
            (file_io::safe_path(&scratch, &entry.display_path)?, stage.mode, Some(stage.oid.clone()))
        }
    };
    if !matches!(mode, 0o100644 | 0o100755) { return Err(Error::new("unsupported", "not a regular file")); }
    let oid = git(open, &["-c".into(), "core.longpaths=true".into(), "hash-object".into(), "-w".into(), format!("--path={}", entry.display_path),
        "--".into(), super::super::strip_windows_extended_path_prefix(&path.to_string_lossy())])?;
    git2::Oid::from_str(&oid).map_err(|e| Error::new("git_failed", e))?;
    if expected_oid.is_some_and(|expected| expected != oid) {
        return Err(Error::new("unsupported", "Git filter round-trip does not preserve the selected side"));
    }
    Ok((Some(path), Some(Stage { oid, mode, stage: 0 }), cleanup))
}

/// 跨卷 scratch 用流式复制到目标同目录临时文件，sync 后原子替换，内存固定。
fn replace_work(candidate: &Path, target: &Path, mode: u32) -> Result<()> {
    let parent = target.parent().ok_or_else(|| Error::new("path_invalid", "missing parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".cli-manager-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut source = fs::File::open(candidate)?;
        let mut output = fs::OpenOptions::new().create_new(true).write(true).open(&temporary)?;
        let mut buffer = [0u8; 64 * 1024];
        loop { let n = source.read(&mut buffer)?; if n == 0 { break; } output.write_all(&buffer[..n])?; }
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; output.set_permissions(fs::Permissions::from_mode(mode & 0o777))?; }
        #[cfg(not(unix))]
        { let _ = mode; }
        output.flush()?; output.sync_all()?; drop(output);
        fs::rename(&temporary, target)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

/// 只在完整索引与全部凭据成立后刷新进度；草稿只计入尚未解决的文件。
fn progress(open: &Open, stored: &Stored) -> Result<Snapshot> {
    let valid = session_index::validate(open, stored, false)?;
    let mut updated = open.load(&stored.manifest.snapshot.session_id)?;
    let mut drafts = 0;
    for page in 0..updated.manifest.snapshot.total.div_ceil(session_store::PAGE_SIZE) {
        let entries: Vec<FileEntry> = file_io::read_json(&open.path(&updated.manifest.snapshot.session_id, &format!("files-{page}.json"))?)?;
        for entry in entries {
            if !valid.receipts.contains_key(&entry.file_id) {
                let path = open.path(&updated.manifest.snapshot.session_id, &format!("draft-{}.json", entry.file_id))?;
                if path.try_exists()? && !file_io::read_json::<Draft>(&path)?.choices.is_empty() { drafts += 1; }
            }
        }
    }
    let snapshot = &mut updated.manifest.snapshot;
    let state = if valid.unresolved == 0 { State::Ready } else { State::Resolving };
    if snapshot.resolved != valid.receipts.len() || snapshot.unresolved != valid.unresolved || snapshot.draft_count != drafts || snapshot.state != state {
        snapshot.revision = snapshot.revision.checked_add(1).ok_or_else(|| Error::new("recovery_required", "revision overflow"))?;
        snapshot.resolved = valid.receipts.len(); snapshot.unresolved = valid.unresolved; snapshot.draft_count = drafts; snapshot.state = state;
        open.save(&updated)?;
    }
    Ok(updated.manifest.snapshot)
}

/// 响应丢失时仅从既存 intent、精确 index 和工作指纹补凭据；绝不重放 checkout/add。
pub fn reconcile(open: &Open, stored: &Stored) -> Result<Snapshot> {
    super::session_abort::ensure_no_pending(open, stored)?;
    if open.path(&stored.manifest.snapshot.session_id, "pending-commit.json")?.try_exists()? {
        return Err(Error::new("recovery_required", "pending commit must be reconciled before file progress"));
    }
    open.owned(stored)?;
    let path = open.path(&stored.manifest.snapshot.session_id, PENDING)?;
    if !path.try_exists()? { return progress(open, stored); }
    let intent: Intent = file_io::read_json(&path)?;
    if intent.schema_version != 1 || intent.session_id != stored.manifest.snapshot.session_id || intent.file_id != intent.receipt.file_id
        || intent.revision > stored.manifest.snapshot.revision { return Err(Error::new("recovery_required", "invalid write intent")); }
    let entry = session_store::file(open, stored, &intent.file_id)?;
    let work = file_io::safe_path(&open.identity.worktree_root, &entry.display_path)?;
    if file_io::fingerprint(&work)? != intent.receipt.work_hash
        || session_store::index_hash(&session_store::index_state(&open.repo)?)? != intent.after_index_hash {
        return Err(Error::new("recovery_required", "incomplete or externally changed write; preserve files and intent"));
    }
    let receipt_path = open.path(&intent.session_id, &format!("receipt-{}.json", intent.file_id))?;
    if receipt_path.try_exists()? {
        let existing: Receipt = file_io::read_json(&receipt_path)?;
        if serde_json::to_vec(&existing)? != serde_json::to_vec(&intent.receipt)? {
            return Err(Error::new("recovery_required", "receipt conflicts with pending write"));
        }
    } else { file_io::write_json(&receipt_path, &intent.receipt)?; }
    let result = progress(open, stored)?;
    // 审计记录先落盘再清除 pending；删除失败仍阻断其他写入，但可再次核验。
    file_io::write_json(&open.path(&intent.session_id, &format!("write-{}.json", intent.receipt.operation_id))?, &intent)?;
    fs::remove_file(&path)?;
    Ok(result)
}

/// 所有输入 CAS 在落 intent 前和写工作文件前重新核验；一次只暂存白名单文件。
pub fn resolve(open: &Open, stored: &Stored, id: &str, expected_version: &str, expected_revision: u64,
    action: Action, operation_id: &str) -> Result<Snapshot> {
    file_io::key(operation_id)?;
    let stored = open.load(&stored.manifest.snapshot.session_id)?;
    super::session_abort::ensure_no_pending(open, &stored)?;
    open.owned(&stored)?;
    let payload_hash = file_io::hash(&serde_json::to_vec(&(id, expected_version, expected_revision, &action))?);
    let receipt_path = open.path(&stored.manifest.snapshot.session_id, &format!("receipt-{}.json", file_io::key(id)?))?;
    if receipt_path.try_exists()? {
        let receipt: Receipt = file_io::read_json(&receipt_path)?;
        if receipt.operation_id != operation_id || receipt.payload_hash != payload_hash { return Err(Error::new("stale", "file already resolved by another request")); }
        return reconcile(open, &stored);
    }
    ensure_no_pending(open, &stored)?;
    if open.path(&stored.manifest.snapshot.session_id, "pending-commit.json")?.try_exists()? {
        return Err(Error::new("recovery_required", "commit intent requires reconciliation before file writes"));
    }
    if !matches!(stored.manifest.snapshot.state, State::Resolving | State::Ready) || stored.manifest.snapshot.revision != expected_revision {
        return Err(Error::new("stale", "session revision or state changed"));
    }
    let valid = session_index::validate(open, &stored, false)?;
    if valid.receipts.values().any(|receipt| receipt.operation_id == operation_id) { return Err(Error::new("stale", "operation id already used for another file")); }
    let entry = session_store::file(open, &stored, id)?;
    let detail = session_files::detail(open, &stored, id)?;
    if detail.version != expected_version { return Err(Error::new("stale", "file version changed")); }
    if entry.capability == "external_only" { return Err(Error::new("unsupported", "file requires external resolution")); }
    let (candidate, stage, _scratch) = candidate(open, &stored, &entry, &detail, &action)?;
    let work = file_io::safe_path(&open.identity.worktree_root, &entry.display_path)?;
    let new_hash = candidate.as_ref().map(|p| file_io::fingerprint(p)).transpose()?.unwrap_or_else(|| "missing".into());
    let mut after = valid.index.clone();
    if let Some(stage) = &stage { after.insert(entry.display_path.clone(), vec![stage.clone()]); } else { after.remove(&entry.display_path); }
    let intent = Intent { schema_version: 1, session_id: stored.manifest.snapshot.session_id.clone(), file_id: id.into(),
        revision: expected_revision, old_work_hash: detail.draft.source_hash.clone(), before_index_hash: session_store::index_hash(&valid.index)?,
        after_index_hash: session_store::index_hash(&after)?, receipt: Receipt { file_id: id.into(), stage: stage.clone(),
            work_hash: new_hash, operation_id: operation_id.into(), payload_hash } };
    if session_files::detail(open, &stored, id)?.version != expected_version || session_index::validate(open, &stored, false)?.index != valid.index {
        return Err(Error::new("stale", "source or index changed while preparing write"));
    }
    file_io::write_json(&open.path(&intent.session_id, PENDING)?, &intent)?;
    open.owned(&stored)?;
    if file_io::fingerprint(&file_io::safe_path(&open.identity.worktree_root, &entry.display_path)?)? != intent.old_work_hash
        || session_store::index_state(&open.repo)? != valid.index { return Err(Error::new("stale", "source changed after write intent")); }
    if let (Some(candidate), Some(stage)) = (&candidate, &stage) {
        replace_work(candidate, &work, stage.mode)?;
        if file_io::fingerprint(&work)? != intent.receipt.work_hash { return Err(Error::new("recovery_required", "candidate changed during replacement")); }
        git(open, &["--literal-pathspecs".into(), "add".into(), "--".into(), entry.display_path.clone()])?;
        git(open, &["--literal-pathspecs".into(), "update-index".into(),
            if stage.mode == 0o100755 { "--chmod=+x" } else { "--chmod=-x" }.into(), "--".into(), entry.display_path.clone()])?;
    } else {
        if intent.old_work_hash != "missing" { fs::remove_file(&work)?; }
        git(open, &["--literal-pathspecs".into(), "rm".into(), "--cached".into(), "-f".into(), "--".into(), entry.display_path.clone()])?;
    }
    reconcile(open, &stored)
}
