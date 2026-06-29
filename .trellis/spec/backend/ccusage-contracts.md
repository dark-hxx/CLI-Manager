# ccusage Contracts

> Executable contracts for ccusage runtime selection, Tauri command arguments, cache scope, and settings-driven WSL behavior.

---

## Scenario: explicit ccusage WSL runtime switch

### 1. Scope / Trigger

- Trigger: changes touching `ccusage_refresh_report`, `ccusageStore`, `GeneralSettingsPage`, cache-key selection, or any logic that decides whether ccusage runs in Windows or WSL.
- This is a cross-layer contract because the frontend persists `ccusageUseWsl`, React panels compute runtime readiness from it, `ccusageStore` chooses cache scope from it, and Rust commands must honor it when building runtime/env targets.

### 2. Signatures

Rust command payloads:

```rust
#[tauri::command]
pub async fn ccusage_get_status(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<CcusageToolStatus, String>

#[tauri::command]
pub async fn ccusage_refresh_report(
    source: String,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    use_wsl: bool,
) -> Result<CcusageReportResponse, String>
```

Frontend settings / store surfaces:

```ts
interface Settings {
  ccusageAnalyticsEnabled: boolean;
  ccusageUseWsl: boolean;
}

function resolveCcusageRuntimeScope(
  source: CcusageSource,
  claudeConfigDir: string | null | undefined,
  codexConfigDir: string | null | undefined,
  useWsl?: boolean
): { kind: "host" } | { kind: "wsl"; distro: string } | { kind: "mixed"; reason: "host-wsl" | "multi-wsl" }
```

### 3. Contracts

- `ccusageUseWsl` is the only explicit switch deciding whether ccusage may run in WSL. Default is `false`.
- When `ccusageUseWsl === false`, runtime selection must resolve to `host` even if Claude/Codex config directories point at `\\wsl.localhost\...` or `\\wsl$\...`.
- When `ccusageUseWsl === false`, frontend cache keys must also resolve to the host scope so Windows and WSL reports do not share one cache bucket.
- When `ccusageUseWsl === false`, Rust must pass config directory env vars as raw Windows/UNC paths; do not rewrite them to Linux paths.
- Only when `ccusageUseWsl === true` may runtime selection parse WSL UNC config paths and switch the report execution target to `wsl.exe`.
- `ccusage_get_status` remains observational: it may still report both host and discovered WSL tool status regardless of the toggle, because the settings UI needs to show readiness before the user enables WSL execution.
- `CcusageStatsPanel` must derive readiness, prepare-card warnings, mixed-runtime warnings, and WSL install hints from the explicit runtime scope, not merely from the existence of any WSL config path.
- Host install CTA (`installTools()` without WSL target) must only show when the active runtime scope is `host`.

### 4. Validation & Error Matrix

| Condition | Expected behavior |
|------|------|
| `ccusageUseWsl = false` + config dirs are host paths | Run host ccusage; cache scope = `host` |
| `ccusageUseWsl = false` + config dirs are WSL UNC paths | Still run host ccusage; pass UNC env vars through unchanged |
| `ccusageUseWsl = true` + one source resolves to one WSL distro | Run WSL ccusage in that distro |
| `ccusageUseWsl = true` + source `all` mixes host + WSL | Return the existing mixed-runtime error; frontend must show the mixed-runtime hint |
| `ccusageUseWsl = true` + source `all` sees multiple WSL distros | Return the existing multi-distro error; frontend must show the conflict hint |
| `ccusageUseWsl = true` + current source runtime is WSL but bunx missing | Refresh stays disabled; prepare card shows WSL manual hint |
| `ccusageUseWsl = true` + no current source WSL runtime | Fall back to host for that source; do not show unrelated WSL install hint |

### 5. Good / Base / Bad Cases

Good:

```ts
const runtimeScope = resolveCcusageRuntimeScope(
  source,
  settings.claudeHookConfigDir,
  settings.codexHookConfigDir,
  settings.ccusageUseWsl
);
```

Base:

```rust
let (target, envs) = resolve_runtime_for_source(
    &source,
    claude_config_dir,
    codex_config_dir,
    use_wsl,
)?;
```

Bad:

```ts
// Wrong: silently switches to WSL whenever a config dir looks like \\wsl.localhost\...
const runtimeScope = resolveCcusageRuntimeScope(source, claudeDir, codexDir);
```

### 6. Tests Required

- Frontend:
  - `npx tsc --noEmit`
  - With `ccusageUseWsl = false`, verify Usage Analysis settings still load and the panel no longer shows WSL-only prepare hints for host runtime.
  - With `ccusageUseWsl = true`, verify current-source WSL readiness/hints and mixed-runtime messages still match the actual source.
- Backend:
  - `cd src-tauri && cargo check`
  - Assert `ccusage_refresh_report(..., use_wsl = false)` keeps host runtime even for WSL UNC config dirs.
  - Assert `ccusage_refresh_report(..., use_wsl = true)` still converts WSL UNC config dirs to Linux paths and runs via WSL target.

### 7. Wrong vs Correct

#### Wrong

```rust
let claude = resolve_config_dir(claude_config_dir, "Claude")?;
// WSL UNC path immediately becomes RuntimeTarget::Wsl, regardless of user preference.
```

#### Correct

```rust
let claude = resolve_config_dir_for_runtime(claude_config_dir, "Claude", use_wsl)?;
// Only convert UNC -> Linux path and switch target when the explicit toggle is on.
```
