ALTER TABLE history_sessions ADD COLUMN project_id TEXT;
ALTER TABLE history_sessions ADD COLUMN worktree_id TEXT;

CREATE INDEX idx_history_sessions_device_context
    ON history_sessions(device_id, project_id, worktree_id, updated_at DESC);
