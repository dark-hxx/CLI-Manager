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
