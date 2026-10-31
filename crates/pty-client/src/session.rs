use std::collections::{HashMap, HashSet};

/// 由解析 worker 持有；网络收到帧不推进 committed sequence。
#[derive(Debug, Default)]
pub struct SessionLedger {
    cursors: HashMap<String, Cursor>,
    tombstones: HashSet<String>,
}

#[derive(Debug, Default)]
struct Cursor {
    committed: Option<u64>,
    generation: u64,
    pending: Option<(u64, u64)>,
}

/// 绑定解析世代，旧 Display/worker 的迟到 callback 无权提交。
#[derive(Debug)]
pub struct CommitTicket {
    session_id: String,
    sequence: u64,
    generation: u64,
}

impl SessionLedger {
    pub fn register(&mut self, session_id: &str) -> Result<(), &'static str> {
        if session_id.trim().is_empty() {
            return Err("invalid session id");
        }
        if self.tombstones.contains(session_id) {
            return Err("session already closed");
        }
        self.cursors.entry(session_id.into()).or_default();
        Ok(())
    }

    /// 每会话串行解析。重复输出丢弃；resize 的 sequence 间隙允许存在。
    pub fn begin(
        &mut self,
        session_id: &str,
        sequence: u64,
    ) -> Result<Option<CommitTicket>, &'static str> {
        if self.tombstones.contains(session_id) {
            return Ok(None);
        }
        let cursor = self
            .cursors
            .get_mut(session_id)
            .ok_or("session not registered")?;
        if cursor
            .committed
            .is_some_and(|committed| sequence <= committed)
        {
            return Ok(None);
        }
        if cursor.pending.is_some() {
            return Err("session parse already pending");
        }
        cursor.pending = Some((sequence, cursor.generation));
        Ok(Some(CommitTicket {
            session_id: session_id.into(),
            sequence,
            generation: cursor.generation,
        }))
    }

    /// 成功提交之后，调用者才允许发送 ACK。关闭或所有权转移后的 ticket 返回 false。
    pub fn commit(&mut self, ticket: CommitTicket) -> bool {
        if self.tombstones.contains(&ticket.session_id) {
            return false;
        }
        let Some(cursor) = self.cursors.get_mut(&ticket.session_id) else {
            return false;
        };
        if cursor.generation != ticket.generation
            || cursor.pending != Some((ticket.sequence, ticket.generation))
        {
            return false;
        }
        cursor.pending = None;
        cursor.committed = Some(ticket.sequence);
        true
    }

    /// 断线、解析失败或 Display 交接：丢弃未提交所有权，重连仍从 committed 开始。
    pub fn invalidate_pending(&mut self, session_id: &str) {
        if let Some(cursor) = self.cursors.get_mut(session_id) {
            cursor.generation = cursor.generation.wrapping_add(1);
            cursor.pending = None;
        }
    }

    pub fn after_sequence(&self, session_id: &str) -> Option<u64> {
        self.cursors
            .get(session_id)
            .and_then(|cursor| cursor.committed)
    }

    /// Daemon replay_reset starts a new stream, including sequences older than our cursor.
    pub fn reset_replay(&mut self, session_id: &str) -> Result<(), &'static str> {
        if self.tombstones.contains(session_id) {
            return Err("session already closed");
        }
        let cursor = self
            .cursors
            .get_mut(session_id)
            .ok_or("session not registered")?;
        cursor.generation = cursor.generation.wrapping_add(1);
        cursor.pending = None;
        cursor.committed = None;
        Ok(())
    }

    /// 必须在网络 close 之前执行，即使网络请求失败也保留 tombstone。
    pub fn close(&mut self, session_id: &str) {
        self.tombstones.insert(session_id.into());
        self.cursors.remove(session_id);
    }

    pub fn reconnect_sessions(&self) -> Vec<(&str, Option<u64>)> {
        let mut sessions: Vec<_> = self
            .cursors
            .iter()
            .map(|(id, cursor)| (id.as_str(), cursor.committed))
            .collect();
        sessions.sort_by_key(|(id, _)| *id);
        sessions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn received_output_does_not_advance_attach_cursor_until_committed() {
        let mut ledger = SessionLedger::default();
        ledger.register("s").unwrap();
        let first = ledger.begin("s", 7).unwrap().unwrap();
        assert_eq!(ledger.after_sequence("s"), None);
        assert!(ledger.begin("s", 8).is_err());
        assert!(ledger.commit(first));
        assert_eq!(ledger.after_sequence("s"), Some(7));
        assert!(ledger.begin("s", 7).unwrap().is_none());
        let next = ledger.begin("s", 12).unwrap().unwrap();
        assert!(ledger.commit(next));
        assert_eq!(ledger.after_sequence("s"), Some(12));
    }

    #[test]
    fn handoff_rejects_late_callback_and_replays_uncommitted_frame() {
        let mut ledger = SessionLedger::default();
        ledger.register("s").unwrap();
        let old = ledger.begin("s", 5).unwrap().unwrap();
        ledger.invalidate_pending("s");
        let replacement = ledger.begin("s", 5).unwrap().unwrap();
        assert!(!ledger.commit(old));
        assert!(ledger.commit(replacement));
        assert_eq!(ledger.reconnect_sessions(), [("s", Some(5))]);
    }

    #[test]
    fn close_tombstone_survives_failed_network_close_and_blocks_late_output() {
        let mut ledger = SessionLedger::default();
        ledger.register("s").unwrap();
        let pending = ledger.begin("s", 2).unwrap().unwrap();
        ledger.close("s");
        assert!(!ledger.commit(pending));
        assert!(ledger.begin("s", 3).unwrap().is_none());
        assert!(ledger.register("s").is_err());
        assert!(ledger.reconnect_sessions().is_empty());
    }
}
