# Terminal Runtime Monitoring Contracts

> Executable contracts for terminal tab runtime status events that cross the Rust PTY boundary and the React/Zustand UI boundary.

---

## Scenario: CLI hook settings installation status

### 1. Scope / Trigger

- Trigger: hook installation spans Rust file writes, user-level Claude/Codex config files, local hook bridge environment variables, and React settings status display.
- This is a cross-layer contract because Rust mutates external CLI config while frontend renders install completeness from backend status fields.

### 2. Signatures

- Tauri hook settings commands:

```rust
pub async fn hook_settings_get_status(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String>

pub async fn hook_settings_install_codex(
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
) -> Result<HookSettingsStatus, String>
```

- Status response fields:

```ts
interface ToolHookSettingsStatus {
  configDir: string | null;
  hooksDir: string | null;
  configPath: string | null;
  featureConfigPath: string | null;
  status: "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";
  runningHookInstalled: boolean;
  attentionHookInstalled: boolean;
  stopHookInstalled: boolean;
  failureHookInstalled: boolean;
  hooksFeatureInstalled: boolean;
}
```

### 3. Contracts

- Codex install writes only user-level config:

| File | Required write | Contract |
|---|---|---|
| `~/.codex/hooks.json` | Yes | Register `UserPromptSubmit`, `PermissionRequest`, and `Stop` commands. |
| `~/.codex/hooks/notify-cli-manager-codex-attention.ps1` | Yes | Sends `source="codex"` and event `UserPromptSubmit` or `PermissionRequest`. |
| `~/.codex/hooks/notify-cli-manager-codex-finished.ps1` | Yes | Sends `source="codex"` and event `Stop`. |
| `~/.codex/config.toml` | Yes | Ensure `[features] hooks = true`. |
| `<project>/.codex/hooks.json` | No | Must not be modified by one-click install. |

- Codex status is `installed` only when all of these are true:
  - attention script exists;
  - finished script exists;
  - `UserPromptSubmit` command is registered exactly;
  - `PermissionRequest` command is registered exactly;
  - `Stop` command is registered exactly;
  - `[features] hooks = true` is present in `config.toml`.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `codex_selected_dir` is empty | Resolve `~/.codex`, creating it only during install. |
| `hooks.json` is missing or empty | Treat as `{}` and create the `hooks` object. |
| `hooks.json` root is not an object | Return an error; do not overwrite unrelated content. |
| `config.toml` lacks `[features]` | Append `[features]` and `hooks = true`. |
| `config.toml` has `[features] hooks = false` | Replace only that line with `hooks = true`. |
| `config.toml` cannot be read or written | Return an error and report partial install through status. |
| Codex TUI has not approved hooks | Config may show installed; user still needs Codex `/hooks` approval outside this app. |

### 5. Good/Base/Bad Cases

- Good: clicking install writes user-level Codex hook scripts, registers all three hook events, enables `[features].hooks`, and the settings page shows every row as installed.
- Base: user has only old `PermissionRequest` and `Stop` hooks; status is partial until `UserPromptSubmit` and `[features].hooks` are added.
- Bad: modifying a project-level `.codex/hooks.json` would surprise users and must not happen.

### 6. Tests Required

- Rust assertions:
  - `set_toml_feature_hooks` appends `[features] hooks = true` when missing.
  - `set_toml_feature_hooks` replaces an existing `hooks` key only inside `[features]`.
  - Codex status returns `installed` only when `hooksFeatureInstalled` and all hook commands are true.
- Frontend assertions:
  - Codex settings page renders `config.toml` and `[features].hooks` status.
  - Missing `hooksFeatureInstalled` never displays Codex status as fully installed.

### 7. Wrong vs Correct

#### Wrong

```rust
// Only checks hooks.json, so config.toml can be missing while UI says installed.
let installed = running_hook && attention_hook && stop_hook;
```

#### Correct

```rust
let installed = running_hook && attention_hook && stop_hook && hooks_feature_installed;
```

## Scenario: Shell runtime status markers for terminal tabs

### 1. Scope / Trigger

- Trigger: terminal tab runtime status spans Rust PTY creation, shell environment variables, PowerShell/pwsh session injection, xterm output parsing, and Zustand tab status state.
- This is a cross-layer contract because Rust emits terminal output, frontend strips protocol markers, and UI renders the resulting status.
- MVP scope: PowerShell / pwsh only. bash / zsh may be added later but must use the same event contract.

### 2. Signatures

- Tauri command signature remains stable:

```rust
pub async fn pty_create(
    session_id: String,
    cwd: Option<String>,
    shell: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    state: State<'_, AppState>,
) -> Result<String, String>
```

- PTY manager contract:

```rust
pub fn create(
    &self,
    session_id: &str,
    cwd: Option<&str>,
    shell: Option<&str>,
    env_vars: Option<HashMap<String, String>>,
) -> Result<(), String>
```

- Frontend runtime event payload:

```ts
export type ShellRuntimeEventName = "command_started" | "command_finished" | "prompt_shown";

export interface ShellRuntimePayload {
  sessionId: string;
  event: ShellRuntimeEventName;
  exitCode?: number | null;
  timestamp?: string | null;
}
```

### 3. Contracts

- Environment keys:

| Key | Required | Owner | Contract |
|---|---:|---|---|
| `CLI_MANAGER_TAB_ID` | Yes | Rust `pty_create` | Must equal the frontend session id for the PTY. |
| `CLI_MANAGER_SHELL_RUNTIME_MONITORING` | Optional | Frontend `terminalStore` | Value `"1"` enables shell runtime monitoring for a new PTY. Missing or any other value disables injection. |

- Setting default and opt-in behavior:
  - `settingsStore.DEFAULTS.shellRuntimeMonitoringEnabled` must be `false`.
  - Missing or invalid persisted values load as disabled; explicit saved booleans must be preserved (`true` stays enabled, `false` stays disabled).
  - The settings UI must keep a user-facing "通用 Shell 运行监控" switch so users can opt in.
  - Enabling applies only to newly-created supported terminals; existing PTY sessions are not retrofitted.
  - Rationale: the PowerShell / pwsh implementation launches through a prompt wrapper (`-Command <script>`) to emit private OSC status markers, which can make prompt-ready time slightly slower. Do not re-enable this by default without measuring startup impact.

- Git Bash startup contract:
  - Windows `gitbash` must resolve through `resolve_git_bash_exe()` and start as an interactive Git for Windows shell.
  - Monitoring disabled: launch as `bash.exe --login -i` so Git for Windows `/etc/profile` initialization runs.
  - Monitoring enabled: launch as `bash.exe --rcfile <cli-manager-temp-rcfile> -i`; the temp rcfile must source `/etc/profile` before appending CLI-Manager OSC hooks.
  - Git Bash PTYs created with a project `cwd` must set `CHERE_INVOKING=1` so Git for Windows profile initialization does not force the shell back to `$HOME`.
  - Git Bash may emit its first prompt before React has mounted `XTermTerminal` and subscribed to `pty-output-<sessionId>`; the backend reader must defer the initial Git Bash read/emit briefly so the first prompt is not lost.

- Private OSC marker format:

```text
ESC ] 777 ; cli-manager ; session=<sessionId> ; event=<eventName> [ ; exit=<number> ] BEL
```

- Event fields:

| Field | Type | Required | Contract |
|---|---|---:|---|
| `session` | string | Yes | Must identify the originating terminal session. |
| `event` | enum | Yes | One of `command_started`, `command_finished`, `prompt_shown`. |
| `exit` | number | Only for `command_finished` | `0` means completed; non-zero means failed. |

- Status mapping:

| Source event | Tab state | Label |
|---|---|---|
| `command_started` | `running` | `运行中` |
| `command_finished` with `exit=0` | `done` | `已完成` |
| `command_finished` with non-zero `exit` | `failed` | `异常退出` |
| `prompt_shown` | no state change | no UI label change |

- Combined status priority:

```text
attention > failed > running > done > none
```

Hook-driven `attention` must win over shell runtime state until the user activates the tab and clears the hook source.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Persisted `shellRuntimeMonitoringEnabled` is missing or invalid | Load as disabled (`false`); new PowerShell / pwsh PTY must not receive `CLI_MANAGER_SHELL_RUNTIME_MONITORING=1`. |
| Persisted `shellRuntimeMonitoringEnabled` is explicit `true` | Preserve the user opt-in; newly-created PowerShell / pwsh PTY may receive `CLI_MANAGER_SHELL_RUNTIME_MONITORING=1`. |
| Monitoring setting is disabled | New PTY must not receive `CLI_MANAGER_SHELL_RUNTIME_MONITORING=1`; frontend must ignore shell runtime events for that shell. |
| Shell is not PowerShell / pwsh | Do not inject PowerShell prompt wrapper. Use that shell's own supported launch path. |
| Shell is omitted | Do not inject shell runtime monitoring from the frontend. The Rust PTY boundary chooses the platform default shell. |
| Non-Windows receives a Windows-only shell key (`powershell`, `cmd`, `wsl`, `gitbash`) | Treat it as unsupported for runtime injection and fall back to the platform default shell path instead of spawning `.exe` binaries. |
| Windows Git Bash launches with monitoring disabled | Use `--login -i`; a bare `bash.exe` can skip Git for Windows profile initialization and appear stuck before the first prompt. |
| Windows Git Bash launches with monitoring enabled | Keep `--rcfile <temp> -i`, but the rcfile must source `/etc/profile` before registering CLI-Manager hooks. |
| Windows Git Bash opens for a project path | Preserve the requested `cwd` by setting `CHERE_INVOKING=1`; do not let login/profile startup cd back to `$HOME`. |
| Windows Git Bash emits its initial prompt immediately after spawn | Delay the initial Git Bash reader loop briefly before emitting PTY output; do not rely on opening additional tabs to recreate the prompt. |
| OSC marker is split across output chunks | Buffer until `BEL`, then parse and strip before writing to xterm. |
| OSC marker remains unterminated beyond the safety limit | Drop the buffered private marker fragment instead of writing it to xterm. |
| Unknown event name | Ignore the marker and do not update status. |
| Invalid or missing `exit` on `command_finished` | Treat as failure only when the parsed number is finite and non-zero; otherwise do not invent success. |
| Hook and shell state conflict | Resolve by priority, never by last-write-wins alone. |

### 5. Good/Base/Bad Cases

- Good: PowerShell with explicit user opt-in emits `command_finished;exit=0`; frontend strips the marker and tab shows `已完成` with the updated timestamp.
- Base: Monitoring is missing/default-disabled; PowerShell starts normally and tab state only changes from hook events or direct UI actions.
- Bad: Defaulting new users to monitoring-enabled makes every new PowerShell / pwsh terminal pay prompt-wrapper startup cost before they ask for ordinary shell command status.
- Bad: An unterminated OSC marker appears in terminal output; the parser must not leak `]777;cli-manager` text into xterm.

### 6. Tests Required

- Settings migration/default assertions:
  - Missing `shellRuntimeMonitoringEnabled` falls back to `false`.
  - Explicit saved `true` remains `true`; explicit saved `false` remains `false`.
  - Settings UI copy states the feature is default-off/opt-in, only affects newly-created PowerShell / pwsh terminals, and may slightly increase startup time.
- TypeScript status reducer assertions:
  - `attention` beats `failed`, `running`, and `done`.
  - `failed` beats `running` and `done`.
  - Clearing hook source reveals the remaining shell status if present.
- xterm parsing assertions:
  - Complete private OSC markers are stripped from visible output.
  - Split markers across chunks are reconstructed.
  - Over-limit unterminated fragments are dropped.
- Rust boundary assertions when feasible:
  - PowerShell / pwsh with monitoring enabled includes `-NoExit -Command` and the prompt wrapper.
  - Git Bash with monitoring disabled includes `--login -i`.
  - Git Bash with monitoring enabled includes `--rcfile <temp> -i`, and the generated rcfile sources `/etc/profile`.
  - Git Bash PTY env includes `CHERE_INVOKING=1` without overwriting an explicit caller-provided value.
  - Git Bash initial reader delay exists only for Windows `gitbash`, not for PowerShell / cmd / WSL / Unix shells.
  - macOS/Linux with omitted shell or Windows-only stale shell never resolves to `powershell.exe`, `cmd.exe`, or `wsl.exe`.
  - Non-PowerShell shells keep their normal argument list.
  - `pty_create` always injects `CLI_MANAGER_TAB_ID`.

### 7. Wrong vs Correct

#### Wrong

```ts
// Last write wins: a background shell completion can hide a pending approval.
tabNotifications[sessionId] = shellStatus;
```

#### Correct

```ts
// Keep per-source state, then resolve by explicit priority.
const candidates = [state.hook ?? "none", state.shell ?? "none"];
const visible = candidates.reduce(
  (current, next) => (TAB_STATUS_PRIORITY[next] > TAB_STATUS_PRIORITY[current] ? next : current),
  "none"
);
```

#### Wrong

```rust
// Modifies user profile or requires persistent shell configuration.
// This leaks application behavior outside the PTY session.
```

#### Correct

```rust
// Inject only into this PTY session.
vec!["-NoLogo".to_string(), "-NoExit".to_string(), "-Command".to_string(), script]
```

#### Wrong

```rust
// Bare Git Bash can miss Git for Windows profile initialization.
Ok((git_bash_path, Vec::new()))
```

#### Correct

```rust
// Plain Git Bash sessions run the normal interactive login initialization.
Ok((git_bash_path, vec!["--login".to_string(), "-i".to_string()]))
```

## Scenario: PTY process tree cleanup

### 1. Scope / Trigger

- Trigger: terminal tab close, split-pane removal, and full app exit must clean up processes created by CLI-Manager PTY sessions.
- This is a cross-layer contract because React initiates close/exit, Tauri commands cross the WebView boundary, and Rust owns the process handles.

### 2. Signatures

```rust
pub async fn pty_close(
    pty_manager: tauri::State<'_, PtyManager>,
    session_id: String,
) -> Result<(), String>

pub async fn pty_close_all(
    pty_manager: tauri::State<'_, PtyManager>,
) -> Result<(), String>

pub async fn pty_reconcile_active_sessions(
    pty_manager: tauri::State<'_, PtyManager>,
    active_session_ids: Vec<String>,
) -> Result<PtyOrphanCleanupSummary, String>

pub fn close(&self, session_id: &str) -> Result<(), String>
pub fn close_all(&self) -> Result<(), String>
pub fn reconcile_active_sessions(
    &self,
    active_session_ids: Vec<String>,
) -> PtyOrphanCleanupSummary
```

### 3. Contracts

- `pty_close` remains the per-session close command used by tab close and split cleanup.
- `pty_close_all` closes every session currently tracked by `PtyManager`; app exit must call it before clearing persisted session state and destroying the window.
- `pty_reconcile_active_sessions` is a conservative fallback only: the frontend reports currently active PTY-backed terminal session ids, and the backend compares that set with `PtyManager.sessions`.
- Orphan reconciliation must never scan or kill by process name; only missing session ids already owned by `PtyManager` are eligible.
- Orphan reconciliation must ignore an empty active list, protect newly-created sessions, mark missing sessions first, and only close a missing session after the grace period.
- Windows cleanup must target the PTY root PID returned by `portable_pty::Child::process_id()` and terminate that process tree.
- Windows cleanup must not scan by process name (`codex.exe`, `bash.exe`, etc.); only the owned PTY process tree is eligible.
- Non-Windows cleanup keeps the existing direct child kill behavior unless a platform-specific process-tree mechanism is explicitly added later.
- On Windows, `close_all` should batch process-tree termination into a single `taskkill /F /T /PID <pid> ...` call for all known PTY root PIDs, then still call each child handle's direct kill as a fallback.
- `close_all` must not hold the global sessions map lock while running `taskkill` or joining reader threads. Snapshot/remove sessions first, then perform blocking cleanup.
- `close()` remains the per-session path; do not make tab close wait for unrelated sessions.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `pty_close` receives an unknown `session_id` | Treat as a no-op and return `Ok(())`. |
| Windows child PID is available | Run process-tree termination for that PID, then still call child kill as a fallback. |
| Windows process-tree termination fails | Log a warning and fall back to `portable_pty::Child::kill()`; do not block tab close. |
| Windows child PID is missing | Skip tree termination and use direct child kill. |
| `pty_close_all` runs while sessions are active on Windows | Remove/snapshot all sessions, batch owned root PIDs into one `taskkill /F /T` call, then direct-kill each child and join readers. |
| `pty_close_all` runs while sessions are active on non-Windows | Keep the existing per-session close behavior unless a platform-specific tree cleanup is added. |
| App exit cleanup fails to close PTYs | Log the error and continue the exit path so the app does not hang. |
| `pty_reconcile_active_sessions` receives an empty active list | Skip cleanup and return a summary with `skipped_empty_active_list=true`. |
| A backend session is absent from the active list but newly created | Keep it alive during the startup protection window. |
| A backend session is absent from the active list for the first time | Mark it missing and keep it alive until the grace period expires. |
| A backend session remains absent past the grace period | Remove it from `PtyManager.sessions` and close only that owned PTY process tree. |
| A previously missing backend session appears in a later active list | Clear its missing marker and keep it alive. |

### 5. Good/Base/Bad Cases

- Good: closing a Codex terminal launched through Git Bash removes the shell and its `codex.exe` descendants.
- Good: app exit with many active terminals issues one scoped Windows `taskkill` for all owned PTY root PIDs instead of spawning one `taskkill` per session.
- Good: if a frontend tab is lost while its backend PTY session remains, reconciliation closes that owned PTY tree only after the missing grace period.
- Base: closing an already-exited session is harmless; stale status entries are removed.
- Bad: killing all system processes named `codex.exe` or `bash.exe` may terminate work started outside CLI-Manager and is forbidden.
- Bad: treating one empty frontend heartbeat as proof that every PTY is orphaned may kill valid sessions during restore or reload.
- Bad: `close_all` loops through `close()` on Windows and spawns N `taskkill` processes serially, causing visible app-exit lag.

### 6. Tests Required

- Rust checks: `cd src-tauri && cargo check` and `cd src-tauri && cargo test`.
- Frontend checks: `npx tsc --noEmit` or `npm run build` when the exit path changes.
- Manual Windows verification: open a Git Bash/Codex terminal, close its tab, and confirm the associated process tree no longer remains in Task Manager.
- Manual Windows verification: exit the app with active PTY sessions and confirm owned PTY child processes are gone.
- Manual Windows verification: temporarily remove a tab from frontend state without calling `pty_close`, then confirm the backend marks it missing before killing it after the grace period.
- Regression check: app exit with multiple active PTYs should not spawn one `taskkill` per session on Windows; the full-exit cleanup path should remain bounded by one batch command plus reader joins.

### 7. Wrong vs Correct

#### Wrong

```rust
// Process-name cleanup can kill unrelated user work.
taskkill /IM codex.exe /F
```

#### Correct

```rust
// Per-session cleanup is scoped to the PTY root process owned by this session.
taskkill /PID <pty-root-pid> /T /F

// Full app exit batches all owned PTY roots once, then direct-kills children as fallback.
taskkill /F /T /PID <pty-root-1> /PID <pty-root-2>
```
