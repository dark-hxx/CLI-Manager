-- Keep snapshot cleanup off full JSON scans while a SQLite writer is held.
CREATE INDEX idx_browser_events_workspace_retention
ON browser_events(user_id, json_extract(payload_json, '$.deviceId'), sequence)
WHERE json_extract(payload_json, '$.type') = 'workspace.updated';

CREATE INDEX idx_browser_events_operation_retention
ON browser_events(json_extract(payload_json, '$.operation.id'), sequence)
WHERE json_extract(payload_json, '$.type') = 'operation.updated';

CREATE INDEX idx_operations_transcript_retention
ON operations(updated_at, id)
WHERE kind = 'terminal.transcript'
  AND status IN ('succeeded', 'failed', 'rejected', 'timed_out', 'canceled');
