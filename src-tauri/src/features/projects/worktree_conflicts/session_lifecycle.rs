//! 显式确认终态后解除普通完成流程的阻断；保留清单、草稿及所有操作审计。
use std::fs;
use serde::{Deserialize, Serialize};
use super::{file_io, session_abort, session_commit, session_store::{Open, Stored, ACTIVE}, types::*};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Release { schema_version: u32, session_id: String, revision: u64, operation_id: String }

fn verify(open: &Open, stored: &Stored) -> Result<()> {
    for leaf in ["pending-write.json", "pending-commit.json", "pending-abort.json"] {
        if open.path(&stored.manifest.snapshot.session_id, leaf)?.try_exists()? {
            return Err(Error::new("recovery_required", "unfinished intent must be reconciled before release"));
        }
    }
    match stored.manifest.snapshot.state {
        State::Completed => session_commit::verify_terminal(open, stored),
        State::Aborted => session_abort::verify_terminal(open, stored),
        _ => Err(Error::new("stale", "only verified terminal sessions can be released")),
    }
}

/// 单独确认终态，避免丢失 continue/abort 响应时提前撤销其幂等核验现场。
/// 先写 release 收据再删除匹配指针；重试不执行 Git，也不触碰后续轮次。
pub fn release(open: &Open, session: &str, expected_revision: u64, operation_id: &str) -> Result<Snapshot> {
    file_io::key(operation_id)?;
    let stored = open.load(session)?;
    if stored.manifest.snapshot.revision != expected_revision
        || !matches!(stored.manifest.snapshot.state, State::Completed | State::Aborted) {
        return Err(Error::new("stale", "terminal session revision or state changed"));
    }
    let receipt_path = open.path(session, "released.json")?;
    let has_receipt = receipt_path.try_exists()?;
    if has_receipt {
        let receipt: Release = file_io::read_json(&receipt_path)?;
        if receipt.schema_version != 1 || receipt.session_id != session
            || receipt.revision != expected_revision || receipt.operation_id != operation_id {
            return Err(Error::new("stale", "release operation payload changed"));
        }
    }
    match open.active()? {
        None if has_receipt => return Ok(stored.manifest.snapshot),
        Some(active) if active.manifest.snapshot.session_id == session => {}
        _ => return Err(Error::new("stale", "active session missing or replaced")),
    }
    verify(open, &stored)?;
    if !has_receipt {
        file_io::write_json(&receipt_path, &Release { schema_version: 1, session_id: session.into(),
            revision: expected_revision, operation_id: operation_id.into() })?;
    }
    // 写收据期间的外部变化仍须拒绝；不根据旧 manifest 无条件删活动指针。
    verify(open, &stored)?;
    fs::remove_file(file_io::safe_path(&open.identity.private_dir, ACTIVE)?)?;
    Ok(stored.manifest.snapshot)
}
