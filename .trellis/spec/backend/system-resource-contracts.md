# System Resource Contracts

## Scenario: CPU topology reporting

### 1. Scope / Trigger

- Applies when changing `system_resources_get_snapshot` CPU fields or the system resource panel CPU topology display.

### 2. Signatures

- Tauri command: `system_resources_get_snapshot(options, full_detail) -> Result<SystemResourceSnapshot, String>`
- CPU response fields: `usagePercent`, `physicalCoreCount`, `logicalProcessorCount`

### 3. Contracts

- `physicalCoreCount` is the physical CPU core count from `System::physical_core_count()`.
- `logicalProcessorCount` is `System::cpus().len()` and matches the per-logical-processor `cpuCores` entries.
- If the physical core count is unavailable or zero, fall back to `logicalProcessorCount`.
- The command is asynchronous. Collector initialization, locking and sampling run in a blocking worker, with one shared permit acquired before spawning; concurrent callers (resource panel + toolbar CPU meter) wait asynchronously for that permit instead of failing, so no blocking-thread queue builds up and the UI never shows a transient busy error. Each frontend poller keeps its own in-flight guard, bounding waiters by mounted instances. The worker owns the permit even if its IPC waiter is canceled. Existing per-section cache clocks and response fields are unchanged.
- UI topology text must distinguish cores from threads in both `zh-CN` and `en-US`.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Physical count is available and positive | Return it as `physicalCoreCount` |
| Physical count is unavailable or zero | Use `logicalProcessorCount` as the fallback |
| CPU sampling is disabled | Counts remain valid; usage values may be zero/empty |

### 5. Good / Base / Bad Cases

- Good: 10 physical cores and 16 logical processors display as `10 核 / 16 线程`.
- Base: no SMT CPU displays equal core and thread counts.
- Bad: using `System::cpus().len()` as the physical core count.

### 6. Tests Required

- Run `cargo check` after changing Rust snapshot fields.
- Run `npx tsc --noEmit` after changing serialized field names or frontend types.
- Manually confirm the topology text and logical-thread detail count on a known machine.

### 7. Wrong vs Correct

```rust
// Wrong: logical processors mislabeled as physical cores.
let core_count = system.cpus().len();

// Correct: report both topology dimensions explicitly.
let logical_processor_count = system.cpus().len();
let physical_core_count = System::physical_core_count()
    .filter(|count| *count > 0)
    .unwrap_or(logical_processor_count);
```

## Scenario: App memory accounting and system commit pressure

### 1. Scope / Trigger

- Applies when changing the status-bar `memory` / `appMemory` items, `app_memory_get_usage` / `app_memory_optimize`, `MemorySnapshot`, or `app::commit_pressure`.
- System commit (physical RAM + page file) can run out while physical memory still looks moderate. When it does, WebView2 allocations fail and the window turns black. Working set alone cannot predict this.

### 2. Signatures

- `AppMemoryGroup { bytes, workingSetBytes, processCount }`; `AppMemoryUsage { totalBytes, totalWorkingSetBytes, ... }`; `AppMemoryOptimizeResult { freedBytes, trimmedWorkingSetBytes, ... }`.
- `MemorySnapshot.commitBytes` / `commitLimitBytes: number | null` (system-wide, from `GetPerformanceInfo`).
- Event `system-commit-pressure` to the `main` window: `{ level: "high" | "critical", committedBytes, limitBytes, percent }`.

### 3. Contracts

- App memory `bytes` is per-process commit (Windows `PrivateUsage`, i.e. sysinfo `virtual_memory()`). Working set is reported separately and is not a subset of commit.
- The total counts only the app main process, WebView, and daemon. Terminal programs are shown with a count but are never counted in the total and never trimmed. Orphan processes are listed separately.
- Optimization trims working sets of app processes and kills verified orphans only. `freedBytes` is commit that was actually released. Trimming alone reduces `trimmedWorkingSetBytes`, not commit, and the UI must not present it as freed commit.
- The status-bar `memory` tone is the worse of physical usage and commit usage (≥85% warning, ≥95% danger), and it shows a `commit used / limit` row.
- The commit-pressure monitor runs regardless of status-bar settings. It starts 15 s after launch and polls every 10 s. It alerts once when the level rises (85% high, 95% critical) and rearms only after usage falls 5 percentage points below that threshold.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Commit counters unavailable or limit is zero | `commitBytes`/`commitLimitBytes` are `null`; monitor skips the round without alerting |
| Commit stays above a threshold | No repeated alert |
| Commit crosses 85%, then 95% | One `high` alert, then one `critical` alert |
| Window hidden to tray during an alert | Toast is not seen; the warning is still logged (known limitation) |

### 5. Good / Base / Bad Cases

- Good: 54 / 63 GB commit shows a yellow memory item and one warning toast, even though physical memory is only 55% used.
- Base: commit below 85% shows no hint and no toast.
- Bad: summing working sets as "app memory" and reporting `EmptyWorkingSet` as freed memory, while commit, the resource that actually runs out, is unchanged.

### 6. Tests Required

- Rust: commit-pressure hysteresis, a missing limit, commit vs working-set measurement on the current process, and total exclusion of terminal and orphan processes.
- `npx tsc --noEmit` after changing serialized field names.

### 7. Wrong vs Correct

```rust
// Wrong: working set is reclaimable and is not what exhausts commit.
let bytes = process.memory();

// Correct: Windows commit for accounting, working set reported separately.
let commit_bytes = process.virtual_memory();
let working_set_bytes = process.memory();
```
