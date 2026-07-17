# Workspace Session Restore Contracts

> 关闭后恢复终端工作区会话（Issue #123）的可执行契约。与 `history-session-contracts.md`（外部 CLI 历史浏览，SQLite `session_meta`）是**两套独立数据**：本契约面向 `tauri-plugin-store` 的工作区 live 终端标签。

## Scenario: Restore Terminal Workspace Sessions on Startup

### 1. Scope / Trigger

- Trigger: 改动启动会话恢复、工作区快照持久化、`restoreSessions` 分流、或 TUI(codex/claude) 会话的恢复方式时。
- 跨层：`sessionStore`(tauri-plugin-store) ↔ `terminalStore.restoreSessions` ↔ `TerminalProcessManager`/PtyHost attach-or-create ↔ CLI resume 命令。

### 2. Signatures

- 持久化：`sessionStore.saveSessions(sessions)` 写当前运行环境会话文件的 `sessions` key（安装版 `~/.cli-manager/sessions.json`，`tauri dev` 为 `~/.cli-manager/sessions.dev.json`；整对象落盘，仅按 `kind` 过滤伪会话，**不删字段**）。
- 恢复开关：`settingsStore.terminalSessionRestoreEnabled: boolean`，默认 `true`。
- 恢复入口：`terminalStore.restoreSessions(projectMap, projectHealth)`（由 `App.tsx` 启动问询弹窗 confirm 后调用；**非 dead code**，务必保持接线）。
- 节流落盘：`sessionSnapshotPersistence.ts` — `registerTerminalSnapshotSource(sessionId, serialize)` / `markTerminalSnapshotDirty(id)` / `flushTerminalSnapshotsNow()`。
- 分流判定：`detectCliResumeKind(startupCmd, project) -> "codex" | "claude" | null`。
- resume 拼接：`buildCliResumeStartupCommand(kind, cliSessionId, project)`，复用 `appendResumeCliArgs`（`projectStartupCommand.ts`）。

### 3. Contracts

- **★核心：TUI 会话恢复必须走 CLI resume，禁止"贴 scrollback + 裸重跑"。** codex/claude 启动用绝对光标定位整屏重绘，会盖掉贴回的 `initialTerminalOutput`。恢复方式**按会话类型分流**：
  - CLI 会话(codex/claude)：**不贴** `initialTerminalOutput`（`deferStartupUntilInitialOutput=false`），startupCmd 用 resume：
    - 有 `cliSessionId` → `codex resume --no-alt-screen <id>` / `claude --resume <id>`
    - 无 `cliSessionId` → 兜底续最近一次 `codex resume --no-alt-screen --last` / `claude --continue`
  - shell 会话：贴回 `initialTerminalOutput`（shell 不清屏，历史可见）。
- `restoreSessions` 重建 session 时**必须保留 `cliSessionId`**——漏掉会导致落盘时 id 丢失、下次恢复只能走兜底。
- resume 命令必须经 `prepareStartupCommandForPty` + `formatStartupInputForPty` 包装，禁止裸写。
- 持续保存：定时节流 10s(`SNAPSHOT_THROTTLE_MS`)，脏检测跳过无新输出的终端，单终端尾部限行 `SNAPSHOT_MAX_LINES=2000`，仅有真实 PTY 会话时启动定时器。正常退出且明确丢弃会话时，`flushTerminalSnapshotsNow()` 必须在 `TerminalProcessManager.closeAll()` 之前强制落盘最终画面。
- 启动问询：有可恢复真实 PTY 会话 → 弹窗询问；无 → 静默进入不弹窗。拒绝 → `sessionStore.clear()` 只清工作区快照，**不碰 SQLite `session_meta`**。
- 环境隔离：Tauri `cfg(dev)` 必须选择 `sessions.dev.json`；安装包继续使用 `sessions.json`。开发版不得读取、迁移或清理安装版会话快照。
- 开关关闭：启动时必须清理当前环境快照，不得显示恢复弹窗或调用 `terminalStore.restoreSessions`。重新开启后只恢复此后新保存的快照。
- daemon 会话优先：启动恢复先调用 `pty_daemon_sessions`。daemon 中仍存在的 session 保留原 session id/startup metadata，标记为待 attach；`XTermTerminal` 必须先订阅输出，再通过 `TerminalProcessManager.attach` 应用尺寸化 replay，禁止重跑 `startupCmd`。
- 待 attach 标记只能在完整 replay 已写入当前 XTerm 后清除；若 Pane 移动/卸载中断回放，标记必须保留，重挂后重新 attach。初始与断线重连 replay 都必须按历史尺寸串行写入，历史 resize 不得写回 live PTY；完成当前容器强制 fit 后才能释放已缓冲的 live 输出。
- 快照/resume 是最终兜底：只有 daemon 会话不存在或 daemon 不可恢复时，CLI 会话才靠 resume 续**对话上下文**，普通 shell 才贴回静态 scrollback。

### 4. Validation & Error Matrix

- startupCmd 含 `codex`/`claude` 整词 或 项目 `cli_tool` 匹配 → CLI 分支；否则 shell 分支。
- CLI 会话 + 有合法 cliSessionId(trim 后非空) → resume `<id>`；否则 → `--last`/`--continue`。
- 项目不存在 / 路径无效 → 跳过或 toast 警告，不 crash。
- 快照序列化单个失败 → 标回脏下轮重试，不拖垮整轮落盘。
- 无可恢复会话 → 不弹窗、不空转定时器。
- `terminalSessionRestoreEnabled=false` → 清理当前环境快照，不弹窗，不影响另一运行环境的 sessions 文件。

### 5. Good/Base/Bad Cases

- Good: codex 会话关闭重开 → 走 `codex resume --no-alt-screen <id>`，CLI 自己重画上次对话且可继续。
- Base: shell 会话关闭重开 → 贴回历史画面，可继续输入。
- Base: 开发版启动时安装版存在 `sessions.json` → 不读取该文件，只检查 `sessions.dev.json`。
- Base: 恢复开关关闭 → 当前环境快照被清理，启动不提示，SQLite 历史会话不受影响。
- Bad: 给 codex/claude 会话贴 `initialTerminalOutput` 再裸重跑 → 历史被 TUI 重绘覆盖（本任务真机复现）。
- Bad: `restoreSessions` 重建时漏带 `cliSessionId` → resume 永远走兜底 `--last`，可能续错会话。

### 6. Tests Required

- `npx tsc --noEmit`（前端唯一静态校验）。
- Rust：会话文件名选择测试必须断言安装环境为 `sessions.json`、开发环境为 `sessions.dev.json`。
- 手动：codex/claude 会话关闭重开走 resume、历史不被清屏覆盖、可继续；shell 会话贴回历史；无会话不弹窗；拒绝后再启动不再询问同批旧标签且 `session_meta` 不受影响；强杀后恢复到 ≤10s 前快照。
- 手动：分别运行安装版与 `tauri dev`，确认两边的恢复提示和清理操作互不影响；关闭恢复开关后重启确认不再提示。

### 7. Wrong vs Correct

#### Wrong

```typescript
// 对 codex/claude 会话贴 scrollback 再重跑 —— 历史会被 TUI 绝对定位重绘覆盖
restoredSession.initialTerminalOutput = ps.initialTerminalOutput;
restoredSession.startupCmd = prepareStartupCommandForPty(ps.startupCmd, shell); // codex/claude
```

#### Correct

```typescript
const kind = detectCliResumeKind(ps.startupCmd, project);
if (kind) {
  // CLI 会话：不贴历史，让 CLI 自己 resume 重画上次对话
  restoredSession.startupCmd = buildCliResumeStartupCommand(kind, ps.cliSessionId, project);
  restoredSession.cliSessionId = ps.cliSessionId; // 必须保留，否则下次恢复丢 id
} else {
  restoredSession.initialTerminalOutput = ps.initialTerminalOutput; // shell 才贴
}
```

> **Warning**: 不要试图"只拦截 codex/claude 的清屏序列(2J/3J)保住贴回的历史"。团队 2026-07-02 已实操"前端拦 ED3 + 改写区域滚动"并**主动回滚**（`docs/debugging/codex-scrollbar-investigation-timeline.md`）——TUI 的绝对定位重绘会照样覆盖历史，此路不通。走 resume。
