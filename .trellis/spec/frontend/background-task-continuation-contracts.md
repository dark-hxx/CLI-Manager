# Background Task Continuation Contracts (Phase 1: 托盘常驻)

> Issue #123 增强：退出时若有任务运行中，允许"转入后台继续执行"（托盘常驻，PTY 不销毁），任务完成后系统通知，重开窗口即 reattach。与 `workspace-session-restore-contracts.md`（关闭后 resume 恢复）互补：**托盘常驻 = 进程存活、任务真续跑；快照恢复 = 进程已死后的兜底**。两者叠加后由本契约定义边界。
>
> Phase 2（独立 daemon 进程，orca 式 PTY 宿主外置）不在本契约范围，另立契约后再实施。

## Scenario: Continue Running Tasks in Tray After Window Close

### 1. Scope / Trigger

- Trigger: 改动 `App.tsx` 退出/关闭拦截（`onCloseRequested`、`runExitCleanup`、close dialog）、托盘菜单、任务运行判定、后台任务完成通知时。
- 跨层：`terminalStore.tabStatuses`(hook+shell 双源) → `App.tsx` 关闭拦截 → 窗口 hide（托盘常驻）→ hook 事件 `Stop/StopFailure` → 系统通知 → 托盘/通知点击 show window。

### 2. Signatures

- 运行任务判定：`terminalStore` 新增 selector `getRunningTaskSessionIds(): string[]` — 返回合并后 TabNotificationState 为 `running` 的**真实 PTY** 会话 id（伪会话 kind 排除）。
- 设置项：`settingsStore.exitWithRunningTasksBehavior: "ask" | "background" | "exit"`，默认 `"ask"`。
- 退出确认弹窗：复用现有 CloseDialog 模式新增 `RunningTasksExitDialog`（选项：转入后台 / 仍然退出 / 取消；含"记住选择"）。
- 转入后台入口：`enterBackgroundMode(): Promise<void>` — `appWindow.hide()` + 标记 `isInBackgroundMode`（内存态，不落盘）。
- 后台完成通知：复用 `claude-hook-notification` 监听链路；后台模式下 `Stop`/`StopFailure`/`Notification(attention)` 事件必须走系统通知（`send_notification_via_windows` 已有命令），点击/托盘左键 → show + focus。

### 3. Contracts

- **★核心：转入后台 ≠ 退出。** 走 `appWindow.hide()`，**禁止**调用 `runExitCleanup`/`pty_close_all`/`flushTerminalSnapshotsNow` 的退出链路——PTY、hook TCP server、快照节流定时器全部保持运行。快照 10s 节流在后台继续落盘（进程被强杀时仍有兜底）。
- 拦截时机：`onCloseRequested` 中 `behavior === "exit"` 或弹窗选"退出"时，**先**调 `getRunningTaskSessionIds()`：
  - 为空 → 按原逻辑直接 `runExitCleanup`，行为与现状完全一致（回归红线）。
  - 非空 → 按 `exitWithRunningTasksBehavior` 分流：`ask` 弹 `RunningTasksExitDialog`；`background` 直接 `enterBackgroundMode()`；`exit` 直接退出链路。
  - `behavior === "minimize"` 分支不变（本来就是 hide）。
- 托盘"退出"菜单（`tray-quit-requested`）**同样**必须过运行任务判定与分流——托盘退出是后台模式下唯一的退出入口，不能绕过询问直接杀任务。
- 弹窗选"仍然退出" → 走完整 `runExitCleanup`（同步 → flush 快照 → `pty_close_all` → exit），下次启动由快照恢复契约接管（resume 续对话上下文）。
- 运行判定只信 `running`：`attention`/`done`/`failed`/`none` 不算运行中；shell 源 `command_started` 产生的 `running` 同样计入（普通长命令也是任务）。hook running 超时回退机制（已有）继续生效，避免僵尸 running 永久阻止退出。
- 后台模式期间：
  - `Stop`(done)/`StopFailure`(failed) → 系统通知必发（不受"窗口聚焦不弹通知"类抑制逻辑影响）；`PermissionRequest`/`Notification` attention 类同样必发——任务卡在等确认而用户不知道是最差体验。
  - 全部 running 任务终结（done/failed/超时回退）后**不自动退出、不自动弹窗**，仅通知；进程留在托盘等用户处理（自动退出易与用户正在重开窗口竞态）。
- 重开窗口（托盘左键/通知点击）→ `show()+setFocus()+unminimize()`，清 `isInBackgroundMode`。终端画面天然连续（PTY 未断），**不得**触发 restoreSessions 或 resume。
- 与恢复弹窗互斥：托盘常驻路径全程不产生"下次启动询问恢复"状态——只有真正走了退出链路才落最终快照。
- 设置 UI：`exitWithRunningTasksBehavior` 在设置-通用（紧邻 `closeBehavior`）暴露三选一；弹窗"记住选择"写此设置。

### 4. Validation & Error Matrix

- 无 running 任务 + 任何退出入口 → 行为与改动前逐字节一致（不弹新弹窗）。
- `hide()` 失败 → logWarn 后回退为不处理（窗口留着），禁止误走退出链路。
- 系统通知发送失败 → logWarn，托盘图标仍在，不 crash。
- 后台模式中收到第二次 `tray-quit-requested` 且仍有 running → 仍需弹窗/按设置分流（窗口需先 show 再弹窗，弹窗不能画在隐藏窗口里）。
- 伪会话/已 exited 会话产生的状态残留 → 不得计入 running 判定。

### 5. Good/Base/Bad Cases

- Good: claude 任务跑一半点关闭 → 弹窗选"转入后台" → 窗口消失、任务继续 → 完成后 Windows 通知 → 点通知窗口回来，输出连续无重绘。
- Base: 无任务时点关闭（closeBehavior=exit）→ 直接退出，无新增弹窗。
- Base: 后台模式下任务请求权限（PermissionRequest）→ 系统通知提醒用户回来确认。
- Base: 设置 `background` 后关闭 → 不弹窗直接进后台。
- Bad: 转入后台却调了 `pty_close_all` → 任务被杀，"后台继续"变谎言。
- Bad: 托盘"退出"绕过 running 判定直接杀 → 用户以为在后台跑，实际任务没了。
- Bad: 重开窗口触发 resume → PTY 活着却重跑 resume，产生重复会话。

### 6. Tests Required（验收标准）

- `npx tsc --noEmit` 通过。
- 手动验收（安装版 + `tauri dev` 各过一遍核心项）：
  1. claude/codex 任务运行中，closeBehavior=exit 点关闭 → 出现三选一弹窗；选"转入后台"→ 窗口隐藏、托盘图标在；任务完成收到系统通知；点通知/托盘 → 窗口回来，终端输出连续（无 resume、无清屏重绘）。
  2. 同场景选"仍然退出" → 应用退出；重开时走既有恢复弹窗，claude 会话以 resume 续上。
  3. 无任何 running 任务时关闭/托盘退出 → 与旧版行为一致，零新增交互。
  4. 后台模式下托盘点"退出"（任务仍在跑）→ 窗口先恢复并弹询问，不静默杀任务。
  5. 后台模式跑 >10s 后强杀进程 → 重启后快照恢复可用（兜底链路未被破坏）。
  6. 设置三档各验证一次；弹窗"记住选择"后设置值正确更新。
  7. 普通 shell 长命令（如 `ping -t`）视为 running，同样触发询问。
- 回归红线：`workspace-session-restore-contracts.md` 全部手动用例不回归。

### 7. Wrong vs Correct

#### Wrong

```typescript
// 把"转入后台"接到了退出清理上 —— PTY 被杀，后台继续是假的
const handleBackground = async () => {
  await runExitCleanup("background"); // ❌
};
```

#### Correct

```typescript
const handleBackground = async () => {
  setRunningTasksDialogOpen(false);
  await getCurrentWindow().hide(); // 进程/PTY/hook server 全部存活
  setBackgroundMode(true);         // 仅内存标记，用于通知策略切换
};
```

## Extension: Finished CLI Tasks on Exit (Issue #142)

- `settingsStore.backgroundIncludeFinishedTasks` is a persisted, syncable boolean and defaults to `false`.
- With the setting disabled, exit-task selection must remain identical to `getRunningTaskSessionIds()`: a real PTY whose process status and merged tab status are both `running`.
- With the setting enabled, foreground selection may additionally include only sessions whose **hook source** status is `done` or `failed`.
- The merged tab notification is not sufficient for finished-task detection because ordinary shell `command_finished` events also produce `done` or `failed`.
- `attention` is not a finished-task state and must not change the default exit decision.
- Finished daemon records may be included only while the same setting is enabled.
- Regression coverage must include running PTY, non-PTY, attention, hook done/failed, and shell-only done/failed cases.
