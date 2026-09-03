# Hook 系统通知支持自定义通知声音

## Goal

实现 GitHub issue #239：Hook 发送系统通知时允许用户选择自定义通知声音，帮助用户在离开电脑时更容易注意到 Claude/Codex 等 CLI 的完成、失败或待处理提醒。

## Current Behavior

- `src/App.tsx` 根据系统通知总开关、事件筛选和窗口聚焦状态发送 OS 通知。
- 原生交互通知通过 `send_interactive_system_notification` 发送，并保留点击通知后定位终端 Tab 的能力。
- WSL 使用 `send_notification_via_windows` 作为 Windows Toast fallback。
- Hook 设置页已经有系统通知、事件筛选、任务栏提醒和第三方通知设置；设置通过 `tauri-plugin-store` 持久化。
- 当前没有自定义声音设置，系统通知沿用操作系统/通知后端默认声音。

## Requirements

- R1：在 Hook 设置的系统通知区域提供自定义通知声音配置；新增文案必须同时支持 `zh-CN` 和 `en-US`。
- R2：V1 默认采用一个全局自定义声音，应用于所有已启用的 Hook 系统通知事件，不拆分到每个事件。
- R3：V1 仅支持 Windows 本地桌面通知的 `.wav` 文件；不改变应用内 Hook toast、任务栏提醒和第三方通知的行为。
- R4：用户未选择自定义声音时，保持现有系统默认声音行为；选择后替换默认声音，不重复播放两种声音。
- R5：自定义声音设置持久化为用户选择的本地路径；路径是机器相关配置，不进入 WebDAV/本地快照同步，避免在其他设备上复用失效绝对路径。
- R6：文件选择和通知发送两端都将路径视为不可信输入。后端验证扩展名、文件存在性和可读性，不能通过 shell 拼接执行用户路径；声音播放失败不得阻塞通知、Hook toast、Tab 状态或点击跳转。
- R7：文件被移动、删除、格式不支持或播放失败时，系统通知仍按现有流程发送并记录诊断；设置界面给出可理解的失效状态，用户可重新选择或清除。
- R8：保持系统通知的点击交互和现有 WSL fallback 合约；不把 Windows 原生桌面通知错误地改成 PowerShell 来源。

## Acceptance Criteria

- [ ] Hook 设置页可选择 `.wav` 文件、显示当前文件名/失效状态，并可清除自定义声音。
- [ ] 自定义声音路径在应用重启后仍保留；清除后恢复默认系统通知声音。
- [ ] Windows 本地 Hook 系统通知播放自定义声音，同时仍可点击通知定位对应终端 Tab。
- [ ] 系统通知总开关、事件筛选、聚焦抑制、后台任务模式、应用内 toast、任务栏提醒和第三方通知行为保持现有语义。
- [ ] WSL/非 Windows 路径不引入崩溃、shell 注入或通知流程阻塞；不支持的声音输入安全降级。
- [ ] 设置加载迁移、同步排除策略、Tauri 命令输入校验、前后端类型和两种语言文案均有验证。
- [ ] `npx tsc --noEmit`、`cd src-tauri && cargo check`、`cd src-tauri && cargo test`、`git diff --check` 通过。

## Scenario Matrix

| Dimension | Cases to cover | V1 decision |
|---|---|---|
| Window state | focused / another app / minimized / tray | follow existing notification gating; custom sound only affects an actually sent OS notification |
| Session topology | one session / multiple sessions / split pane / Workspan switch | sound is global; notification action keeps existing `tabId` routing |
| Notification controls | global on/off / event enabled-disabled / focus suppression on-off / background task mode | preserve current switches and bypass semantics |
| Runtime | local PowerShell/CMD/Pwsh / WSL / Bash | custom playback is Windows-local V1; WSL fallback remains safe and does not assume a Linux path is a Windows path |
| Hook coverage | Claude/Codex/Kimi/Pi/Grok installed / partial / not installed | no installer contract changes; only received system notifications are affected |
| File state | no selection / valid `.wav` / uppercase extension / missing / unreadable / non-WAV / path with quotes or Unicode | allowlist and backend validation; no shell execution of the path |
| Lifecycle | app restart / settings migration / another device sync | restore local path; stale path degrades to default and remains excluded from sync |
| Delivery | one event / concurrent events / OS muted or volume low | best effort playback; notification delivery and app state remain authoritative |

## Confirmed Scope

用户已确认按以下范围实现：Windows 本地、全局单个 `.wav`、替换默认通知声、保存本机路径、提供选择/清除；不做逐事件声音、MP3 等格式和声音编辑。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
