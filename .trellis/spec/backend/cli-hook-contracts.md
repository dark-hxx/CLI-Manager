# CLI Hook Contracts

Concrete contracts for Claude/Codex hook integration.

## Scenario: Per-Tool Hook Bridge Enablement

### 1. Scope / Trigger

- Trigger: users may install only Claude Code or only Codex CLI, so the unused bridge must not keep the shared Hook health indicator in a warning state.
- Applies to: persisted frontend settings, Hook settings UI, sidebar health/reinstall behavior, stats availability checks, Claude auto-repair, and terminal Hook environment injection.

### 2. Signatures

```ts
interface Settings {
  claudeHookBridgeEnabled: boolean;
  codexHookBridgeEnabled: boolean;
}
```

- Both settings default to `true` for backward compatibility.
- Backend `hook_settings_get_status` keeps its existing signature; frontend callers gate `autoRepair` and interpret the returned per-tool status through the enable settings.

### 3. Contracts

- Disabled tools are excluded from the sidebar Hook health aggregation and one-click reinstall target list.
- A disabled tool keeps only its settings-section header, enable switch, and status pill visible; module cards, paths, install notes, and install/remove actions are not rendered until the bridge is enabled again.
- When both tools are disabled, the sidebar light is neutral/gray and clicking it only opens Hook settings.
- Claude auto-repair may be requested only when `claudeHookBridgeEnabled && claudeHookAutoRepairKnownInstalled`.
- Stats availability is true only when at least one enabled tool reports `status === "installed"`.
- New terminals inject the shared Hook bridge environment only when at least one enabled tool reports `status === "installed"`.
- Disabling a bridge does not uninstall or rewrite existing user Hook files.

### 4. Validation & Error Matrix

| Condition | Behavior |
|-----------|----------|
| Stored enable value is missing/invalid | Use default `true` |
| Claude disabled, Codex installed/enabled | Health is green; no Claude auto-repair |
| Codex disabled, Claude installed/enabled | Health is green; Claude auto-repair may run when previously installed |
| Both disabled | Neutral light; no reinstall; no Hook env injection |
| Enabled tool status request fails | Preserve existing caller error handling; do not assume installed |

### 5. Good/Base/Bad Cases

- Good: a Claude-only user disables Codex and gets a green health light when Claude is fully installed.
- Good: disabling Codex immediately collapses its detail content; enabling it again restores the detail content from the existing status and local UI state.
- Base: an existing user upgrades with no stored enable settings; both bridges remain enabled.
- Bad: a disabled Codex bridge remains part of the shared health aggregation and keeps the light yellow.
- Bad: disabling Claude still sends `autoRepair: true` and rewrites Claude settings.

### 6. Tests Required

- TypeScript type-check after settings fields, migration, or status filtering changes.
- Manual settings persistence check across restart for both switches.
- Manual settings UI check: disabling either bridge collapses only that bridge's detail content and enabling it restores the content.
- Manual health matrix: Claude-only, Codex-only, both enabled, both disabled, and partial enabled installation.
- Manual terminal check: both disabled must not inject the Hook bridge environment into new PTY sessions.

### 7. Wrong vs Correct

#### Wrong

```ts
return status.claude.status === "installed" || status.codex.status === "installed";
```

#### Correct

```ts
return (
  (settings.claudeHookBridgeEnabled && status.claude.status === "installed") ||
  (settings.codexHookBridgeEnabled && status.codex.status === "installed")
);
```

## Scenario: Sub-Agent Transcript Hook

### 1. Scope / Trigger

- Trigger: a CLI emits `SubagentStart`, or Claude emits `PreToolUse`/`PostToolUse` for `Agent`/`Task` as fallback lifecycle signals; CLI-Manager opens a read-only transcript pane for that child agent and marks it finished after the matching stop signal.
- Applies to: hook installation, hidden `__hook` client, local TCP bridge payload, frontend `CliHookPayload`, and transcript subscription.

### 2. Signatures

- Installed hook command: `<cli-manager-exe> __hook --source <claude|codex> --event <event>`.
- Hook command quoting: Windows-native exe paths are wrapped by a PowerShell command with single-quote escaping; WSL/macOS/Linux exe paths are POSIX shell single-quoted (`'...'\''...'`). Keep the command shape `<exe> __hook --source <source> --event <event>`.
- Bridge event name: `claude-hook-notification`.
- Frontend subscribe command: `subagent_transcript_subscribe({ key, transcriptPath, cwd, sessionId, agentId }) -> { path, initialContent }`.
- Codex rollout discovery command: `codex_subagent_transcript_discover({ parentSessionId, agentId, codexConfigDir, wslDistroName, parentTranscriptPath }) -> string | null`.
- Frontend store action on start/update: `openSubagentTranscript(payload)`.
- Frontend store action on stop: `finishSubagentTranscript(payload)`.
- Frontend transcript state: `SubagentTranscriptContent { content: string; ended: boolean; source?: SubagentTranscriptSource; truncatedBytes?: number; resetSeq: number }`.
- Frontend transcript view prop: `SubagentTranscriptView({ sessionId, title, isVisible })`.
- Agent tool fallback hook names: `AgentToolStart` (from PreToolUse with matcher Agent), `AgentToolStop` (from PostToolUse with matcher Agent).

### 3. Contracts

- Common payload fields: `tabId`, `source`, `event`, `title`, `message`, `sessionId`, `cwd`, `timestamp`, optional `wslDistroName`, optional `reasoningEffort`.
- Claude Code effort display is hook-derived, not history-derived: `__hook` reads `effort.level` (plus flat legacy keys such as `reasoning_effort` / `effort_level`) and falls back to `$CLAUDE_EFFORT`. The frontend may use that value as a realtime-only fallback when `HistorySessionUsage.reasoning_effort` is absent.
- Claude Agent tool fallback events are normalized as `AgentToolStart` from `PreToolUse` and `AgentToolStop` from `PostToolUse`; hook installer must use a matcher limited to `Agent`/`Task`.
- Claude sub-agent fields: `agentId`, `toolUseId`, `agentType`, `agentTranscriptPath`.
- Codex sub-agent fields: `agentId`, `agentType`, `transcriptPath`.
- Frontend transcript source resolution:
  - Use `agentTranscriptPath` only when it is present and differs from `transcriptPath`; this is `child-jsonl` mode.
  - Do not silently render the full parent `transcriptPath` as child output when `agentTranscriptPath` is missing or equals `transcriptPath`; degrade to `parent-jsonl` filtered mode or `lifecycle-only` mode.
  - Backend derivation from `cwd/sessionId/agentId` remains available for explicit transcript subscriptions, but frontend must not use it to disguise a parent transcript as child output.
  - WSL sub-agent transcript derivation requires `wslDistroName` from the hook environment (`WSL_DISTRO_NAME`); explicit Linux transcript paths are converted to `\\wsl.localhost\<distro>\...` before tailing.
  - If `wslDistroName` is missing but `cwd` is a WSL UNC path such as `\\wsl.localhost\Ubuntu\data\repo`, frontend and backend may derive the distro from the UNC prefix. The derived distro is only a fallback for child transcript discovery/subscription; it must not make explicit `/home/...` paths look like WSL when no distro or UNC cwd is available.
  - Claude may emit `ToolStart` / `ToolStop` payloads carrying `agentId` instead of normalized `AgentToolStart` / `AgentToolStop` in some WSL hook paths. Treat `source=claude` plus `ToolStart|ToolStop` plus non-empty `agentId` as a sub-agent transcript lifecycle hint, but do not treat ordinary tool events without `agentId` as sub-agents.
  - Explicit native POSIX transcript paths such as `/Users/...` or `/home/...` must be tailed as native paths when `wslDistroName` is missing. Do not infer a default WSL distro for explicit `/...` paths.
  - `AgentToolStart` should create/update a `pending` pane only; it must not subscribe to the parent transcript.
  - When a Claude start/update event already has `cwd`, `sessionId`, and `agentId`, the frontend may subscribe to the derived child JSONL immediately. The backend tail waits for the child file to appear, so streaming must not wait for the stop event.
  - `AgentToolStop` and Claude `ToolStop` with `agentId` may upgrade the matching pending pane to `child-jsonl` when they have an independent `agentTranscriptPath` or enough `cwd/sessionId/agentId` data to derive `subagents/agent-<agentId>.jsonl`.
- Codex `SubagentStart` rollout discovery is eventually consistent: when the first discovery returns no path, the frontend performs a bounded per-child retry and subscribes as soon as the matching rollout appears. Retries stop after subscription, timeout, finish, pane close, or unsplit.
- Codex rollout discovery must preserve the Hook runtime boundary: when `wslDistroName` is present, prefer the parent rollout's `/sessions/` root, otherwise resolve that distro's `$HOME` and scan its `.codex/sessions` through `wsl.exe`; never substitute the Windows process user's `.codex/sessions`. A configured Codex root may be a Linux absolute path, WSL UNC path, or Windows path convertible to `/mnt/<drive>` and takes precedence over the parent path.
- `SubagentStop` may also carry the first independent child transcript path. When a matching pane already exists, the frontend must call `openSubagentTranscript(payload)` and await subscription/initial backfill before `finishSubagentTranscript(payload)`, regardless of CLI source.
- Subscribe response fields:
  - `path`: resolved child JSONL path actually tailed by the backend.
  - `initialContent`: existing complete JSONL lines already present before tail startup. The frontend must append this immediately; the backend tail starts after the consumed offset to avoid duplicate output.
- `SubagentStart` and `SubagentStop` must be installed/uninstalled together for each source. Claude `PreToolUse`/`PostToolUse` Agent/Task fallback hooks must be installed/uninstalled with the Claude subagent hooks.
- Stop routing priority: match by `agentId`; if missing, close only when exactly one transcript pane belongs to the parent `tabId`.
- Transcript rendering performance contract:
  - Backend transcript tail emits complete JSONL lines only; the frontend may parse appended suffixes incrementally when `resetSeq` is unchanged and `content.length` only grows.
  - Frontend increments `resetSeq` whenever `reset=true` or content is front-trimmed. A `resetSeq` change is the only signal that consumers must discard parse cache and rebuild from the retained tail.
  - A hidden transcript pane (`isVisible=false`) must not subscribe to or parse `content`; it may keep rendering its cached snapshot and must catch up once visible again.
  - The transcript view must cap rendered message rows (currently 300) and display an omitted-count marker rather than rendering an unbounded list.
  - `MarkdownContent` used for transcript messages must remain memo-safe; do not pass fresh object props that defeat memoization on every append.

### 4. Validation & Error Matrix

- Empty or overlong `tabId` -> bridge rejects with `400 invalid payload`.
- Unknown `source` -> bridge rejects with `400 invalid payload`.
- Event not allowed for its source -> bridge rejects with `400 invalid payload`.
- Missing explicit transcript path and missing derivation fields -> `subagent_transcript_subscribe` returns the specific missing field error.
- WSL derivation requested but `wsl.exe` cannot return `$HOME` -> subscription fails and the frontend keeps the degraded transcript source state.
- WSL Codex discovery receives a config path that is neither Linux absolute, WSL UNC, nor convertible Windows absolute -> return `invalid_wsl_codex_config_dir` and keep the pane pending/degraded.
- Child transcript already has complete lines at subscribe time -> backend returns them in `initialContent` and starts tailing from that offset; an incomplete final line must wait for completion before emit.
- Missing or ambiguous stop target -> frontend does nothing; it must not guess and close multiple child panes.
- `appendSubagentTranscript` receives an unknown key -> ignore it; multi-window broadcasts must not create stray transcript state.
- Appended transcript content exceeds the retention cap -> retain the latest tail, increment `truncatedBytes`, emit the existing OOM diagnostic, and increment `resetSeq` so view caches rebuild safely.

### 5. Good/Base/Bad Cases

- Good: Codex `SubagentStart` includes `transcript_path`; frontend subscribes directly to that path.
- Good: Codex `SubagentStart` only has the parent `transcriptPath`, then `SubagentStop` includes `agentTranscriptPath`; frontend upgrades the existing pane, appends subscribe `initialContent`, then marks it ended.
- Good: Claude `SubagentStart` misses an independent child path, then `SubagentStop` provides `agentTranscriptPath`; frontend upgrades the existing pane before finish instead of ending in degraded state.
- Good: Claude in WSL emits `ToolStop` with `agentId`, parent `transcriptPath`, UNC `cwd`, and no `wslDistroName`; frontend opens/updates a degraded child pane, derives the distro from `cwd`, and backend subscribes to the derived child path without rendering the parent transcript as child output.
- Good: Claude emits `SubagentStart` before `agent-<agentId>.jsonl` exists; frontend subscribes to the derived child path immediately and the backend begins emitting complete lines as soon as the file is created.
- Good: Codex emits `SubagentStart` before the matching rollout exists; bounded discovery retries find it during execution and start streaming before `SubagentStop`.
- Good: Codex runs in WSL with `cwd=/mnt/c/repo` and no custom `CODEX_HOME`; discovery prefers the parent rollout's sessions root, otherwise scans `$HOME/.codex/sessions` inside the reported distro and returns the matched rollout as WSL UNC for tailing.
- Base: Claude `SubagentStart` includes `agent_transcript_path`; frontend uses it unchanged.
- Good: `SubagentStop` includes `agent_id`; frontend marks the pane ended and closes it after the grace delay.
- Good: a hidden child transcript pane receives 1MB of JSONL append traffic; the store retains content, but the hidden view does not re-parse or re-render until it becomes visible.
- Good: a child transcript grows past the rendered row cap; the UI renders the newest rows plus an omitted-count marker instead of thousands of DOM nodes.
- Good: Claude hook stdin includes `effort.level = "high"`; the bridge emits `reasoningEffort: "high"` and the current terminal's stats card shows the effort even when the JSONL history usage lacks `reasoning_effort`.
- Bad: `SubagentStop` calls `finishSubagentTranscript` before awaiting the late child transcript subscription; the pane can close with empty output.
- Bad: A new hook event is installed but not added to the bridge whitelist; the hook silently posts but the bridge rejects it.
- Bad: `SubagentStop` has no `agent_id` while multiple child panes share one parent; frontend must not close all of them.
- Bad: deriving Claude effort from the model name or global settings when the current hook payload/env has no effort; concurrent sessions can use different `/effort` values.
- Bad: parsing the full retained transcript and re-rendering every Markdown message on every 250ms tail append; this blocks terminal typing and tab switching.

### 6. Tests Required

- Hook install/uninstall tests assert `SubagentStart`/`SubagentStop` and, for Claude, `PreToolUse`/`PostToolUse` Agent tool fallback commands are written and removed for the affected source.
- Rust unit test: `read_new_lines` returns only complete JSONL lines and the consumed offset used for subscribe `initialContent`.
- Rust unit test: explicit `/Users/...` transcript paths stay native without `wslDistroName`; explicit `/home/...` paths convert to WSL UNC only when a distro is provided.
- Rust unit test: WSL UNC `cwd` can provide a fallback distro for derived child transcript paths when `wslDistroName` is missing, and explicit `wslDistroName` still takes precedence.
- Rust unit test: WSL Codex roots normalize Linux absolute, `\\wsl.localhost`, `\\wsl$`, and Windows drive paths to the correct Linux config root; missing config prefers the parent rollout root and otherwise uses `<WSL $HOME>/.codex`.
- Rust unit test: non-Windows hook exe paths with spaces or single quotes are POSIX single-quote escaped.
- Rust compile check must pass after bridge payload or command signature changes.
- Rust unit test: `hook_client` extracts `reasoningEffort` from Claude `effort.level`.
- TypeScript type-check must pass after `CliHookPayload` field changes.
- Frontend regression test or manual profiling: while a child transcript is hidden and appends continue, React render count/CPU for `SubagentTranscriptView` should not grow with append frequency; when shown again, it catches up from retained content.

### 7. Wrong vs Correct

#### Wrong

```ts
// Falls back to the parent session transcript and can make multiple child panes
// render the same main conversation as if it were child output.
transcriptPath: payload.agentTranscriptPath ?? payload.transcriptPath ?? null

// Loses the WSL runtime boundary and repeatedly scans the Windows user's sessions.
invoke("codex_subagent_transcript_discover", { parentSessionId, agentId, codexConfigDir });
```

#### Correct

```ts
const source = resolveSubagentTranscriptSource(payload);
if (source.kind === "child-jsonl") {
  const { initialContent } = await subscribe(source.transcriptPath);
  append(initialContent);
} else {
  showDegradedSourceState(source.kind, source.reason);
}

invoke("codex_subagent_transcript_discover", {
  parentSessionId,
  agentId,
  codexConfigDir,
  wslDistroName,
  parentTranscriptPath,
});
```

#### Wrong

```tsx
// Every append reparses the whole retained JSONL and rerenders every Markdown row,
// including panes hidden by display:none.
const transcript = useTerminalStore((s) => s.subagentTranscripts[sessionId]);
const messages = useMemo(() => parseTranscript(transcript.content), [transcript.content]);
```

#### Correct

```tsx
// Hidden panes do not subscribe to high-frequency content. Visible panes parse
// only the appended suffix unless resetSeq changed.
const transcript = useTerminalStore((s) => (isVisible ? s.subagentTranscripts[sessionId] : undefined));
const messages = useIncrementalTranscriptCache(transcript?.content, transcript?.resetSeq);
```

## Scenario: System-Level Hook Notifications

### 1. Scope / Trigger

- Trigger: a `claude-hook-notification` payload should also surface as an OS-level notification while preserving the existing in-app toast and tab status behavior.
- Applies to: frontend hook event listener, persisted hook notification settings, Tauri notification permission, and WSL-to-Windows notification bridge commands.

### 2. Signatures

- Frontend event: `listen<CliHookPayload>("claude-hook-notification", handler)`.
- Frontend setting fields: `systemNotificationsEnabled: boolean`, `suppressSystemNotificationsWhenFocused: boolean`, and `systemNotificationEvents: Record<HookEventType, boolean>`.
- Hook event union for system notifications: `SessionStart | UserPromptSubmit | Notification | Stop | StopFailure | PermissionRequest`.
- Backend command: `is_wsl() -> bool`.
- Backend command: `send_notification_via_windows(title: String, body: String) -> Result<(), String>`.
- Backend command: `send_interactive_system_notification(title: String, body: String, tabId: String, actionLabel: String) -> Result<(), String>`.
- Backend-to-frontend activation event: `system-notification-action` with `{ tabId }`.
- Non-WSL frontend notifier: `send_interactive_system_notification({ title, body, tabId, actionLabel })`.

### 3. Contracts

- System notifications are **additive**: they must not replace app toast cards or tab status indicators.
- Default event settings: `Stop`, `StopFailure`, `PermissionRequest`, and `Notification` enabled; `SessionStart` and `UserPromptSubmit` disabled.
- `suppressSystemNotificationsWhenFocused` defaults to `true`: when the main Tauri window is focused/being used, frontend skips OS-level notifications while preserving in-app Hook toast and tab status updates.
- If `suppressSystemNotificationsWhenFocused` is `false`, focused-window state must not suppress OS-level notifications; existing global/per-event notification settings remain authoritative.
- Project name priority: `tabTitle` -> basename of `payload.cwd` -> `"未知项目"`.
- Title format: `CLI-Manager`; the OS notification should be attributed to the app rather than the CLI process.
- Body format: emoji + `Claude Code`/`Codex CLI` + project/event phrase, optionally appending `payload.message`.
- WSL fallback path: frontend first tries the interactive native notification command; only if that send path throws and `is_wsl` is true may it call `send_notification_via_windows`.
- Backend guard: `send_notification_via_windows` must reject non-WSL calls so Windows native app instances cannot accidentally show a `Windows PowerShell` source/icon.
- Non-WSL path: frontend checks/requests notification permission before `send_interactive_system_notification`; Windows native app instances must not route through PowerShell because that makes the toast appear as `Windows PowerShell`.
- Click behavior: native interactive notifications emit `system-notification-action`; the frontend shows/focuses the app and activates the owning terminal `tabId`. If the tab no longer exists, the app is focused and the user sees a target-closed toast.

### 4. Validation & Error Matrix

- `systemNotificationsEnabled === false` -> no system notification, no error.
- `suppressSystemNotificationsWhenFocused === true` and main window is focused -> no system notification, no error; app toast/tab status still update.
- Main-window focus detection fails -> continue notification flow and log warning; do not silently drop critical notifications.
- `systemNotificationEvents[payload.event] !== true` -> no system notification, no error.
- Event outside `HookEventType` (e.g. transcript-only hook events) -> no system notification, no error.
- Non-WSL notification permission denied -> no system notification; log warning only.
- `is_wsl` command failure or notification API failure -> catch and log warning; app toast/tab state must continue.
- WSL bridge title/body too long or containing NUL -> command returns `Err(String)`; frontend catches and logs warning.
- `powershell.exe` unavailable in WSL -> command returns `Err(String)`; frontend catches and logs warning.

### 5. Good/Base/Bad Cases

- Good: `Stop` for a tab titled `CLI-Manager` sends title `CLI-Manager` with body like `✅ Claude Code 在 CLI-Manager 的任务已完成` and still updates the tab status.
- Good: WSL fallback `PermissionRequest` sends through `send_notification_via_windows` without asking Tauri notification permission, and the Toast XML includes `来自 CLI-Manager` attribution.
- Good: native Windows/macOS/Linux `PermissionRequest` emits `system-notification-action` after notification click and activates the matching terminal tab.
- Base: `SessionStart` updates session binding but sends no system notification under default settings.
- Base: main window focused and foreground suppression enabled -> no OS notification, but the Hook toast still appears inside CLI-Manager.
- Base: main window focused and foreground suppression disabled -> OS notification is allowed if global and per-event settings allow it.
- Bad: system notification failure prevents `showClaudeHookToast` or `handleCliHookEvent` from running; notification errors must stay isolated.
- Bad: focused-window suppression is hard-coded without a persisted setting; users cannot opt back into OS notifications while using CLI-Manager.
- Bad: Windows native app instances route through PowerShell and show source `Windows PowerShell`; they must use the Tauri notification plugin path.
- Bad: notification click activation bypasses the shared frontend target activation helper and diverges from app toast behavior.

### 6. Tests Required

- TypeScript type-check must pass after changes to `HookEventType`, settings migration, or notification event filtering.
- TypeScript type-check must pass after adding or migrating Hook notification settings.
- Rust compile check must pass after changes to `is_wsl`, `send_notification_via_windows`, or interactive notification command signatures.
- Manual activation test point: clicking a native notification focuses the app and activates the matching tab; if the tab is closed, it focuses the app and shows the target-closed toast.
- Manual Windows/macOS/Linux smoke test: enabled event produces an OS notification with expected title/body.
- Manual WSL smoke test: enabled event produces a Windows Toast through `powershell.exe`.
- Settings UI test point: toggling one event preserves the other `systemNotificationEvents` values.
- Settings UI test point: toggling focused-window suppression changes only OS-level notification behavior, not app toast or tab status behavior.
- Regression test point: app toast and tab indicators still work when system notifications are disabled or fail.

### 7. Wrong vs Correct

#### Wrong

```ts
await sendSystemNotification(payload, tabTitle);
showClaudeHookToast(payload, tabId);
```

#### Correct

```ts
showClaudeHookToast(payload, tabId);
void sendSystemNotification(payload, tabTitle);
```

## Scenario: Third-party Hook Notifications

### 1. Scope / Trigger

- Trigger: the local bridge or daemon accepts a validated Claude/Codex Hook payload for `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `StopFailure`, or `PermissionRequest`.
- Applies to: `src-tauri/src/claude_hook.rs`, `src-tauri/src/daemon/server.rs`, `src-tauri/src/third_party_notification/*`, `thirdPartyHookTargets` in settings, and the Hook settings UI.

### 2. Contracts

- Dispatch ownership belongs to the process that actually receives the Hook HTTP request: app bridge in in-process mode, daemon hook sink in daemon mode.
- Frontend `listen("claude-hook-notification")` handlers must not send third-party notifications; daemon cache replay is for UI state only and must not cause a second remote send.
- Dispatch is best-effort and non-blocking: the sink may only try to enqueue into the bounded queue and must continue original emit/status/broadcast work even when the queue is full.
- `thirdPartyHookNotificationsEnabled === false` disables production fan-out while keeping saved targets untouched; manual test send remains available for validating a draft target.
- Remote message content is limited to a safe summary: CLI source, cwd basename project name, event label, 24-hour local time from the user's system timezone, generated notification UUID, and a short action summary derived only from the event enum. It must not include `payload.message`, Prompt, terminal output, absolute cwd, tab/session id, transcript paths/content, tool args, or environment variables.
- Default remote copy may include fixed event emoji derived from the event enum only.
- Supported providers: DingTalk, Feishu, WeCom, Bark, PushPlus, WxPusher, ServerChan, Telegram, ntfy, Gotify, and Custom HTTP.
- Built-in providers must parse provider business responses, not treat HTTP 2xx alone as success. Custom HTTP accepts any 2xx.
- Custom HTTP supports only GET/POST, fixed variable replacement, query, headers, JSON/form/text body, and no scripts/conditions/functions.
- Secrets remain in the existing settings store; UI masking is not encryption. Logs must not include full URL/query/header/body/token/secret/device key or raw remote response.

### 3. Tests Required

- Rust unit tests for message minimization, unsupported event filtering, Custom HTTP JSON leaf replacement, and controlled header rejection.
- Rust compile check must pass after bridge/daemon/command changes.
- TypeScript type-check must pass after settings migration or Hook settings UI changes.
- Regression: one Hook payload produces at most one third-party dispatch in app mode and one in daemon mode; frontend reconnect/cache replay produces zero additional remote dispatches.

## Scenario: CLI Hook Protection Through cc-switch Common Config

### 1. Scope / Trigger

- Trigger: Claude/Codex Hook install/status/uninstall must survive external cc-switch provider switches that rewrite CLI settings.
- Applies to: `src-tauri/src/commands/hook_settings.rs`, frontend Hook settings/status callers, persisted `ccSwitchDbPath`, and cc-switch SQLite `settings.common_config_claude` / `settings.common_config_codex`.
- This scenario is global/user-level only. Do not implement project-local `.claude/settings.local.json` or Claude managed settings from this path.

### 2. Signatures

```rust
pub async fn hook_settings_get_status(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
    auto_repair: Option<bool>,
) -> Result<HookSettingsStatus, String>

pub async fn hook_settings_install(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
) -> Result<HookSettingsStatus, String>

pub async fn hook_settings_uninstall(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
) -> Result<HookSettingsStatus, String>

pub async fn hook_settings_install_codex(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
) -> Result<HookSettingsStatus, String>

pub async fn hook_settings_uninstall_codex(
    app: AppHandle,
    selected_dir: Option<String>,
    codex_selected_dir: Option<String>,
    cc_switch_db_path: Option<String>,
) -> Result<HookSettingsStatus, String>
```

```ts
interface HookSettingsStatus {
  claude: ToolHookSettingsStatus;
  codex: ToolHookSettingsStatus;
  ccSwitch: {
    state: "notDetected" | "notSynced" | "synced" | "invalidDb" | "unavailable" | "syncFailed";
    dbPath: string | null;
    message: string | null;
    wslMismatch: boolean;
  };
  claudeAutoRepaired: boolean;
}
```

### 3. Contracts

- Frontend must pass `ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined`; `null`/missing means platform default `~/.cc-switch/cc-switch.db`.
- Backend must reuse the cc-switch DB resolver: explicit custom paths are validated and never silently replaced by defaults.
- Installing Claude Hook writes normal Claude `settings.json` hooks first, then best-effort merges the same CLI-Manager-owned hook commands into `settings.common_config_claude`.
- Installing Codex Hook writes normal Codex `hooks.json` commands and `config.toml` feature flags first, then best-effort merges the TOML `[features].hooks = true` flag plus any current CLI-Manager-owned Codex `[hooks.state.*]` trust blocks into `settings.common_config_codex`. Codex hook commands remain in `hooks.json`; `common_config_codex` is not JSON.
- Hook settings UI shows the cc-switch protection card once, above system notification settings. Do not duplicate it in both Claude and Codex sections.
- Claude common-config merge may remove/replace only CLI-Manager-owned hook commands (`__hook` marker or known legacy scripts); it must preserve non-hook fields and non-CLI-Manager hook entries. Codex common-config merge may only add or replace the TOML `features.hooks` flag and marker-owned `[hooks.state.*]` trust blocks for the current user-level Codex `hooks.json`; it must preserve other TOML fields and unrelated hook state.
- `settings.value` is nullable in cc-switch DBs. A `NULL` value for `common_config_<tool>` is treated as missing config, not as `db_query_failed`.
- When `common_config_codex` has no `[features]` table, insert the `[features]` block before the first existing TOML table header; append only when the snippet has top-level keys and no tables. This avoids leaking later text-concatenated provider keys into `[features]` while preserving tables such as `[projects.'\\?\F:\...']`, `[windows]`, and `[tui]`.
- Common-config writes use `sqlx` and an explicit transaction. Do not add `rusqlite`.
- If cc-switch is missing or common-config sync fails, Hook installation still succeeds and the returned `ccSwitch.state` explains the protection status.
- Hook config paths and the cc-switch DB runtime are independent. A WSL Claude/Codex config
  may use a host Windows DB, and a Windows or WSL config may use a DB inside WSL.
- Hook commands still follow the target config runtime (`/mnt/<drive>/...` for WSL targets,
  native paths otherwise). Database access follows only the DB path: native DBs use sqlx;
  WSL DB reads/writes are routed through the named distro and must never use UNC direct writes.
- `autoRepair: true` means "the user previously installed Claude Hook"; if CLI-Manager-owned hooks are missing or partial, backend may reinstall them and return `claudeAutoRepaired: true`.

### 4. Validation & Error Matrix

| Condition | `ccSwitch.state` / behavior |
|-----------|-----------------------------|
| Default DB path missing | `notDetected`; Hook install/status succeeds |
| Explicit DB path missing or not `.db` | `invalidDb`; do not fallback to default |
| WSL CLI config dir + host DB path | sync normally; Hook command uses WSL path |
| Windows/WSL CLI config dir + WSL DB path | sync in the DB's WSL distro |
| WSL runtime unavailable | `syncFailed` with stable `wsl_sqlite_*` message; never UNC-write |
| Missing `settings` table | `unavailable`; Hook install succeeds |
| Invalid `common_config_claude` JSON | `syncFailed`, message `common_config_parse_failed`; do not overwrite |
| Existing `common_config_codex` TOML | preserve existing TOML fields and set `[features].hooks = true`; do not parse as JSON |
| Existing `common_config_codex` row with `NULL` value | treat as missing config; write minimal `[features]\nhooks = true` TOML |
| Current Codex `config.toml` has trusted CLI-Manager `hooks.state` entries | copy those state blocks into `common_config_codex` with CLI-Manager marker comments |
| Current Codex `config.toml` has unrelated or project-local `.codex/hooks.json` state | do not copy into `common_config_codex` |
| SQLite open/query/write failure | `syncFailed` with stable `db_*`/`db_write_failed` message |
| Existing non-CLI-Manager hooks | preserved on install, reinstall, and uninstall |

### 5. Good/Base/Bad Cases

- Good: User selected a moved cc-switch DB in Settings -> Provider; Hook install syncs the relevant `common_config_<tool>` key at that exact path and returns `synced`.
- Good: `common_config_codex` contains top-level Codex keys plus `[projects.'\\?\F:\idea-work\business-center']`, `[windows]`, and `[tui]`; Hook install preserves all existing lines and inserts `[features].hooks = true` before the first table.
- Good: Codex has already trusted CLI-Manager entries in user-level `~/.codex/config.toml`; Hook install copies only those current `~/.codex/hooks.json:<event>:<entry>:<hook>` state blocks into `common_config_codex`.
- Base: cc-switch is not installed; Hook install still writes normal CLI settings and returns `notDetected`.
- Base: Codex hooks are installed but no trust hash exists yet; common-config sync still writes `[features].hooks = true` and does not fabricate `trusted_hash` values.
- Base: user previously installed Hook, cc-switch rewrites `settings.json`, and startup calls status with `autoRepair: true`; backend restores missing hooks and frontend shows one lightweight notice.
- Bad: invalid explicit DB path falls back to `%USERPROFILE%/.cc-switch/cc-switch.db`; this can write the wrong database and is forbidden.
- Bad: merging common config replaces provider env, MCP, permissions, or third-party hooks; only CLI-Manager hook entries are owned here.
- Bad: appending a new `[features]` table after the last existing TOML table in a common-config snippet; downstream text concatenation can put provider keys in the wrong TOML table scope.
- Bad: copying every `[hooks.state.*]` entry from Codex config; this can leak project-local or user-owned hook trust into cc-switch global common config.

### 6. Tests Required

- Rust unit tests for Claude common-config merge preserving existing fields and non-CLI-Manager hooks, and Codex TOML common-config preserving existing fields while enabling `[features].hooks`.
- Rust regression tests for Codex common-config with the real cc-switch `settings(key TEXT PRIMARY KEY, value TEXT)` shape, including nullable `value` and Windows project table keys.
- Rust regression tests for copying only current user-level CLI-Manager Codex `hooks.state` blocks into `common_config_codex`, replacing stale marker-owned hashes, and excluding project-local `.codex/hooks.json` state.
- Rust unit tests for strip/uninstall preserving non-CLI-Manager hooks.
- Rust regression test that Claude common-config status requires every installed event, including Claude `Notification`; Codex common-config status requires `[features].hooks = true`.
- Rust unit test that invalid Claude common-config JSON returns `common_config_parse_failed`.
- TypeScript type-check after adding payload fields or new frontend status states.
- Manual smoke points: no cc-switch DB, default DB present, custom selected DB, invalid selected DB,
  WSL CLI config + Windows DB, and Windows/WSL CLI config + WSL DB.

### 7. Wrong vs Correct

#### Wrong

```rust
// Do not hard-code a local Windows user path or silently fallback from an invalid explicit DB.
let db = PathBuf::from(r"C:\Users\Admini\.cc-switch\cc-switch.db");
```

#### Correct

```rust
let path = resolve_ccswitch_db_path_for_hook(&app, cc_switch_db_path, &claude_dir)?;
```

## Scenario: SSH Agent Hook Lifecycle And Delivery

### 1. Scope / Trigger

- Trigger: an SSH Host explicitly installs Claude/Codex Hook entries through `cli-manager-ssh-agent`, or a bound remote CLI emits one of those events.
- Applies to: `hook-schema`, Agent `hook_config`/`hook_runtime`/bridge protocol, SSH launch binding, daemon event validation, `ClaudeHookPayload`, and SSH CLI Integration UI/storage.

### 2. Signatures

```text
ssh_agent_hook_inspect(configuredConfigRoot, source, Agent identity) -> HookConfigReport
ssh_agent_hook_preview(..., action=install|uninstall, expectedCanonicalRoot?) -> HookConfigReport
ssh_agent_hook_apply(..., expectedCanonicalRoot?, expectedFiles[]) -> HookConfigReport

cli-manager-ssh-agent hook --source <source> --event <event>
  --managed-by cli-manager-ssh-agent --installation-id <uuid>
```

Reserved launch environment: `CLI_MANAGER_SSH_HOST_ID`, `CLI_MANAGER_SSH_CLIENT_INSTANCE_ID`, `CLI_MANAGER_PROJECT_ID`, `CLI_MANAGER_TAB_ID`, and `CLI_MANAGER_BRIDGE_EPOCH`.

### 3. Contracts

- Remote Hook installation is explicit per Host/tool/config root. Page open, Host save, Agent probe, Agent install, and config-root browsing do not write Hook configuration.
- Agent reports and desktop persistence use the canonical config root plus actual config file paths/fingerprints. Agent binary/install paths are never treated as Hook or history roots.
- Re-inspection preserves the prior validated installation record for the same canonical root, while explicit uninstall clears it. Multiple Host/project references to one canonical root mirror one physical Hook status.
- Ownership requires the exact stable Agent command, source/event, `--managed-by cli-manager-ssh-agent`, and current installation UUID. Substring matching is forbidden.
- Missing standard defaults may be created only by confirmed Hook install. Missing custom roots are rejected. Root or config-file symlinks remain links; a target change after preview aborts the transaction.
- A custom root deleted after installation remains missing for install/inspect. Uninstall alone may recover one exact Agent-owned canonical record to clear stale ownership without recreating the directory. Any UI uninstall based on a stored Hook report supplies the prior canonical identity, so a configured-root symlink retargeted from A to B can clean only A through an exact unique Agent record; a direct request without an expected identity follows B. Missing, ambiguous, or invalid records fail closed.
- Config merging preserves unrelated entries and unknown events. Duplicate exact entries are normalized in place. User-owned Codex `features.hooks = true` remains enabled after uninstall.
- Remote runtime requires all reserved binding variables. Ordinary SSH/IDE/tmux launches and other desktop clients are no-op and produce no spool record.
- A remote SSH PTY receives the Agent bridge identity only when its effective Host/source/configured root is recorded as `installed` and still matches the current Agent installation/machine identity. Installing Agent without Hook does not add a background SSH connection.
- Hook stdin is bounded; shared normalization feeds local and remote paths. Remote spool removes prompt/message before persistence.
- Daemon validates Host/client/project/Tab/epoch/installation/source against a live PTY before routing. Remote transcript refs stay in `remoteTranscriptRef` fields and never enter local transcript/file commands.
- Delivery is at least once from Agent to daemon, then deduplicated by event id. Spool uses monotonic sequence, ACK deletion, TTL/count/byte limits, and sequenced gap warnings.
- `ClaudeHookPayload::to_notification_job` must clear SSH cwd. Third-party notifications never receive remote cwd, transcript refs, Host/project/session/Tab identity, or prompt text.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing/invalid reserved binding | successful Hook no-op |
| Source/event/installation/owner invalid | Hook runtime error is swallowed by CLI; no spool write |
| Config changed after preview | `hook_config_changed` |
| Root/config symlink target changed | `hook_config_root_changed` |
| Foreign CLI-Manager marker/placement | `hook_config_owner_conflict` |
| Stale spool lock | remove only after dead PID/age check and retry |
| Spool limit/TTL removes events | insert `gap` with dropped count and sequence |
| Event does not match a live daemon binding | reject without frontend/third-party delivery |

### 5. Good/Base/Bad Cases

- Good: one Host has Claude default root and a Codex project override; both Hooks install independently and share the Host bridge without cross-routing events.
- Base: Agent is installed but Hook is not; remote terminal behavior is unchanged and live Hook status is unavailable.
- Base: bridge is offline; Hook appends to its Host/client/installation spool and exits promptly, then reconnect replays and ACKs it.
- Bad: rewrite all `hooks` arrays, infer ownership from an Agent-name substring, broadcast to every client, interpret a remote transcript ref as a local path, or include remote cwd in third-party notification data.

### 6. Tests Required

- Agent tests: exact merge/uninstall, duplicates, unknown events, malformed JSON/TOML, Codex feature/comment ownership, default/custom roots, symlink target changes, fingerprints, journal rollback, binding no-op, stdin bound, message redaction, stale lock, meta rebuild, spool limits/gap, and ACK.
- Desktop Rust tests: strict report validation, reserved env overwrite, session binding rejection, bridge full-spool dedup including gap replay, remote payload validation, and third-party cwd redaction.
- Frontend/type tests: per-tool Host roots, grouped project overrides, retained-root cleanup, preview confirmation, canonical paths, bilingual states, and remote transcript local-API refusal.
- Run Agent host tests, Linux x64/arm64 all-target checks, desktop Rust tests, TypeScript, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```rust
if command.contains("cli-manager-ssh-agent") {
    remove_hook(command);
}
```

#### Correct

```rust
if command == expected_command(source, event, installation_id) && matcher == expected_matcher {
    remove_hook(command);
}
```

Exact ownership prevents upgrades or uninstalls from deleting third-party and other-installation entries.
