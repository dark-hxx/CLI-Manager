# 修复 Codex 终端换行及会话精确恢复

## Goal

确保终端换行快捷键严格遵循用户设置；无论从项目直接启动 Codex，还是先新建普通终端再手动启动 Codex，设置为 `Shift+Enter` 时都只需按 `Shift+Enter` 即可插入换行。

同时确保 Hook 已获得的 Codex 会话 ID 及时进入工作区快照，关闭并恢复会话时使用明确 ID，而不是错误回退到 `--last`。

## Background

- 用户设置的终端换行快捷键为 `Shift+Enter`。
- 场景一：从项目终端右上角新建普通终端，再手动执行 `codex`，实际需要 `Shift+Alt+Enter`。
- 场景二：部分从项目直接启动的终端，实际需要 `Ctrl+Alt+Enter`，且具有偶发性。
- 首轮修复后用户复测：普通创建的终端和右上角创建的终端仍无法按设置换行；现场 Codex 可运行在 xterm normal buffer，不能假设手动 Codex 必然使用 alternate buffer。
- 当前设置默认值和设置页均正确保存 `Shift+Enter`；问题位于终端运行态识别或按键序列转换链路。
- `XTermTerminal.isCodexSession()` 目前只依据项目 `cli_tool`、Tab 标题和启动命令判断；普通 Shell 内手动启动 Codex 后这些静态元数据不会更新。
- `TerminalSession.cliTool` 已在创建 Agent 终端时固化，但 `getSessionToolContext()` 未读取该字段，项目配置加载/变化或特殊创建路径下会漏判项目直启 Codex。
- 终端渲染逻辑已有 Codex TUI 可见签名识别能力，可用于无 Hook 的手动启动场景，无需新增进程探测 IPC。
- Codex 会话的配置快捷键命中后发送 `ESC + CR`，普通会话发送 `LF`。
- 换行修复实机验证通过后发现：Hook 会把 `payload.sessionId` 更新到内存中的 `TerminalSession.cliSessionId`，但本地会话不会立即调用 `saveSessions`；应用关闭后，恢复快照仍缺少 ID，因此 `buildCliResumeStartupCommand` 只能生成 `codex resume --no-alt-screen --last`。
- 首轮持久化修复后实机仍复现：开发环境 `sessions.dev.json` 中 Codex 会话 ID 为空，而运行态内存可能已绑定 ID；只依据内存 `changed` 判断会让 HMR、旧事件或保存失败造成的内存/磁盘分叉永久无法自愈。

## Requirements

- R1：配置为 `Shift+Enter` 时，单独按 `Shift+Enter` 必须在 Codex 输入框插入换行，不得要求额外按 Alt 或 Ctrl。
- R2：同时覆盖项目直接启动 Codex、普通 Shell 中手动启动 Codex、新建 Tab 后手动启动 Codex。
- R3：不能破坏普通 Shell、Claude CLI 以及 `Ctrl+Enter` / `Alt+Enter` 两种可选配置。
- R4：运行态识别只能扫描当前 viewport，不得用离屏历史输出判断当前 CLI。
- R5：覆盖本地 PowerShell/CMD/Pwsh、WSL；Hook 已安装与未安装时行为一致。
- R6：不新增依赖，不升级 Tauri、React、Codex 或其他依赖版本。
- R7：变更记录写入 `CHANGELOG.md` 的 `V1.3.3`。
- R8：本地和 SSH 会话首次绑定或切换 `cliSessionId` 后必须立即持久化；运行态 ID 与持久化快照一致时不得新增本地写入，磁盘缺失或不同则必须自愈保存。
- R9：恢复快照存在合法 `cliSessionId` 时，Codex 恢复命令必须携带该明确 ID；仅确实缺失 ID 时允许回退 `--last`。
- R10：从历史记录“继续对话”创建本地、WSL 或 SSH 终端时，Tab 必须立即绑定所选历史 Session ID；同项目多个会话关闭恢复后不得串话。

## Acceptance Criteria

- [ ] AC1：项目直启 Codex 时，设置为 `Shift+Enter`，连续多次新建 Tab/切换 Tab 后均可仅用 `Shift+Enter` 换行。
- [ ] AC2：普通终端内手动执行 `codex` 后，仅用 `Shift+Enter` 即可换行。
- [ ] AC3：普通 Shell 退出 Codex 且当前 viewport 不再包含 Codex TUI 签名后，快捷键恢复普通终端换行语义。
- [ ] AC4：设置为 `Ctrl+Enter` 或 `Alt+Enter` 时，仅配置的组合键触发换行，其他受管组合键不误触发。
- [ ] AC5：Hook 已安装/未安装、本地终端/WSL 均通过对应测试或可重复的手动验证。
- [x] AC6：前端类型检查及相关单元测试通过。
- [x] AC7：`CHANGELOG.md` 的 `V1.3.3` 包含本次修复说明。
- [ ] AC8：本地 Hook 首次绑定或切换 ID 后，工作区快照保存更新后的 `cliSessionId`。
- [ ] AC9：关闭并恢复该会话时执行 `codex resume --no-alt-screen <id>`，不出现 `--last`。
- [ ] AC10：重复上报相同 ID 不触发新的本地快照写入，SSH 原有会话身份持久化行为不回退。
- [ ] AC11：同一项目先继续历史会话 A、再打开新会话 B，关闭并恢复后两个 Tab 分别携带 A、B 的明确 ID，均不使用 `--last`。

## Root-Cause Statement

缺陷位于前端终端会话类型识别边界：换行转换依赖静态项目/标题/启动命令，却遗漏已固化的会话 `cliTool` 和当前可见 Codex TUI 状态，导致部分项目直启及普通 Shell 手动启动 Codex 被误判为普通终端并发送裸 `LF`；修复应落在统一会话识别层，而非更改快捷键配置或增加组合键兜底。

会话恢复缺陷位于 Hook 运行态身份到工作区持久化快照的边界：首轮修复只检查 Zustand 内存 ID 是否变化，未检查 `sessionStore` 快照是否实际一致，导致 HMR、旧事件或保存失败留下的内存/磁盘分叉无法重试，重启仍读取空 ID 并回退 `--last`；修复应在 Hook 入口对账持久化快照，而不是修改恢复命令兜底规则。

用户最新现场的主缺陷位于历史继续对话到终端创建的身份边界：本地/WSL 分支只把所选 Session ID 写入一次性 resume 命令，却漏传 `createSession` 的 `cliSessionId`，导致首次启动正确、工作区快照身份为空，重启后该 Tab 退化为 `--last` 并进入另一个最近会话；修复必须落在 `HistoryWorkspace.resumeSession` 的创建边界。

## Discovery List

- `src/components/XTermTerminal.tsx:getSessionToolContext/isCodexSession`：直接根因；需要纳入会话 `cliTool` 与当前终端 TUI 状态。
- `src/lib/terminalTuiDisplay.ts`：已有 AI TUI 可见签名扫描；复用并拆出 Codex 专用只读判断。
- `src/stores/settingsStore.ts`：已确认无关；默认值、持久化校验均正确支持 `Shift+Enter`。
- `src/components/settings/pages/ShortcutSettingsPage.tsx`：已确认无关；UI 选中态和更新逻辑正确。
- `src/stores/terminalStore.ts`（换行子问题）：创建项目 Agent 终端时已经固化 `TerminalSession.cliTool`，换行识别无需修改 Store 创建逻辑。
- PTY 后端：已由历史任务确认原样转发字节，本次不修改。
- `src/stores/terminalStore.ts:handleCliHookEvent`：会话恢复根因；ID 真正变化后需要立即保存当前会话快照。
- `src/stores/sessionStore.ts:saveSessions`：复用现有整对象持久化入口；确认会保留 `cliSessionId`，无需修改。
- `src/stores/terminalStore.ts:buildCliResumeStartupCommand/restoreSessions`：确认消费持久化 ID 并构造明确恢复命令，无需修改。
- `src/components/HistoryWorkspace.tsx:resumeSession`：最新现场的直接根因；SSH 分支已传预检后的 ID，本地/WSL 分支漏传第 10 个 `cliSessionId` 参数。
- `scripts/historyResumeProject.test.mjs`：增加历史继续对话创建时绑定明确 ID 的回归约束。
- SSH 会话身份保存链路：继续复用串行保存队列，保持远端会话元数据持久化行为。

## Out of Scope

- 修改 Codex CLI 自身快捷键配置。
- 升级 Codex CLI 或项目依赖。
- 重构无关的终端输入、补全或 IME 逻辑。

## Changelog Target

`V1.3.3`
