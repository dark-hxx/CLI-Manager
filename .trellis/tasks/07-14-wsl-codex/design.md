# Technical Design

## Root Causes

1. Catalog parsing replaces the WSL Codex path-derived project key (`2026`) with the rollout `cwd` basename (`tabGo`), while `validate_session_file_ref` compares against a fresh WSL file scan that still returns `2026`.
2. `register_codex_thread` opens WSL `state_5.sqlite` through Windows UNC. Codex holds the WAL/SHM files inside Linux, so Windows 9P locking cannot coordinate reliably.
3. `session_index.jsonl` currently receives the Windows UNC rollout path, which is not a valid runtime path for Codex inside WSL.

## Design

- In `resolve_session_file_ref`, match source and canonical path first. For a matched Codex path, derive the authoritative project key from its cached/scanned `cwd`; fall back to the enumerated key only when no `cwd` exists. Return the validated authoritative key.
- Add a small path conversion helper that maps standard WSL UNC paths to their Linux path for Codex-owned metadata. Native paths remain unchanged.
- Use the runtime path in `session_index.jsonl` and `CodexThreadRegistration`.
- In `register_codex_thread`, detect a WSL state DB before any existence/open check and skip the Windows-side write with an explicit log. Native state DB registration remains strict.

## Compatibility

- No command or payload shape changes.
- Existing Windows Claude/Codex behavior remains unchanged.
- Existing WSL converted rollout files remain valid and are not deleted.
- Multi-distro PTY selection is outside this task; the current machine has only `Ubuntu-22.04`.
