# Hook 系统通知自定义声音设计

## Approved Scope

- 仅 Windows 本地桌面系统通知支持自定义声音。
- 全局只配置一个声音文件，应用于所有已通过现有总开关、事件筛选、聚焦抑制和后台任务规则的系统通知。
- 仅允许 `.wav`，选择后替换通知默认声音；未配置时保持现有通知行为。
- 设置保存本机绝对路径，不复制文件，不纳入 WebDAV/本地快照同步。
- 提供选择、清除和试听；不改变应用内 Hook toast、任务栏提醒、第三方通知、WSL fallback 和通知点击跳转。

## Boundary Diagnosis

当前声音行为的真正入口是 `src-tauri/src/commands/system_notification.rs` 中的交互式系统通知命令，而不是 Hook UI：`src/App.tsx` 负责通知准入和 IPC，Rust 命令负责保留通知 action 并显示 OS Toast。仅在设置页保存路径无法产生声音，直接把本地路径传给现有 `notify-rust` 的 Windows sound-name API 也不可靠，因为该 API 使用预定义 Windows 声音事件，不接受任意 WAV 路径。

因此路径在前端选择后跨 IPC 传入 Rust，由 Rust 在文件使用边界重新校验并调用 Windows `PlaySoundW` 异步播放；交互 Toast 在配置有效时显式静音，以保证不会同时播放默认声和自定义声。通知 action 仍由原有 `notify-rust` handle 等待并发出 `system-notification-action`。

## Data Flow

```text
Hook payload
  -> App.tsx existing event/filter/focus/background gates
  -> settingsStore.systemNotificationSoundPath
  -> send_interactive_system_notification IPC
      -> Rust validate/canonicalize WAV path
      -> Windows PlaySoundW(SND_FILENAME | SND_ASYNC | SND_NODEFAULT)
         -> success: notify-rust interactive Toast with silent audio
         -> failure: notify-rust interactive Toast with existing default audio
      -> existing system-notification-action event

Hook Settings UI
  -> tauri-plugin-dialog open({ filters: [wav] })
  -> validate_system_notification_sound(path)
  -> settingsStore.update("systemNotificationSoundPath", path)
  -> tauri-plugin-store persistence
```

The WSL path remains unchanged: it does not receive or play the Windows-local custom path. Non-Windows builds ignore the optional sound path in the existing command and keep their current notification behavior.

## Persisted Contract

Add the nullable field:

```ts
systemNotificationSoundPath: string | null // default null
```

Migration rules:

- Missing, null, empty, or non-string values become `null`.
- A stale path is retained so the UI can show it as unavailable and let the user reselect or clear it; load migration does not perform I/O.
- `SETTING_BACKUP_POLICY.systemNotificationSoundPath` is `excluded`. Absolute local paths are machine-specific and must not overwrite another device's path during sync/import.
- Existing `systemNotificationEvents` and all notification switches retain their current values and semantics.

## IPC Contract

Keep existing command names and behavior, adding one optional field to the interactive command:

```text
send_interactive_system_notification(
  title: String,
  body: String,
  tabId: String,
  actionLabel: String,
  customSoundPath: Option<String>,
) -> Result<(), String>
```

Add two Windows-local helper commands for settings UI:

```text
validate_system_notification_sound(path: String) -> Result<(), String>
play_system_notification_sound(path: String) -> Result<(), String>
```

Stable validation errors:

- `notification_sound_path_empty`
- `notification_sound_path_contains_nul`
- `notification_sound_path_too_long`
- `notification_sound_format_unsupported`
- `notification_sound_unavailable`
- `notification_sound_not_file`
- `notification_sound_too_large`
- `notification_sound_invalid_wave`
- `notification_sound_play_failed`
- `notification_sound_windows_only`

The notification-send command treats a configured but stale/invalid custom path as a best-effort option: it logs a warning, keeps the current default Toast audio behavior, and still sends the interactive notification. The explicit validate/preview commands return the stable error for UI feedback.

## Rust Implementation

### Path validation

Create a pure-ish helper that accepts the path string and returns a canonical `PathBuf`:

1. Reject NUL and overlong input before I/O.
2. Require a non-empty extension equal to `wav` case-insensitively (allowlist).
3. Canonicalize the selected path before using it, then require regular-file metadata.
4. Enforce a bounded file size suitable for notification audio (20 MiB).
5. Read the RIFF/WAVE header before preview/playback; reject malformed files with a stable error.

The path is never interpolated into PowerShell, XML, a shell command, or a URL. Canonicalization handles stale path normalization; no broad WebView fs/asset scope is added because the frontend never reads the sound file directly.

### Playback and duplicate-sound prevention

- Add the existing `windows-sys` dependency feature `Win32_Media_Audio`; do not add a new audio crate.
- Convert the canonical path with `encode_wide()` and call `PlaySoundW` with `SND_FILENAME | SND_ASYNC | SND_NODEFAULT`.
- Use a private invalid `notify-rust` sound-name sentinel only when a custom path has passed validation. The current Windows backend maps an unrecognized sound name to an explicit silent Toast audio element; this preserves the existing action-capable notification while the separate WinMM call plays the user WAV.
- `SND_ASYNC` keeps the Tauri command and Hook path non-blocking. Playback is queued before the Toast is shown so a PlaySoundW failure can keep the existing default Toast audio; the error is warning-only and does not block notification delivery.
- A later notification may replace an earlier custom sound according to Windows `PlaySoundW` behavior; notification delivery and action routing remain independent.

## Frontend Implementation

- Add a Windows-only custom sound card inside the existing Hook system notification section.
- Use `@tauri-apps/plugin-dialog` with a localized dialog title and a `.wav` extension filter.
- Validate before persisting; show localized success/failure feedback. Display only the selected file name in the compact UI, with the full path available through a localized accessible label/title if needed.
- On a persisted path, call `validate_system_notification_sound` when the section mounts/path changes. Keep the path on disk when stale and render an unavailable state instead of silently clearing it.
- Add a localized “试听” action calling `play_system_notification_sound`; add “清除” to restore default sound. Disable preview when there is no valid selected path.
- `src/App.tsx` passes the stored path to the interactive command. It does not alter event gates, permission flow, WSL fallback, or action handling.
- All new labels, descriptions, status text, aria labels, and toast messages are added to both translation maps in `src/lib/i18n.ts`.

## Test Strategy

### Rust

- Pure validation tests for missing path, empty/NUL/overlong path, `.wav` allowlist including uppercase extension, non-WAV, missing path, directory, oversized file, malformed header, and valid RIFF/WAVE file.
- Test the Windows playback flag composition/helper without invoking real audio in unit tests.
- Ensure the interactive command's optional path remains harmless on non-Windows compilation; existing title/body/tab/action validation stays intact.

### Frontend/static

- TypeScript verifies the new settings key is included in `Settings`, migration, sync policy, and all `update` calls.
- Manual Windows checks cover selection, restart persistence, preview, clear/default, missing-file state, custom playback, no duplicate default sound, notification click activation, focus suppression, background mode, minimized/tray state, multiple tabs, and concurrent events.
- Confirm WSL fallback, non-Windows behavior, taskbar, in-app toast, and third-party notifications are unchanged.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| `Settings` has a large fan-out (`CRITICAL` GitNexus impact) | Add one nullable field, preserve defaults and selectors, use a dedicated migration, classify it as sync-excluded. |
| Stale or malicious path reaches the backend | Validate at Rust boundary, canonicalize, allowlist `.wav`, check regular file/header/size, and use direct Win32 API rather than a shell. |
| Custom and default sounds both play | Suppress the action-capable Toast audio only after the custom path validates; otherwise retain existing behavior. |
| Playback failure hides the notification | Show Toast first and treat PlaySound failure as diagnostic-only. |
| WSL path has different filesystem semantics | Do not pass this Windows-local setting into the WSL PowerShell fallback. |

## Documentation Changes

- Extend the system-level Hook notification section in `.trellis/spec/backend/cli-hook-contracts.md` with the setting and optional IPC field.
- Add a `V1.3.9` entry to `CHANGELOG.md`.
- Add the capability to the existing `Hook 通知` section of `docs/功能清单.md`.
