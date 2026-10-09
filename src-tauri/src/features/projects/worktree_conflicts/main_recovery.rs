//! 主检出恢复日志：Git 变更前持久化，失败只在验证原基线后解除闸门。
use super::{file_io, types::{Error, Result}};
use git2::{Repository, RepositoryState, StatusOptions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};

const NAME: &str = "cli-manager-main-recovery.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Baseline {
    head: String,
    branch: String,
    index: String,
    changes: BTreeMap<String, (u32, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    schema_version: u32,
    pub revision: u64,
    pub operation_id: String,
    pub phase: String,
    pub stash_oid: Option<String>,
    stash_before: Option<String>,
    baseline: Baseline,
    verified_final: Option<Baseline>,
}

pub struct Journal { path: PathBuf, record: Record }

/// 兼容旧 IPC 的字符串错误，同时保留稳定的恢复错误码。
pub fn message(error: Error) -> String { format!("{}: {}", error.code, error.detail) }

/// 中止后回到原分支再恢复 stash；分支已正确时不触碰原有未提交改动。
pub fn restore_branch(root: &Path, original_branch: &str) -> std::result::Result<(), String> {
    let repo = Repository::open(root).map_err(|e| e.to_string())?;
    if super::super::current_branch_name(&repo)? == original_branch { return Ok(()); }
    if !no_operation(&repo).map_err(message)?
        || !super::super::run_git_checked(root, ["status", "--porcelain"])?.is_empty() {
        return Err("repository_recovery_required: cannot restore original branch safely".into());
    }
    super::super::run_git_checked(root, ["checkout", original_branch])?;
    Ok(())
}

/// 以完整语义 index 和变化文件内容建立基线，不将时间戳当成恢复证据。
fn capture(repo: &Repository) -> Result<Baseline> {
    let head = repo.head()?;
    let root = repo.workdir().ok_or_else(|| Error::new("identity", "missing workdir"))?;
    let mut digest = Sha256::new();
    let mut index = repo.index()?;
    index.read(true)?;
    for entry in index.iter() {
        digest.update((entry.path.len() as u64).to_le_bytes());
        digest.update(&entry.path);
        digest.update(entry.id.as_bytes());
        digest.update(entry.mode.to_le_bytes());
        digest.update((entry.flags & 0x3000).to_le_bytes());
    }
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    let mut changes = BTreeMap::new();
    for entry in repo.statuses(Some(&mut options))?.iter() {
        let path = std::str::from_utf8(entry.path_bytes())
            .map_err(|_| Error::new("unsupported", "non UTF-8 status path"))?;
        let safe = file_io::safe_path(root, path)?;
        if safe.is_dir() { return Err(Error::new("unsupported", "changed submodule or directory")); }
        changes.insert(path.to_owned(), (entry.status().bits(), file_io::fingerprint(&safe)?));
    }
    Ok(Baseline { head: head.peel_to_commit()?.id().to_string(),
        branch: head.name().ok_or_else(|| Error::new("identity", "unnamed HEAD"))?.into(),
        index: format!("{:x}", digest.finalize()), changes })
}

/// 恢复验证不能只看 unmerged 数量：全已暂存的 merge 仍是未完成操作。
fn no_operation(repo: &Repository) -> Result<bool> {
    let mut index = repo.index()?;
    index.read(true)?;
    Ok(repo.state() == RepositoryState::Clean && !index.has_conflicts()
        && !["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD",
             "rebase-merge", "rebase-apply", "sequencer", "index.lock", "HEAD.lock"]
            .iter().any(|name| repo.path().join(name).exists()))
}

impl Journal {
    /// 调用者已持有仓库锁；已有日志不得覆盖，损坏日志同样需要显式恢复。
    pub fn begin(repo: &Repository) -> Result<Self> {
        let path = file_io::safe_path(repo.path(), NAME)?;
        if path.exists() { return Err(Error::new("repository_recovery_required", "existing recovery journal")); }
        let record = Record { schema_version: 1, revision: 1,
            operation_id: uuid::Uuid::new_v4().to_string(), phase: "prepared".into(), stash_oid: None,
            stash_before: repo.refname_to_id("refs/stash").ok().map(|id| id.to_string()),
            baseline: capture(repo)?, verified_final: None };
        file_io::write_json(&path, &record)?;
        Ok(Self { path, record })
    }

    /// 每个有副作用的阶段之前先写意图；落盘失败立即停止下一次 Git 写入。
    pub fn phase(&mut self, phase: &str, stash: Option<&str>) -> Result<()> {
        self.record.revision += 1;
        self.record.phase = phase.into();
        if let Some(stash) = stash { self.record.stash_oid = Some(stash.into()); }
        file_io::write_json(&self.path, &self.record)
    }

    /// 失败须逐项匹配原基线；成功须无残留操作，并先保存最终检查点再解除。
    pub fn finish(&mut self, repo: &Repository, merged: bool, restoration_ok: bool) -> Result<()> {
        if !restoration_ok || !no_operation(repo)? {
            return Err(Error::new("repository_recovery_required", "operation or restoration remains"));
        }
        let current = capture(repo)?;
        if !merged && current != self.record.baseline {
            return Err(Error::new("repository_recovery_required", "original baseline differs"));
        }
        self.record.verified_final = Some(current);
        self.phase("verified", None)?;
        fs::remove_file(&self.path)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub blocked: bool,
    pub has_journal: bool,
    pub can_confirm: bool,
    pub state_token: Option<String>,
    pub revision: Option<u64>,
    pub phase: Option<String>,
    pub stash_oid: Option<String>,
    pub reason: Option<String>,
}

/// 指纹绑定日志原文及 Git 实态，拒绝确认弹窗打开后发生的任何变化。
fn token(bytes: &[u8], baseline: &Baseline) -> Result<String> {
    let mut digest = Sha256::new();
    digest.update(file_io::hash(bytes));
    digest.update(serde_json::to_vec(baseline)?);
    Ok(format!("{:x}", digest.finalize()))
}

/// 重开弹窗时读取持久化闸门；损坏日志不会被默认为无操作。
pub fn probe(repo: &Repository) -> Result<RecoveryStatus> {
    let idle = no_operation(repo)?;
    let path = file_io::safe_path(repo.path(), NAME)?;
    let exists = path.exists();
    let bytes = if exists { file_io::bounded(&path, super::parser::MAX_JSON_BYTES)? } else { Vec::new() };
    let record = serde_json::from_slice::<Record>(&bytes).ok().filter(|value| value.schema_version == 1);
    Ok(RecoveryStatus {
        blocked: exists || !idle, has_journal: exists, can_confirm: exists && idle,
        state_token: if exists && idle { Some(token(&bytes, &capture(repo)?)?) } else { None },
        revision: record.as_ref().map(|value| value.revision),
        phase: record.as_ref().map(|value| value.phase.clone()),
        stash_oid: record.as_ref().and_then(|value| value.stash_oid.clone()),
        reason: if !idle { Some("repository_operation_in_progress".into()) }
            else if exists { Some(if record.is_some() { "repository_recovery_required" } else { "recovery_journal_corrupt" }.into()) }
            else { None },
    })
}

/// 重检只读 Git；精确匹配基线可自动解除，否则必须用户确认当前状态。
/// 先持久化独立审计，再移除闸门；不 checkout、abort、apply 或 drop stash。
pub fn recheck(repo: &Repository, expected_token: Option<&str>, confirmed: bool) -> Result<RecoveryStatus> {
    let _lock = crate::repo_operation::lock(repo.path()).map_err(|e| Error::new("busy", e))?;
    let status = probe(repo)?;
    if !status.has_journal || !status.can_confirm { return Ok(status); }
    if expected_token != status.state_token.as_deref() { return Err(Error::new("stale", "recovery state changed")); }
    let path = file_io::safe_path(repo.path(), NAME)?;
    let bytes = file_io::bounded(&path, super::parser::MAX_JSON_BYTES)?;
    let current = capture(repo)?;
    let record = serde_json::from_slice::<Record>(&bytes).ok().filter(|value| value.schema_version == 1);
    let automatic = record.as_ref().is_some_and(|value| current == value.baseline || value.verified_final.as_ref() == Some(&current));
    if !automatic && !confirmed { return Ok(status); }
    let audit_name = format!("cli-manager-recovery-audit-{}.json", uuid::Uuid::new_v4());
    let audit = serde_json::json!({ "schemaVersion": 1, "manualConfirmation": !automatic,
        "stateToken": status.state_token, "journalHash": file_io::hash(&bytes),
        "record": record, "acceptedBaseline": current });
    file_io::write_json(&file_io::safe_path(repo.path(), &audit_name)?, &audit)?;
    // 应用锁不约束外部 Git；落盘后再次核对，不能用过期确认解除闸门。
    if !no_operation(repo)? || capture(repo)? != current || fs::read(&path)? != bytes {
        return Err(Error::new("stale", "repository changed during recovery verification"));
    }
    fs::remove_file(path)?;
    probe(repo)
}
