# 管理员身份打开终端设置

## Goal

在“设置-终端设置”中增加“以管理员身份打开终端”开关，让用户可以控制外部终端启动时是否请求 Windows 管理员权限。

## What I already know

* 用户要求：在“设置-终端设置”中增加“以管理员身份打开终端”功能，并增加开关。
* 现有终端设置页是 `src/components/settings/pages/ThemeSettingsPage.tsx`，其中“终端行为”已有字体大小、字体族、默认 Shell、外部 PowerShell 开关。
* 现有设置 Store 是 `src/stores/settingsStore.ts`，持久化到 `settings.json`，已有 `useExternalTerminal`。
* 现有外部终端桥接是 `src/lib/externalTerminal.ts` 调用 Tauri command `open_windows_terminal`。
* Rust 命令 `src-tauri/src/commands/shell.rs::open_windows_terminal` 当前直接 `Command::new(wt).args(args).spawn()`。
* 内嵌终端由 PTY 创建，管理员权限提升通常不能只提升单个子进程而不提升宿主应用；更合理的 MVP 是作用于外部 Windows Terminal。

## Assumptions (temporary)

* “以管理员身份打开终端”默认仅对外部 Windows Terminal 生效。
* 若“外部 PowerShell/外部终端”关闭，该开关可显示但注明仅外部终端生效，或禁用。
* Windows 提权需要 UAC，可能通过 PowerShell `Start-Process wt -Verb RunAs` 或 Windows API 实现；需实现时再做最小可行方案。

## Open Questions

* 该管理员开关是否只作用于外部 Windows Terminal？

## Requirements (evolving)

* 在“设置-终端设置”的“终端行为”区域增加“以管理员身份打开终端”开关。
* 开关状态持久化。
* 打开外部终端时根据开关决定是否请求管理员权限。
* 默认关闭，避免意外 UAC 弹窗。

## Acceptance Criteria (evolving)

* [ ] 设置页出现“以管理员身份打开终端”开关。
* [ ] 开关默认关闭，重启应用后保持用户设置。
* [ ] 开关开启且使用外部终端时，打开终端会触发管理员权限请求。
* [ ] 开关关闭时，外部终端启动行为与当前一致。
* [ ] 若平台或环境不支持提权，给出清晰错误提示。

## Definition of Done (team quality bar)

* Typecheck passes: `npx tsc --noEmit`.
* Rust check passes: `cd src-tauri && cargo check`.
* UI verified manually in dev app if implementation happens.

## Out of Scope (explicit)

* 不提升整个 CLI-Manager 应用自身权限。
* 不尝试让已运行的内嵌 PTY 会话原地提权。
* 不新增第三方依赖，除非后续确认 Windows API 方案必须。

## Technical Notes

* Likely frontend files: `src/stores/settingsStore.ts`, `src/components/settings/pages/ThemeSettingsPage.tsx`, `src/lib/externalTerminal.ts`.
* Likely backend file: `src-tauri/src/commands/shell.rs`.
* Existing `ExternalTab` may need增加 `run_as_admin` or command-level boolean.
