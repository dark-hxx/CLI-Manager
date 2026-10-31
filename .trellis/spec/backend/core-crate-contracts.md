# Core crate contracts

## Scope

`cli-manager-core` contains platform independent validation, parsing, normalization and
launch argument construction. `cli-manager-core-db` contains the framework independent
SQLite migration definitions. The Tauri crate remains an adapter during the migration.

## Core boundaries

- `ssh_transport_args`: SSH target, authentication and connection argument construction.
- `ssh_proxy_args`: SSH proxy helper argument parsing and non-zero port validation.
- `proxy_protocol`: proxy command construction and HTTP/SOCKS5 protocol parsing.
- `ssh_shell`, `ssh_launch_validation`, `ssh_validation`, `ssh_askpass`: pure SSH rules.
- `agent_launcher`, `listener_addresses`, `port_allocator`, `wsl`, `git_bash_*`: pure
  platform rules with host probes injected by the caller where required.

Core functions do not start processes, access credentials, query the registry, resolve DNS,
emit UI events or depend on Tauri types. Existing discovery and launcher helpers access
files and process metadata. Proxy handshakes currently accept an already connected
`TcpStream`; the host owns socket creation, DNS, timeouts and bridging. Replacing this
concrete stream with a `Read + Write` boundary remains follow-up work.

## Database boundary

`cli-manager-core-db::migrations::migrations()` returns ordered `Migration` values with
`version`, `description` and immutable SQL text. `provider` exports the historical provider
tombstones. The Tauri adapter converts each value to `tauri_plugin_sql::Migration` with
`MigrationKind::Up`.

The 41 main migrations are guarded by a SHA-384 snapshot and an in-memory apply test. SQL
text, version numbers and descriptions must remain byte compatible with the shipped list.

`migrator()` and `run_migrations()` use SQLx and the same migration checksum scheme as the
SQL plugin. They do not yet apply the host's pre-migration drift repair; existing database
bootstrap must retain that step before using the native migrator.

`pool::DbPool` owns one writer connection and up to `min(4, available CPUs)` read-only
connections. All connections use WAL, NORMAL synchronous, a 5-second busy timeout,
foreign keys, MEMORY temporary storage, a 16 MB page cache, 256 MB mmap and statement
caching. Writes followed by reads must use a writer transaction. `close()` awaits both
pools, which is required before Windows file cleanup. The pool is not yet wired into
existing Tauri features; do not claim the production temporary connections were replaced.

## Project repository

`projects::ProjectRepo` maps `projectStore.ts:199` to `list_groups()` and
`projectStore.ts:200` to `list_projects()`, retaining `ORDER BY sort_order, name`.
`snapshot()` reads both tables in one transaction. All current Project/Group fields
are retained, including raw JSON and string enums. Parameterized `find_project()`
returns an optional record. `ProjectSnapshot::project_path()` mirrors `groupPath.ts`
nearest-bound-ancestor semantics with cycle and missing-parent termination.

`open_read_only()` opens an existing database without creating it, running migrations
or changing journal mode. GPUI's explicit `CLI_MANAGER_GPUI_DATABASE` entry uses this
path on its Tokio runtime, then closes the pool. Default data-root discovery now uses
the shared path rules; write operations and worktree rows remain pending.

`data_paths` contains the shared distribution, default-root, bootstrap-pointer and
absolute-path validation rules. The GPUI host uses these rules to resolve the same
default database location as Tauri, while keeping bootstrap switching and migration
repair in the host that owns startup policy.

## Host-owned exceptions

`pty_frame` contains the v1 binary header, directional validation and borrowed
daemon-output decoding. Tauri imports the shared implementation without changing wire
bytes. `cli-manager-pty-client` validates loopback credentials and handshake versions,
uses bounded request waits and heartbeat detection, and exposes output through a bounded
event queue. Consumers explicitly commit parsed output before legacy UTF-16 ACK.
`SessionLedger` separately tracks committed cursors, pending parse ownership and durable
in-process close tombstones; late parser callbacks cannot advance a replaced generation.
The reconnect session list excludes closed sessions. Integration of this ledger into the
live session coordinator, full reconnect/create-loss recovery and byte-ACK negotiation remain pending;
this transport foundation is not yet a complete replacement for PtyHostSocket.


- Tauri application setup and SQL plugin registration.
- TCP/DNS/socket and stdio proxy bridging.
- SSH credentials, AskPass broker and terminal I/O.
- Windows registry and process creation.
- UI events, paths, clipboard and native dialogs.

## Preferences

`cli-manager-core-prefs::PrefsStore` accepts an explicit host-provided root directory.
It reads plain JSON compatible with the store format and accepts validated single file
names through `PrefsFile`. Missing files use the caller type's default; unreadable or
invalid JSON files return errors and must never be overwritten with defaults.

Updates canonicalize the root, serialize same-path access within the process and acquire
an OS file lock on `<filename>.lock` across processes. JSON is written to a same-directory
temporary file, synced and persisted atomically; Unix also syncs the directory. Caller
types must use flattened unknown fields when round-trip preservation is required.
`settings::Settings` retains the full JSON map and fills missing top-level values from
the generated frontend defaults; it preserves null and stored nested objects verbatim.
Domain-specific validation and production host wiring remain outstanding.

Run `node scripts/export-settings-defaults.mjs` after changing frontend defaults and
`node scripts/export-settings-defaults.mjs --check` during verification. The generator
statically interprets literal constants and local imports and refuses unknown expression
types instead of executing frontend code. The generated defaults currently contain 125 keys.

Any new core API crossing one of these boundaries must accept an explicit host adapter or
callback instead of importing Tauri or creating platform processes/sockets.
