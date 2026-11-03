# Runtime Evidence and Confidence

## Scope

Read-only incident investigation followed by task planning on 2026-11-01.
No user app/daemon was terminated, no real OOM was induced, no dump memory body
was inspected, and no installed files were changed. Metadata only is retained
here; no log payloads, user input, secrets or environment values.

## Confirmed Incident Evidence

1. CLI-specific WebView2 Crashpad dump:
   C:\Users\Administrator\AppData\Local\com.cli-manager.app\EBWebView\Crashpad\reports\a3c68db1-d6f4-44c7-9b36-41b3621a4c5e.dmp
   - Header time: 2026-10-27 14:39:11 +08:00; PID 24996.
   - Exception: 0xe0000008; WebView2 155.0.4283.62.
   - Exception arguments: 0xf0000, 0xf5c0d4000, 0x52d000.
   - Allocation: 0.9375 MiB; reported commit constraint: 61.4383 GiB;
     available commit: 5.1758 MiB. These are post-failure samples, not a
     physical-RAM reading or proof that this app leaked memory.
   - KERNELBASE.dll is the exception-raise location, not a DLL corruption cause.
2. Windows Event 1002/WER:
   - 2026-10-27 10:12:33, 14:41:27; 2026-10-31 23:14:43:
     CLI-Manager 1.4.4, AppHangB1, top-level window idle.
   - 2026-10-24 21:13:23: cross-process AppHangXProcB1 involving
     msedgewebview2.exe. No GUI thread-stack dump is available.
   - Report timestamps are not necessarily the beginning of the hang.
3. cli-manager.log:
   - October 31: 81 reconcile failures, first line 6756 at 17:45:26,
     last line 7985 at 22:53:20.
   - Line 7991 at 23:12:24: exit cleanup started, without completion.
   - Lines 7993-7994 at 23:14:41: socket reset/daemon connection lost;
     Windows hang report followed at 23:14:43. Temporal proximity does not
     prove causality; the daemon might have been terminated after a hang.
4. crash.log: 76 records = 56 unclean_exit_detected + 20 webgl_context_lost.
   Unclean events can count both GUI and daemon and include forced termination
   or shutdown; they are not 56 proven software crashes.
5. Installed main binary D:\soft\CLI-Manager\cli-manager.exe:
   version 1.4.4, modified 2026-10-16 19:55:12, 46,193,152 bytes.
   Date, narrow binary feature checks and self-dispatch daemon behavior support
   absence of the October 24 recovery changes; version text alone is not a
   complete build identity because current source metadata also says 1.4.4.

## Confirmed Current Source Mechanisms

- App.tsx:802: close-sync timeout exists, but load() at line 813 is awaited
  before the Promise.race at line 814. Stalled loading is therefore unbounded.
- App.tsx:1480-1503: exit awaits backup, snapshot flush and PTY cleanup in order.
  Only overall start/completion logs are insufficient to locate a stuck stage.
- sessionSnapshotPersistence.ts:40,178: xterm callback cancellation is tied to
  disposal; serialize/checkpoint awaits have no bounded attempt deadline.
  Healthy tests cover disposal, but not an alive source whose callback stalls.
- terminalExitCleanup.ts:23: PTY close/shutdown dependencies are awaited without
  an operation-level deadline; failures must not be relabelled successful exit.
- crash_reporter.rs:183,244: a synchronous Tauri command reaches mutex-protected
  file serialization/write_and_sync; normal context I/O can block the GUI.
- terminal/commands.rs:244,262 and shutdown commands: async entry points call
  synchronous daemon methods; async syntax does not make recv_timeout nonblocking.
- daemon/client.rs:287: finite 10-second request wait, disconnected invalidation
  already present in master. ensure_daemon uses serialized blocking-worker
  connection recovery. Do not recreate the same repair.
- Native heartbeat already exists at 15 seconds; current crash context lacks
  the commit-memory evidence needed to attribute future OOM conditions.

These mechanisms are regression-test targets. They have not been proven to
explain every historical GUI hang. There is no confirmed memory-leak owner.

## Official References Consulted

- Chromium OOM exception constant:
  https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/allocator/partition_allocator/src/partition_alloc/oom.h
- Chromium exception argument collection (after allocation failure):
  https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/allocator/partition_allocator/src/partition_alloc/oom.cc
- Tauri v2 command execution, retrieved through Context7 on 2026-11-01:
  https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/calling-rust.mdx
  Sync commands default to the main thread; async commands use async tasks.
  Blocking disk/socket work still needs a blocking execution boundary.
- Microsoft PERFORMANCE_INFORMATION, fetched on 2026-11-01:
  https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-performance_information
  CommitTotal/CommitLimit/CommitPeak are pages; PageSize is bytes. CommitLimit
  can change with pagefile capacity and is not physical RAM.
- Microsoft PROCESS_MEMORY_COUNTERS_EX, fetched on 2026-11-01:
  https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex
  WorkingSetSize and PrivateUsage are bytes; PrivateUsage is process commit.

## Tool Availability and Baseline

- GitNexus MCP is not exposed; its documented local skill path is absent.
- CodeGraph was queried before source searches. Its exploration was verified
  against current source ranges and the owning Trellis contracts.
- Project dispatch_mode is inline. No new sub-agents were started.
- Scoped Node baseline: 23 tests passed; no source change or GUI reproduction.
- Branch: master at bbb11c33, matching local origin/master; no remote fetch.
- Pre-existing untracked .codegraph/ is not part of this task's changes.
