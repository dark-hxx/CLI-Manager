use super::*;

impl DaemonHost {
    // 表锁仅用于克隆引用；不能把忙会话省略成不存在，调用方须收到可重试错误。
    pub(super) fn session_metadata(&self) -> Result<Vec<SessionMeta>, &'static str> {
        let handles: Vec<_> = self
            .sessions
            .lock()
            .map_err(|_| "daemon state unavailable")?
            .values()
            .cloned()
            .collect();
        handles
            .iter()
            .map(|session| {
                session
                    .try_lock()
                    .map(|entry| entry.meta.clone())
                    .map_err(|_| "session state busy")
            })
            .collect()
    }

    // 治理是非阻塞维护：忙会话按单会话容量上界计费，移除前核对身份与退出状态。
    // 表锁内不等待 entry；持 entry 后只尝试表锁，避免与任何历史锁序互相等待。
    pub(super) fn enforce_total_buffer_cap(&self) {
        let handles: Vec<_> = match self.sessions.lock() {
            Ok(sessions) => sessions
                .iter()
                .map(|(id, session)| (id.clone(), Arc::clone(session)))
                .collect(),
            Err(_) => return,
        };
        let mut total = 0usize;
        let mut exited = Vec::new();
        for (id, session) in handles {
            if let Ok(entry) = session.try_lock() {
                total = total.saturating_add(entry.buffer.resident_bytes());
                if !entry.meta.alive {
                    exited.push((id, entry.meta.created_at_ms, Arc::clone(&session)));
                }
            } else {
                total = total.saturating_add(SESSION_BUFFER_MAX_BYTES + MAX_FRAME_BYTES);
            }
        }
        exited.sort_by_key(|(_, created, _)| *created);
        for (id, _, session) in exited {
            if total <= TOTAL_BUFFER_MAX_BYTES {
                break;
            }
            let Ok(entry) = session.try_lock() else {
                continue;
            };
            if entry.meta.alive {
                continue;
            }
            let Ok(mut sessions) = self.sessions.try_lock() else {
                continue;
            };
            if sessions
                .get(&id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                sessions.remove(&id);
                total = total.saturating_sub(entry.buffer.resident_bytes());
            }
        }
    }
}
