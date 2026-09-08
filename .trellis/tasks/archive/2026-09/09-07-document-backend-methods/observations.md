# Annotation-time implementation observations

These observations are outside the comment-only change scope. No behavior was repaired.
They describe current source, not regressions attributed to the nine refactor commits; origin,
full consumer payload analysis and runtime reproduction remain separate review work.

## Codex proxy and system notification boundaries

- Protocol trace request tracking has a 64-entry reset bound, but the separate pending
  resume map has no explicit size limit. Unanswered resume requests remain until a matching
  response is consumed. The parent-input thread only logs forwarding errors; it does not
  signal the main output loop to terminate the child. No hanging process was reproduced.
- Profile loading checks metadata before reading the complete file; the read itself is not
  capped against concurrent file growth. This differs from protocol-line reading, which
  checks the byte budget before each buffer append.
- System notification WAV validation checks extension, canonical file metadata and a
  12-byte RIFF/WAVE header, not complete audio validity. The WSL Toast attribution remains
  a hard-coded Chinese string in the existing embedded script; no locale behavior changed.

## Subagent transcript boundaries

- Explicit path validation is lexical, not canonical: native paths use prefix checks;
  Linux paths accept supported component subsequences and reject dot components. Link
  targets are not resolved by this validation. No filesystem escape was exercised.
- WSL command execution uses synchronous output collection without an explicit deadline
  or output cap. Native rollout discovery follows path.is_dir without a visited-directory
  set, while session metadata parsing reads the entire first line before JSON parsing.
- Subscriptions replace stop flags without joining old threads. An empty capped chunk
  advances the offset and continues before the poll sleep. Truncation to zero returns
  no chunk, so a reset is not emitted until a later consumable read. These are source
  observations only; no runtime fix is included in the annotation patch.

## Provider live-file operation boundaries

- Global live-file WSL input helpers start their deadline only after synchronous stdin
  `write_all` returns. A blocked input pipe is outside that wait deadline. Batch writes
  directly overwrite targets and leave earlier writes for the caller's recovery logic on
  failure. This was established from source ordering, not a real WSL hang reproduction.

## Provider document traversal boundaries

- `support::redact_json` and `strip_json_secrets` also use `iter_mut().any(...)` for
  arrays, stopping after the first element reports a secret. Later elements are not processed
  in that branch. The latter feeds duplicate settings, so comments do not promise exhaustive
  removal. `is_secret_key` uses broad substrings; string contents under ordinary fields are
  not generally scanned by JSON redaction. No live credentials were inspected or exposed.
- `card_from_record` defines settings validity as outer JSON object validity only; it does
  not validate inner TOML, required endpoint/model values or credential readiness. Consumers
  needing stronger readiness must not interpret this flag as a complete configuration check.

- `documents::redact_toml_item` uses `tables.iter_mut().any(redact_toml_table)` for
  ArrayOfTables. Traversal stops after the first table reporting a secret, so later tables
  are not visited by that branch. This follows from source control flow; no live document
  was inspected or exposed. Existing tests only cover ordinary tables, not this case.
- `preserve_json_secrets` descends only when both nodes are objects, unlike the new-secret
  checker which also traverses arrays. TOML secret-path collection ignores table arrays,
  ordinary arrays and nested non-secret inline-table children; missing paths are not restored.
  Comments document these limits without presenting either routine as exhaustive protection.

## Provider database backup boundaries

- `checkpoint_before_backup` executes `PRAGMA wal_checkpoint(TRUNCATE)` but discards the
  returned row, including SQLite's busy/progress fields. The following backup copies only
  the main database file. Concurrent-reader/writer consistency under a busy checkpoint is
  not established by the existing isolated upgrade tests; this batch does not change it.
- `backup_existing_database` names copies with milliseconds and process ID, then uses
  `fs::copy` without exclusive creation. Same-process same-millisecond name collision is
  not explicitly prevented. No collision or data loss was reproduced during annotation.

## Crash reporting

- `crash_reporter::redact_json_value` recursively processes string values but ignores object
  key meaning. For an object such as `{"password":"example-value"}`, the leaf string contains
  no assignment/flag syntax and is retained by the current regex. `sanitize_context` also only
  truncates activity/window/visibility fields. The crash contract forbids recording secrets;
  callers must not rely on this implementation as a complete backend secret filter. Actual
  secret exposure through current callers has not been established or tested with real data.
- `is_runtime_marker_name` uses a prefix test. In release the prefix `runtime-state` also
  accepts `runtime-state-dev.json`, contrary to strict debug/release namespace isolation.
  `recover_unclean_markers` does skip markers belonging to another live PID, but dead dev
  markers remain eligible for release recovery. The existing naming test only checks the
  expected name and an unrelated log name; it does not test cross-build rejection.
- `DailyRollingLogWriter` rotates based on size, not a date change; dates identify archives and
  retention windows. A single oversized write is not split, so 10 MiB is a rollover threshold,
  not a hard file-size cap. The new comments reflect this existing behavior.

No GUI crash injection, real marker deletion or real credential operation was performed.

## Agent installer

- `rollback` restores old links on binary validation or record-write failure, but its second
  `replace_symlink` and subsequent version command/JSON parsing use early `?` returns outside
  those restore branches. A returned error therefore does not guarantee unchanged links.
- `install_from_exe` performs link ownership checks after preparing the version directory;
  errors before the `promote` closure can leave prepared files. Its restore helpers suppress
  their own failures, so the rollback is best effort rather than a transaction guarantee.
- `validate_installed_binary` and `installed_binary_version` use synchronous `Command::output`
  without a local timeout or output cap. This is a source observation, not a reproduced hang.

These Unix paths were source-reviewed only on Windows. No real installation, version swap,
uninstall, machine-id read or installer-created deletion was performed by this annotation batch.

## Sync service annotation findings

- `sanitize_remote_dir` retains an older doc comment describing rejection, but the implementation
  converts backslashes and drops dot/double-dot segments without returning an error. The new ordinary
  method comment explicitly describes the actual normalization; executable code and doc attributes
  remain unchanged for this comment-only batch.
- `validate_snapshot` checks hash text format, not correspondence to canonical data, and requires
  only that data is an object. This helper alone is not proof of full snapshot-domain validation.
- `save_outbox` and `write_snapshot_zip` directly write/truncate their destinations rather than
  atomically replacing a temporary file; a write failure need not preserve the previous snapshot.
- `is_backup_file_name` does not validate the device-name segment or actual timestamp, and remote
  path checks are string-based without URL decoding. No end-to-end exploit or production corruption
  was exercised or established in this annotation task; follow-up behavior review remains separate.

## External terminal annotation findings

- `open_folder_in_explorer` uses `open_file` only on Windows. macOS uses `open -R`
  for files and Linux opens their parent directory regardless of the flag, unlike the
  platform-neutral default-application statement in the local-path-opening contract.
- `build_unix_terminal_command` joins cd, startup text and exec using semicolons, so a
  failed directory change does not prevent the startup command running in another directory.
  These are source findings only; no external terminal or user command was executed.

## Terminal background annotation findings

- The file-security guide presents this module as a complete canonicalization example,
  but `background_image_exists` does only string validation plus `exists`, and save checks
  the destination parent rather than canonicalizing the final target. Existing target
  content/type is not verified before reuse. No symlink exploit or user file change tested.
- `cleanup_dir` relies on `Path::is_file`, which follows file symlinks, and does not filter
  extensions before deleting unlisted top-level entries. Comments do not claim a strict
  ordinary-image-only allowlist or recursive cleanup.

## Global apply annotation findings

- In `apply_internal(..., false)`, the persisted journal remains `verifying` while the
  returned result says `committed` and its backup files are cleaned. `apply_hot_switch`
  commits these journals only after every Home succeeds. Source inspection identifies a
  failure/restart window requiring behavioral review; annotation tests do not cover it.
- `rollback_hot_switch` calls `apply_internal` again for the same successful Homes, whose
  still-pending journals are checked by `pending_journal`. This may prevent the intended
  compensation from proceeding. No real multi-Home failure scenario was executed.
- `recover_one` validates live fingerprints before mixed-state restoration, but reads backup
  bytes and writes them before comparing the restored live fingerprint with the old expected
  fingerprint. Backup corruption is not rejected before the write by this function.

## Provider import annotation findings

- Local `scan_source` hashes the main database file before opening the read connection;
  it does not include WAL bytes or bind hashing and row reads into one snapshot transaction.
  WSL uses the separate backup helper. Concurrent-source fingerprint completeness remains
  unproven; no real external database was read or modified to test this condition.
- `commit_inner` increments `unchanged` from fingerprint equality only after performing
  provider/key/reference writes; that count must not be described as a no-write fast path.
- Provider commit, application scope migration and issue persistence are separate phases.
  A later error does not roll back already committed earlier phases. `resolve_issue` also
  updates the application reference before separately marking the provider issue resolved.

## Routing service annotation findings

- `set_failover_queue_and_load` creates a `set_failover_queue` future in the manual
  hot-switch failure branch but never awaits it. Source inspection therefore does not
  support a claim that this branch restores the previous queue. No live database mutation
  or failure injection was performed, and no behavioral fix is included in this task.
- `ensure_current_provider_ready` checks enabled metadata and existence of an enabled
  active key row, not nonempty key contents or runtime configuration validity.
- `test_global_proxy` accepts any received status except 407; its result establishes
  that an endpoint responded through the configured client, not successful API operation.

## CC Switch database bridge annotation findings

- `run_wsl_python_with_stdin` has no explicit write/wait timeout, unlike the sibling
  output_with_timeout runner. It forwards trimmed stderr on process failure without
  redaction. No real WSL hang or sensitive output was exercised.
- The ignored `wsl_database_snapshot_is_read_only` test reads the snapshot through a
  read-only connection and checks one value; it does not independently compare the source
  database before/after. Its name alone is not evidence of complete source immutability.

## Command suggestions annotation findings

- `shared_client` currently builds a fresh configured reqwest client; its name does not establish
  the client reuse stated in the command-suggestion contract.
- `summarize_http_error` removes controls and truncates response text but does not redact secrets;
  `response_error_message` returns provider error text directly, and callers may include these
  messages in debug logs. No real secret or provider response was used to test exposure.
- `sanitize_command` checks emptiness, line breaks and length only; dangerous suffix and prefix
  validation relies on frontend consumers. `clamp_items` similarly does not redact or deduplicate.
- WSL listing/existence helpers use synchronous output collection with no local timeout or output
  cap. Native and WSL listings also differ on non-directory symlinks and special-file treatment.
  These are source-only observations; this annotation batch does not change or exercise WSL behavior.

## Daemon, PTY, Hook and capability annotation findings

Source observations only; no defect below was fixed or reproduced against user data.

- Daemon client request registration precedes writer lock/write completion. Early lock/write errors
  return before pending-entry removal, and the response timeout does not bound blocking writes.
- HTTP forwarding collects non-streaming and rectifier-error upstream bodies with `bytes()` without
  an explicit response-body cap. SSE tracking decodes chunks lossily and splits on LF/LF only;
  CRLF framing and a growing undecided buffer deserve separate review.
- Claude display-name model matching slices the last four bytes without checking UTF-8 boundaries.
- Server Origin admission uses string prefixes rather than URL parsing. WebSocket authentication
  has no explicit read deadline; frame-size admission occurs after the library reads a message.
- Server Shutdown acknowledges requests even when active sessions prevent exit. Detach removes
  attachment/ACK state but does not clear flow_control_paused as sibling cleanup helpers do.
- PTY forced-overflow and EOF paths can flush raw bytes; boundary-safe comments do not establish
  that every output path ends at a complete UTF-8 or terminal-control sequence.
- SSH bridge identity includes transport/Agent fields but omits config_file despite that field
  being present in SshLaunchPlan. Resume-claim release ignores host_id and releases by consumer.
  Readonly is a channel label, not a permission boundary: file writes/deletes use it as well.
- SSH bridge request deadlines bound response waits, not blocking queue sends or pipe writes.
- Hook AgentTool handling logs the complete JSON payload, including transcript/message fields;
  approval resolution uses file-byte growth rather than parsing a decision. Listener thread
  creation and Hook client stdin reads have no explicit bounds in these implementations.
- Hook settings removal can remove managed Pre/Post entries also used by attention notifications;
  merging a preexisting non-array event uses expect. Some public-config synchronization errors
  are ignored. Codex textual true detection does not recognize a trailing inline comment.
- Capability file-size checks precede unrestricted read_to_string, leaving a growth race. The
  configuration fingerprint excludes Skill documents. The simple frontmatter parser does not
  require a closing delimiter, and its plugin-discovery test creates no symlink despite its name.
- Routing fixture tests mostly verify static fixture consistency and a test-local model resolver;
  passing them alone does not establish production routing or log-redaction correctness.

## Remote and Git/files review findings

- SSH process line limits do not cap a single long line; timeout cleanup can block joining readers
  when descendants retain pipe handles. SSH config glob expansion can accumulate candidates before
  downstream file limits. Parallel persistence paths use different busy timeouts (5s/15s).
- cc-connect preflight can create a local SSH workspace, probe a process and create/release a
  Provider snapshot: it is not strictly read-only. Some atomic-write tokens are PID plus milliseconds;
  non-Windows process-stop waits lack a local deadline. These remain unchanged.
- Never run all cc_connect platform tests without isolation: regular_profile_validation cases
  may create real control directories. The optional installed-cc-connect test executes the path
  from CLI_MANAGER_TEST_CC_CONNECT. Other executable trust tests may read the real trust store.
- Git tag listing passes a format string without --format=. Commit rewrite's squash branch can
  return through ? before common rollback, and snapshot restore applies patches after hard reset.
- File overwrite copy/move deletes existing targets first, including a potential same-path source;
  canonicalizing input also loses original symlink identity. SSH download validates before await,
  not again at write time. Attachment path admission is not a strict configured-root binding.
- Git/WSL command deadlines are inconsistent; plain output collection paths may wait indefinitely.
  Live Server task/channel counts have no explicit global cap and shutdown does not track every
  already spawned connection task. Metadata-before-read limits retain file-growth races.
- The files test named path_exists_rejects_invalid_wsl_unc_without_launching_wsl can still access
  a real WSL UNC through Path::exists; exclude it from no-WSL test runs. Git rewrite tests spawn
  real git in TempDir; the live-server integration test starts a loopback server and watcher.

## Script review findings

- OpenCode post records deduplication before fetch succeeds and has no explicit request deadline;
  failed delivery can suppress the next identical state. No real callback endpoint was contacted.
- The OpenCode capacity test feeds unknown status events which need not insert cache entries;
  its passing result is not proof that actual capacity eviction occurred.
- dev-server collects the full probe response without a byte cap; the HTTP timeout is not a
  proven overall wall-clock deadline. Script annotations preserve that behavior.

## Remaining high-risk source findings

- **Critical, not fixed:** `valid_pet_id` currently accepts `.` and `..`. Desktop-pet uninstall
  joins that value under the installed-pets root and calls recursive directory removal; `..` can
  therefore resolve to the whole pets root. No uninstall command or destructive test was run.
- Statusline ANSI color handling slices a six-byte prefix from a Rust `String` and can panic on a
  non-ASCII boundary. Custom statusline commands wait for process exit before draining stdout,
  which can deadlock on a full pipe; timeout kill does not explicitly reap descendants.
- Usage SSE collection drains strings at byte indexes that may split UTF-8, and lossy per-chunk
  decoding can corrupt multi-byte characters spanning chunks. Repeated statusline widgets also
  compute Git status independently instead of sharing one snapshot.
- Capability validation rejects selected NUL/CRLF cases but not all control characters. WSL
  discovery does not consistently honor custom configuration roots, and synchronous SSH probing
  remains inside async request paths.
- Repair loads all patches before one SQLite transaction and later runs VACUUM; path sanitization
  can collide, rollback cannot undo already-written external files, and database-family copy is
  not atomic as a group. Empty-database recognition checks only a small required-table subset.
- History candidate existence sometimes tests only `exists()` where a directory is required.
  Backup cleanup/export paths do not fully mirror newer nested layouts; edit fingerprint checks
  retain a time-of-check/time-of-use window and fixed temporary-name contention. V2 materialized
  messages lack a database foreign key, and Kimi deletion backup does not cover subagent trees.
- Windows statusline profile replacement may delete the destination before fallback rename;
  revision checking is not locked with the write, and restoring two profile files is not one
  transaction. These observations require separate authorized bug-fix tasks.
