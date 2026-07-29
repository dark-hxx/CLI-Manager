# Workspace Session Restore Contracts

> 关闭后恢复终端工作区会话（Issue #123）的可执行契约。与 `history-session-contracts.md`（外部 CLI 历史浏览，SQLite `session_meta`）是**两套独立数据**：本契约面向 `tauri-plugin-store` 的工作区 live 终端标签。

## Scenario: Restore Terminal Workspace Sessions on Startup

### 1. Scope / Trigger

- Trigger: 改动启动会话恢复、工作区快照持久化、`restoreSessions` 分流、或 TUI(codex/claude) 会话的恢复方式时。
- 跨层：`sessionStore`(tauri-plugin-store) ↔ `terminalStore.restoreSessions` ↔ `TerminalProcessManager`/PtyHost attach-or-create ↔ CLI resume 命令。

### 2. Signatures

- 持久化：`sessionStore.saveSessions(sessions)` 写当前运行环境会话文件的 `sessions` key（安装版 `~/.cli-manager/sessions.json`，`tauri dev` 为 `~/.cli-manager/sessions.dev.json`；整对象落盘，仅按 `kind` 过滤伪会话，**不删字段**）。
- 恢复开关：`settingsStore.terminalSessionRestoreEnabled: boolean`（总开关，默认 `true`）。
- 恢复方式：`settingsStore.terminalSessionRestoreMode: "ask" | "auto"`，默认 `"ask"`。`ask` = 启动弹窗询问；`auto` = 启动静默直接恢复。二者均只在应用启动时刻触发一次（见守护变量约定）。
- 恢复入口：`terminalStore.restoreSessions(projectMap, projectHealth)`（由 `App.tsx` init 直接调用（`auto`）或启动问询弹窗 confirm 后调用（`ask`）；**非 dead code**，务必保持接线）。
- 每进程一次守护：`App.tsx` 模块级 `sessionRestoreHandled` 变量保证恢复提示/自动恢复只在 `init()` 里触发一次。切换设置页等后续操作禁止再次弹窗——这是历史上功能被移除的根因（提示曾反复弹）。
- 恢复确认交互：共享 `ConfirmDialog` 提供默认关闭的 `confirmAutoFocus?: boolean` 与 `contentClassName?: string`；恢复弹窗单独启用确认按钮聚焦与响应式专用宽度。
- 节流落盘：`sessionSnapshotPersistence.ts` — `registerTerminalSnapshotSource(sessionId, serialize)` / `markTerminalSnapshotDirty(id)` / `flushTerminalSnapshotsNow()`。
- 分流判定：`detectCliResumeKind(startupCmd, project) -> "codex" | "claude" | null`。
- resume 拼接：`buildCliResumeStartupCommand(kind, cliSessionId, project)`，复用 `appendResumeCliArgs`（`projectStartupCommand.ts`）。
- Hook 身份绑定：`terminalStore.handleCliHookEvent(payload)` 通过 `resolveCliSessionRebind(currentId, payload.sessionId)` 更新运行态 `TerminalSession.cliSessionId`，再用相同规则对账 `sessionStore.sessions` 中的持久化 ID；持久化快照缺失或不同时必须立即调用串行保存入口。
- 历史继续对话：`HistoryWorkspace.resumeSession(...)` 在创建本地、WSL 或 SSH 终端时必须把当前选中历史记录的明确 Session ID 传给 `terminalStore.createSession(..., cliSessionId)`；不能只把 ID 放进一次性 `startupCmd`。

### 3. Contracts

- **★核心：TUI 会话恢复必须走 CLI resume，禁止"贴 scrollback + 裸重跑"。** codex/claude 启动用绝对光标定位整屏重绘，会盖掉贴回的 `initialTerminalOutput`。恢复方式**按会话类型分流**：
  - CLI 会话(codex/claude)：**不贴** `initialTerminalOutput`（`deferStartupUntilInitialOutput=false`），startupCmd 用 resume：
    - 有 `cliSessionId` → `codex resume --no-alt-screen <id>` / `claude --resume <id>`
    - 无 `cliSessionId` → 兜底续最近一次 `codex resume --no-alt-screen --last` / `claude --continue`
  - shell 会话：贴回 `initialTerminalOutput`（shell 不清屏，历史可见）。
- `restoreSessions` 重建 session 时**必须保留 `cliSessionId`**——漏掉会导致落盘时 id 丢失、下次恢复只能走兜底。
- 从历史记录“继续对话”新建的 Tab 在创建时就必须持有对应 `cliSessionId`。同一项目、同一 cwd 下创建多个不同历史会话时，每个 Tab 的身份必须保持独立，不得依赖后续 Hook 或 `--last` 猜测。
- Hook 首次绑定或 `/clear` 后切换到新的非空 `cliSessionId` 时，本地、WSL 和 SSH 会话都必须立即保存更新后的完整 sessions 快照；不得只更新 Zustand 运行态内存。保存判断必须对账 `sessionStore.sessions`，不能只看运行态 ID 是否变化：HMR、旧事件或保存失败可能造成“运行态已有 ID、磁盘仍为空”。仅当持久化 ID 与 Hook ID 已一致时，本地会话才跳过写盘；SSH 原有远端身份元数据保存行为保持不变。
- resume 命令必须经 `prepareStartupCommandForPty` + `formatStartupInputForPty` 包装，禁止裸写。
- `appendResumeCliArgs` 在继承项目普通 CLI 参数前必须移除 `cli_args` 中已有的 `resume <id>`、`resume --no-alt-screen <id>`、`--resume <id>`、`--continue` 等会话选择片段；新命令中的目标 Session ID 只能出现一次，Provider 参数仍须保留并去重。
- 持续保存：定时节流 10s(`SNAPSHOT_THROTTLE_MS`)，脏检测跳过无新输出的终端，单终端尾部限行 `SNAPSHOT_MAX_LINES=2000`，仅有真实 PTY 会话时启动定时器。正常退出且明确丢弃会话时，`flushTerminalSnapshotsNow()` 必须在 `TerminalProcessManager.closeAll()` 之前强制落盘最终画面。
- 启动问询（`mode=ask`）：有可恢复真实 PTY 会话 → 弹窗询问；无 → 静默进入不弹窗。拒绝 → `sessionStore.clear()` 只清工作区快照，**不碰 SQLite `session_meta`**，并 `TerminalProcessManager.closeAll()` 关闭无人认领的 daemon 会话。
- 自动恢复（`mode=auto`）：有可恢复真实 PTY 会话 → 不弹窗，`init()` 直接调用 `restoreSessions`；无 → 静默进入。daemon 会话仍走 `restoreSessions` 内部 attach 优先，与后台续跑不冲突。
- **★每进程只触发一次**：`App.tsx` 模块级 `sessionRestoreHandled` 守护——恢复弹窗/自动恢复只在 `init()` 里触发一次并立即置位。切换设置页等任何后续渲染都不得重新触发（历史教训：`735123d2` 拆功能的根因就是提示不受控、切设置页反复弹）。
- 恢复确认弹窗必须使用简洁单句提示和该调用点专用的响应式宽度：常规桌面宽度目标为提示语单行，窄窗口保留左右安全间距并自然收缩，禁止横向溢出。
- 恢复确认弹窗打开时必须默认聚焦“恢复”按钮，使 Enter 直接确认；该行为通过 Radix `onOpenAutoFocus` + confirm button ref 显式完成，禁止 DOM 查询或按按钮文案查找。共享 `ConfirmDialog` 的可选 props 默认关闭，其他调用点的焦点、宽度和行为不得改变。
- 环境隔离：Tauri `cfg(dev)` 必须选择 `sessions.dev.json`；安装包继续使用 `sessions.json`。开发版不得读取、迁移或清理安装版会话快照。
- 开关关闭：启动时必须清理当前环境快照，不得显示恢复弹窗或调用 `terminalStore.restoreSessions`。重新开启后只恢复此后新保存的快照。
- daemon 会话优先：启动恢复先调用 `pty_daemon_sessions`。daemon 中仍存在的 session 保留原 session id/startup metadata，标记为待 attach；`XTermTerminal` 必须先订阅输出，再通过 `TerminalProcessManager.attach` 应用尺寸化 replay，禁止重跑 `startupCmd`。
- 待 attach 标记只能在完整 replay 已写入当前 XTerm 后清除；若 Pane 移动/卸载中断回放，标记必须保留，重挂后重新 attach。初始与断线重连 replay 都必须按历史尺寸串行写入，历史 resize 不得写回 live PTY；完成当前容器强制 fit 后才能释放已缓冲的 live 输出。
- 快照/resume 是最终兜底：只有 daemon 会话不存在或 daemon 不可恢复时，CLI 会话才靠 resume 续**对话上下文**，普通 shell 才贴回静态 scrollback。

### 4. Validation & Error Matrix

- startupCmd 含 `codex`/`claude` 整词 或 项目 `cli_tool` 匹配 → CLI 分支；否则 shell 分支。
- CLI 会话 + 有合法 cliSessionId(trim 后非空) → resume `<id>`；否则 → `--last`/`--continue`。
- Hook sessionId 首次出现或发生变化 → 更新运行态并立即排队保存；运行态 ID 相同但持久化 ID 缺失/不同 → 自愈保存；空 ID → 不覆盖；运行态和持久化 ID 都一致 → 不为本地会话新增保存。
- 本地/WSL 历史继续对话 → `startupCmd` 与 `cliSessionId` 使用同一个选中历史 Session ID；SSH 分支继续使用预检确认后的 `sourceSessionId`。
- 项目不存在 / 路径无效 → 跳过或 toast 警告，不 crash。
- 快照序列化单个失败 → 标回脏下轮重试，不拖垮整轮落盘。
- 无可恢复会话 → 不弹窗、不调用 `restoreSessions`、不空转定时器。
- `terminalSessionRestoreEnabled=false` → 清理当前环境快照，不弹窗，不影响另一运行环境的 sessions 文件。
- `terminalSessionRestoreMode=ask` + 有可恢复会话 → 每进程仅打开一次确认弹窗；确认后调用一次 `restoreSessions`。
- 恢复确认弹窗打开 → “恢复”按钮获得焦点；直接按 Enter 触发确认。未启用 `confirmAutoFocus` 的其他 `ConfirmDialog` 调用点继续沿用 Radix 默认焦点行为。
- 常规桌面宽度 → 恢复提示语单行；窄窗口 → 弹窗宽度不超过视口减安全间距，无横向溢出。
- `terminalSessionRestoreMode=auto` + 有可恢复会话 → 每进程仅调用一次 `restoreSessions`，不打开确认弹窗。
- 持久化恢复方式缺失或不是 `ask` / `auto` → 加载时回退默认值 `ask`。

### 5. Good/Base/Bad Cases

- Good: codex 会话关闭重开 → 走 `codex resume --no-alt-screen <id>`，CLI 自己重画上次对话且可继续。
- Good: Hook 先绑定 ID，再关闭应用并恢复 → 快照保留该 ID，恢复命令不会漂移到 `--last`。
- Good: 同一项目下分别继续历史会话 A、再新建会话 B，关闭并恢复 → 两个 Tab 分别恢复 A、B，不会都进入最近的 B。
- Base: shell 会话关闭重开 → 贴回历史画面，可继续输入。
- Base: 同一会话的 Stop/UserPromptSubmit 重复携带相同 ID，且 `sessionStore` 已持有该 ID → 本地会话不重复保存身份快照。
- Base: 开发版启动时安装版存在 `sessions.json` → 不读取该文件，只检查 `sessions.dev.json`。
- Base: 恢复开关关闭 → 当前环境快照被清理，启动不提示，SQLite 历史会话不受影响。
- Bad: 给 codex/claude 会话贴 `initialTerminalOutput` 再裸重跑 → 历史被 TUI 重绘覆盖（本任务真机复现）。
- Bad: `restoreSessions` 重建时漏带 `cliSessionId` → resume 永远走兜底 `--last`，可能续错会话。
- Bad: Hook 只把 `cliSessionId` 写进 Zustand 内存，等待其他偶然保存路径 → 应用关闭时磁盘仍是旧快照，恢复可能续错最近会话。
- Bad: 用运行态 `resolveCliSessionRebind(...).changed` 作为唯一保存条件 → 运行态/磁盘一旦分叉，相同 ID 的后续 Hook 永远不会修复磁盘。
- Bad: 历史继续对话只生成 `codex resume <id>` 启动命令，却不给新 Tab 设置 `cliSessionId` → 首次运行看似正确，重启时快照只能生成 `--last` 并串到另一个最近会话。

### 6. Tests Required

- `npx tsc --noEmit`（前端唯一静态校验）。
- `node scripts/resumeCliArgs.test.mjs`（恢复参数去重、普通参数保留、Provider 参数单次追加）。
- `node --test scripts/terminalCliSession.test.mjs`：断言首次绑定和 `/clear` 重绑返回 `changed=true`、运行态相同 ID 返回 `changed=false`、持久化 ID 缺失时仍返回 `changed=true`，并断言 Hook 对账 `sessionStore.sessions` 后接入串行保存且 Codex 恢复优先使用明确 ID。
- `node --test scripts/historyResumeProject.test.mjs`：断言本地/WSL 项目匹配，并断言历史继续对话创建 Tab 时把所选 `session_id` 传入 `cliSessionId` 参数。
- Rust：会话文件名选择测试必须断言安装环境为 `sessions.json`、开发环境为 `sessions.dev.json`。
- 手动：`ask` 模式仅在启动时弹一次；确认后恢复，拒绝后再启动不再询问同批旧标签且 `session_meta` 不受影响；切换设置页不重复弹窗。
- 手动：恢复弹窗在常规桌面宽度下提示语单行，缩窄窗口后自然收缩且无横向溢出；打开时焦点落在“恢复”，直接按 Enter 执行恢复；抽查其他确认弹窗保持原默认焦点和宽度。
- 手动：`auto` 模式启动不弹窗并直接恢复；codex/claude 会话走 resume、历史不被清屏覆盖且可继续；shell 会话贴回历史；强杀后恢复到 ≤10s 前快照。
- 手动：无会话不弹窗；分别运行安装版与 `tauri dev`，确认两边的恢复提示和清理操作互不影响；关闭恢复开关后重启确认不再提示，常规设置页的恢复方式选择器置灰。

### 7. Wrong vs Correct

#### Wrong

```typescript
// 对 codex/claude 会话贴 scrollback 再重跑 —— 历史会被 TUI 绝对定位重绘覆盖
restoredSession.initialTerminalOutput = ps.initialTerminalOutput;
restoredSession.startupCmd = prepareStartupCommandForPty(ps.startupCmd, shell); // codex/claude
```

```typescript
// 只更新运行态内存，关闭应用后磁盘快照仍可能没有 id
set({ sessions: sessionsWithBoundCliSessionId });
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

```typescript
const persisted = useSessionStore.getState().sessions.find((item) => item.id === tabId);
const persistedRebind = resolveCliSessionRebind(persisted?.cliSessionId, payload.sessionId);
if (persistedRebind.changed) {
  void queueSshSessionPersistence(get().sessions); // 串行保存完整快照；本地/WSL/SSH 一致
}
```

> **Warning**: 不要试图"只拦截 codex/claude 的清屏序列(2J/3J)保住贴回的历史"。团队 2026-07-02 已实操"前端拦 ED3 + 改写区域滚动"并**主动回滚**（`docs/debugging/codex-scrollbar-investigation-timeline.md`）——TUI 的绝对定位重绘会照样覆盖历史，此路不通。走 resume。
