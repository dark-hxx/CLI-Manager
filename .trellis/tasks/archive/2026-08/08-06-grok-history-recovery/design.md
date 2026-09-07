# Legacy Grok History Recovery

## Data flow

```text
legacy snapshot/grok/sessions
  -> staged durable backup under .cli-manager/backups/provider-grok-history
  -> copy absent session directories to CliHomeResolver real grok history root
  -> only then remove snapshot
```

## Safety

- Snapshot ID already passes the existing bounded identifier validator.
- Recursive copy accepts regular files/directories only and rejects symlinks.
- Backup and destination session copies stage into sibling temporary directories and rename only after complete copy.
- Existing destination sessions are never overwritten; durable backup remains authoritative for conflicts.
- Any error aborts snapshot deletion, making retry safe.
- WSL UNC recovery fails closed because provider contracts forbid host `std::fs` probes for WSL roots.

## Scope

Implementation remains in `provider/scope.rs`; no database, IPC or UI schema change.
