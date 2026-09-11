CREATE TABLE conversation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    UNIQUE(device_id, operation_id, sequence)
);
CREATE INDEX idx_conversation_session ON conversation_events(device_id, session_id, id);
ALTER TABLE browser_sessions ADD COLUMN device_scope TEXT;
ALTER TABLE browser_sessions ADD COLUMN display_name TEXT;
ALTER TABLE browser_sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE browser_sessions ADD COLUMN public_id TEXT;
CREATE TABLE mobile_tickets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
