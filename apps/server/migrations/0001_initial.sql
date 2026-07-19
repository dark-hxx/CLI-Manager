PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE browser_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_browser_sessions_user ON browser_sessions(user_id, expires_at);

CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    device_token_hash TEXT,
    paired_at INTEGER,
    last_seen_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_devices_user ON devices(user_id, last_seen_at DESC);

CREATE TABLE device_event_cursors (
    device_id TEXT NOT NULL,
    stream TEXT NOT NULL,
    last_sequence INTEGER NOT NULL,
    PRIMARY KEY (device_id, stream),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE pairing_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER,
    claimed_by_user_id TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (claimed_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE history_sessions (
    device_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    project_key TEXT NOT NULL,
    title TEXT NOT NULL,
    cwd TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    branch TEXT,
    freshness TEXT NOT NULL DEFAULT 'cached',
    PRIMARY KEY (device_id, session_id),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_history_sessions_user_updated
    ON history_sessions(user_id, updated_at DESC, device_id, session_id);

CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    UNIQUE (user_id, idempotency_key)
);
CREATE INDEX idx_operations_user_updated ON operations(user_id, updated_at DESC);

CREATE TABLE browser_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_browser_events_user_sequence ON browser_events(user_id, sequence);
