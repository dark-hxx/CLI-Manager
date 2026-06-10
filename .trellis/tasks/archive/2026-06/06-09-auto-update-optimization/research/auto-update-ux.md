# Summary

- 桌面更新 UX 常见分层：自动检查、后台下载后提示安装、完全静默更新、强制更新。差异主要在“是否打断用户”和“是否把安装/重启交给用户确认”。
- 对 CLI-Manager 这类承载长时间终端会话的应用，危险点不是“检查”或“下载”，而是“安装触发退出/重启”。Tauri updater 文档也明确：Windows 执行 install step 时应用会自动退出。
- MVP 应选择低打扰路径：启动后延迟自动检查；发现更新后在应用内展示；用户确认后下载；下载完成后再次确认安装/重启。失败时保留 GitHub Release 兜底入口。
- 参考依据：Tauri v2 Updater（`check`、`download_and_install`、`relaunch/restart`）、Electron 更新教程（后台下载完成后弹窗让用户重启）、Sparkle（周期性后台检查、跳过版本/关键更新）、MSIX App Installer UpdateSettings（启动/后台检查、提示/静默、阻止启动的强制更新）。

# Patterns

| 模式 | 典型行为 | 优点 | 风险 / 代价 | 适用性 |
|---|---|---|---|---|
| Auto-check only | 启动或定时检查，发现后提示用户去下载页。当前 CLI-Manager 基本属于此类：`src/App.tsx` 启动后延迟检查，toast 打开 GitHub Release；`src/stores/updateStore.ts` 请求 GitHub Releases latest API。 | 最安全、实现少、不会破坏正在运行的会话。 | 需要用户手动下载/安装；更新转化率低；失败恢复依赖浏览器和用户理解。 | 适合早期版本或 updater 基础设施未就绪时。 |
| Background download + prompt install | 自动检查并下载；下载完成后提示“现在重启安装 / 稍后”。Electron 的 `update-electron-app` 文档描述了这种默认体验。 | 用户少操作；下载耗时不阻塞最终决策；安装前仍有确认点。 | 后台下载会占网络；下载失败/版本过期要处理；提示过频会烦。 | 适合多数生产桌面应用，但安装/重启必须尊重活跃工作。 |
| Fully silent updates | 检查、下载、安装尽量无 UI，可能在后台或退出时完成。 | 用户负担最低；安全补丁覆盖快。 | 对有状态工作极危险：可能中断终端、SSH、构建、AI CLI 任务；失败时用户难定位。 | 不适合 CLI-Manager MVP。只适合无长任务、可无损重启的小工具。 |
| Forced updates | 发现更新后阻止继续使用或阻止启动，要求先更新。MSIX App Installer 支持 prompt/silent 以及 block activation 类配置。Sparkle 也有 critical update 概念。 | 可保证关键安全/协议兼容版本快速落地。 | 最大打扰；离线或下载失败会阻断工作；容易让用户失去控制感。 | 不适合 MVP；仅限严重安全漏洞或服务端协议强制兼容。 |

# Trade-offs for CLI-Manager

- 活跃终端是核心约束：CLI-Manager 管理 PowerShell/CMD/PWsh/WSL/Bash 等 PTY 会话。安装触发退出会直接中断正在跑的构建、部署、SSH、AI CLI 或长命令。
- “检查更新”可以静默；“下载更新”通常可后台或用户确认；“安装/重启”必须显式确认。尤其 Windows Tauri updater 安装阶段会退出应用，不能藏在 toast 后面自动执行。
- 当前实现已有低风险基础：启动后 deferred check 不阻塞首屏；设置页有手动检查入口；错误可在设置页展示。缺口是下载/安装仍跳 GitHub Release，没有应用内状态机。
- 对长期打开的桌面应用，提示策略要节制：同一版本不要每次启动都弹；需要 snooze/skip，否则更新提示会变成噪音。
- 失败恢复必须清楚：离线、GitHub API 限流、manifest 不可用、签名校验失败、下载中断，都不应影响当前版本继续使用。
- 发布基础设施会影响 UX：当前 PRD 已记录尚未配置 `tauri-plugin-updater`、updater endpoints/pubkey、release manifest/signature。MVP UI 需要保留“查看 Release 页面”作为兜底。

# Recommended MVP

1. 保留启动后延迟自动检查，并保留设置页“检查更新”。启动静默检查失败不弹错误；手动检查失败才展示错误和重试。
2. 发现新版本后展示应用内更新入口：版本号、发布日期、简短 Release Notes、主要按钮“下载更新”、次要按钮“稍后提醒”、兜底“查看 Release”。
3. 用户点击后才开始下载，显示进度和可理解状态。下载失败时允许重试，并保留 GitHub Release 链接；不得影响当前应用使用。
4. 下载完成后不要自动安装。展示明确确认：“立即安装并重启”与“稍后”。如果存在活跃终端/会话，文案必须提示“安装会关闭当前终端任务”。
5. 安装/重启只在用户确认后执行；不做完全静默安装；不做强制更新；不在 MVP 中阻止启动。
6. 处理边界：
   - Offline：启动检查静默跳过；手动检查显示网络不可用/稍后重试。
   - Download failure：保留旧版本；显示失败原因、重试、Release 兜底。
   - Repeated prompts：按版本记录提示时间；“稍后提醒”至少当天不再提醒；“跳过此版本”直到出现更高版本或用户手动检查。
   - Update during active work：只允许下载；安装必须二次确认，最好在终端全部关闭或用户明确接受中断时执行。
   - Stale download：安装前重新确认目标版本仍是当前最新可用版本，避免装过期包。
