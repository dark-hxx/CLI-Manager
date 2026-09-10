ALTER TABLE operations ADD COLUMN accepted_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN running_seen INTEGER NOT NULL DEFAULT 0;
UPDATE operations SET accepted_seen = 1 WHERE status IN ('accepted', 'running', 'succeeded', 'failed');
UPDATE operations SET running_seen = 1 WHERE status IN ('running', 'succeeded', 'failed');
