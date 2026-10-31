//! 普通探测只读身份/状态/intent；完整现场核验由显式重检或写入执行。
use serde::Serialize;
use super::{file_io, session_abort, session_commit, session_prepare, session_store::{Open, Stored}, session_write, types::*};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Probe {
    None { head_oid: String, base_oid: String },
    Managed { snapshot: Snapshot },
    Foreign { error: Error },
    Recovery { snapshot: Option<Snapshot>, error: Error },
}

/// 每个 IPC 重新解析身份并验证 active，历史 sessionId 不能操作后续轮次。
pub fn active(open: &Open, session: &str) -> Result<Stored> {
    file_io::key(session)?;
    let stored = open.active()?.ok_or_else(|| Error::new("stale", "active session missing"))?;
    if stored.manifest.snapshot.session_id != session {
        return Err(Error::new("stale", "active session replaced"));
    }
    Ok(stored)
}

fn pending(open: &Open, stored: &Stored) -> Result<Vec<&'static str>> {
    let mut found = Vec::new();
    for leaf in ["pending-write.json", "pending-commit.json", "pending-abort.json"] {
        if open.path(&stored.manifest.snapshot.session_id, leaf)?.try_exists()? { found.push(leaf); }
    }
    Ok(found)
}

/// 不读冲突内容、草稿或全量 receipt，不依据缓存进度授予写权限。
pub fn probe(context: &Context) -> Result<Probe> {
    let open = Open::new(context)?;
    let stored = match open.active() {
        Ok(Some(stored)) => stored,
        Err(error) => return Ok(Probe::Recovery { snapshot: None, error }),
        Ok(None) => {
            if let Err(error) = crate::repo_operation::ensure_idle(&open.repo) {
                return Ok(Probe::Foreign { error: Error::new("foreign_operation", error) });
            }
            open.no_foreign_locks()?;
            return Ok(Probe::None {
                head_oid: open.repo.head()?.peel_to_commit()?.id().to_string(),
                base_oid: open.repo.find_reference(&format!("refs/heads/{}", context.base_branch))?.peel_to_commit()?.id().to_string(),
            });
        }
    };
    let check = (|| -> Result<()> {
        if !pending(&open, &stored)?.is_empty()
            || matches!(stored.manifest.snapshot.state, State::Preparing | State::Committing | State::Aborting | State::RecoveryRequired) {
            return Err(Error::new("recovery_required", "explicit reconciliation required; Git was not replayed"));
        }
        if matches!(stored.manifest.snapshot.state, State::Resolving | State::Ready) { open.owned(&stored)?; }
        Ok(())
    })();
    Ok(match check {
        Ok(()) => Probe::Managed { snapshot: stored.manifest.snapshot },
        Err(error) => Probe::Recovery { snapshot: Some(stored.manifest.snapshot), error },
    })
}

/// 仅补全有证据的应用日志，不调用 merge/add/commit/abort，不接管外部 merge。
pub fn recheck(open: &Open, session: &str) -> Result<Snapshot> {
    let stored = active(open, session)?;
    let intents = pending(open, &stored)?;
    if intents.len() > 1 { return Err(Error::new("recovery_required", "multiple unfinished intents")); }
    match intents.first().copied() {
        Some("pending-abort.json") => session_abort::reconcile(open, &stored),
        Some("pending-commit.json") => session_commit::reconcile(open, &stored),
        Some("pending-write.json") => session_write::reconcile(open, &stored),
        Some(_) => Err(Error::new("recovery_required", "unknown intent")),
        None => match stored.manifest.snapshot.state {
            State::Preparing => session_prepare::reconcile(open, &stored),
            State::Resolving | State::Ready => session_write::reconcile(open, &stored),
            State::Completed => { session_commit::verify_terminal(open, &stored)?; Ok(stored.manifest.snapshot) }
            State::Aborted => { session_abort::verify_terminal(open, &stored)?; Ok(stored.manifest.snapshot) }
            _ => Err(Error::new("recovery_required", "state has no matching recovery intent")),
        },
    }
}
