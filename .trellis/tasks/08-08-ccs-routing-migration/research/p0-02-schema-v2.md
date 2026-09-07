# P0-02 Provider DB Schema v2

## 1. Scope

P0-02 only changes the native `providers.db` persistence baseline:

- keep the schema-v1 provider, key, Home, import, repair, and apply-journal SQL unchanged;
- add schema v2 with versioned routing settings;
- add the sanitized `routing_request_logs` table and its retention/query indexes;
- preserve optional-provider-store startup degradation;
- add fresh, v1-upgrade, future-version, backup-failure, migration-failure, retry, and idempotence tests.

No routing command, listener, HTTP forwarding, writer takeover, model mapping, key rotation, proxy client, or UI surface is registered in this Case.

## 2. Impact Baseline

GitNexus upstream impact was rerun before editing `src-tauri/src/provider/database.rs`.

| Symbol | Risk | Blast radius | Boundary |
| --- | --- | --- | --- |
| `initialize_at` | HIGH | 54 impacted symbols, 6 direct callers, 1 startup process, 4 modules | Preserve `initialize`/`open_connection_at` behavior and `lib.rs::run` warning-and-continue startup |
| `record_schema_migration` | HIGH | 11 impacted symbols, 1 direct caller, startup process | Record per-version SHA-384 without changing historical `cli-manager.db` migrations |
| `ensure_common_config_settings` | HIGH | 11 impacted symbols, 1 direct caller, startup process | Keep existing common settings and add separate routing seeds with `INSERT OR IGNORE` |
| `verify_required_tables` | HIGH | 11 impacted symbols, 1 direct caller, startup process | Reject incomplete routing schema before exposing the provider store |
| `backup_existing_database` | HIGH | 11 impacted symbols, 1 direct caller, startup process | Checkpoint and back up before the first schema write |

## 3. Implemented Contract

### 3.1 Migration state machine

```text
read PRAGMA user_version
  -> reject versions greater than 2 before backup or mutation
  -> for a non-empty older DB: WAL checkpoint + one backup
  -> transactionally apply each missing schema step
       create/verify schema
       seed settings with INSERT OR IGNORE
       record SHA-384 migration checksum
       set PRAGMA user_version
       commit
  -> verify required tables, routing columns, index ownership, and index column order
```

Schema-v1 SQL remains byte-for-byte unchanged and is guarded by checksum test `7498ab64cd42b302f283a6d6bb916337e50801a69ded965d147e9597dcc30e1bf51b8bd1778af79214aa66816149daa8`.

### 3.2 Routing settings

The migration seeds eight keys without overwriting an existing value:

| Key | Default summary |
| --- | --- |
| `routing.service.v1` | off, loopback, preferred port 15721, usage logging on |
| `routing.takeovers.v1` | empty committed takeover list |
| `routing.app.claude.v1` | CCS v3.19.2 Claude defaults: `6/90/180/600/8/3/90/0.7/15` |
| `routing.app.codex.v1` | CCS v3.19.2 Codex defaults: `3/60/120/600/4/2/60/0.6/10` |
| `routing.app.grokbuild.v1` | CCS v3.19.2 Grok Build defaults: `3/60/120/600/4/2/60/0.6/10` |
| `routing.rectifier.v1` | enabled with all four request rules enabled |
| `routing.optimizer.v1` | disabled; thinking/cache sub-options retained as enabled |
| `routing.global_proxy.v1` | no URL/username; only opaque credential account reference |

### 3.3 Routing request log

`routing_request_logs` stores only request/provider/model/time/status/token/rectifier summary fields. It has no request body, response body, header, auth, full URL, proxy password, API key, or raw upstream error body column.

Indexes:

- `idx_routing_request_logs_created_at(created_at_ms)` for retention cleanup;
- `idx_routing_request_logs_app_started(app_type, started_at_ms)` for app/time queries.

## 4. Verification

| Command / scenario | Result |
| --- | --- |
| `rtk cargo fmt --all -- --check` | pass |
| `rtk cargo test provider::database --lib` | pass: 9 tests |
| `rtk cargo test provider::migration --lib` | pass: 4 historical migration tests |
| `rtk cargo test provider --lib` | pass: 121 provider tests before the final documentation-only updates |
| `rtk cargo check` | pass |
| Fresh DB | schema v2, two checksums, 3 common settings, 8 routing settings, table/index shape, no backup |
| v1 -> v2 | provider/key/custom setting preserved; one v1 backup; routing migration recorded |
| Future version | rejected before backup/mutation; marker and version preserved |
| Backup failure | version/provider rows unchanged; no routing table written |
| Malformed routing table | migration transaction rolls back; version remains 1; repair and retry succeeds |
| Reopen v2 | idempotent; no second backup |

## 5. Review Record

| Round | Scope | Findings | Resolution |
| --- | --- | --- | --- |
| R1 | Migration correctness, data-loss boundary, schema shape | The design's generic app JSON could be read as the Claude default; table/index verification only checked object names | Added explicit per-app defaults to `design.md`; verify routing columns, index table ownership, and index column order inside the migration transaction |
| R2 | Spec sync, executable regression coverage, rollback | Backend contract still described only schema v1; backup failure and exact default/checksum contracts were not executable | Updated backend provider contract; added backup-failure and exact checksum/default tests |
| R3 | Migration correctness, transaction/backup/data-loss boundary, provider regression | Zero findings | `cargo fmt`, 123 provider tests, `cargo check`, and diff whitespace checks passed; consecutive zero findings 1/2 |
| R4 | PRD/design/spec consistency, changed-file scope, JSON/JSONL, secret/log schema, Gemini exclusion | Zero findings | Trellis validation and explicit scope/redaction assertions passed; consecutive zero findings 2/2 |

## 6. Rollback

- A v1 database is backed up before v2 writes.
- Any v2 transaction failure leaves `user_version = 1` and preserves provider/key/settings rows.
- The application startup caller continues to log the optional provider-store error and starts the main database, PTY, and history paths.
- Rolling back the binary to a v1-aware build ignores the additive routing settings/table; restore the recorded v1 backup only when explicitly recovering a failed migration.

## 7. Next Case

After two consecutive zero-finding reviews and the independent P0-02 commit, move the unique execution pointer to P0-03.
