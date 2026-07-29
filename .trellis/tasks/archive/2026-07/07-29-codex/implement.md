# 实施计划

1. 读取前端 Trellis 规约与开发前检查清单。
2. 在 `terminalTuiDisplay.ts` 提取可测试的 Codex TUI viewport 判断，复用现有签名。
3. 在 `XTermTerminal.tsx` 的会话上下文中纳入 `session.cliTool`，并让 `isCodexSession` 结合实时 viewport 判断。
4. 增加单元测试，覆盖静态会话元数据、可见 TUI 签名、非 Codex 文本及退出后的非命中行为。
5. 更新 `CHANGELOG.md` 的 `V1.3.3`。
6. 运行相关单元测试、`npx tsc --noEmit` 和差异检查；不主动启动 dev/build。
7. 运行 GitNexus `detect_changes`，确认只影响预期终端流程。
8. 在 `handleCliHookEvent` 中让本地会话的 `cliSessionId` 首次绑定/变化复用现有串行会话保存队列，保留 SSH 原有保存行为。
9. 增加 Hook 绑定持久化到明确 Codex resume 命令的回归测试，并更新 `V1.3.3`。
10. 根据实机失败证据，将保存条件从“内存 ID 变化”改为“持久化快照 ID 与 Hook ID 不一致”，覆盖内存已绑定、磁盘仍为空的自愈场景。
11. 根据双 Tab 现场快照回溯历史继续对话创建链路，在本地/WSL `createSession` 调用中传入所选 `session_id`，并增加同项目不同会话身份隔离回归测试。

## Verification

- `node --test scripts/terminalNewlineShortcut.test.mjs`：4/4 通过，覆盖 normal/alternate buffer。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过，仅有仓库既有 LF/CRLF 提示。
- 禁止诊断输出与 TypeScript 抑制扫描：通过。
- GitNexus `detect_changes`：因 `XTermTerminal` 是终端入口报告 HIGH，映射到 8 条通用终端流程；实际差异复核确认无 IPC、Store、PTY、数据库或依赖变化。
- `node --test scripts/terminalCliSession.test.mjs scripts/resumeCliArgs.test.mjs scripts/terminalNewlineShortcut.test.mjs`：14/14 通过。
- 会话恢复新增变更只在 `handleCliHookEvent` 的 ID 绑定持久化条件；不改 resume 命令格式、PTY、数据库或依赖。GitNexus 对 `handleCliHookEvent` 的修改前影响分析为 LOW；全任务 `detect_changes` 仍因 `XTermTerminal` 总入口报告 HIGH。
- 未启动 Tauri 桌面应用；AC1、AC2、AC4、AC5 保留给人工桌面验证。
- 未启动 Tauri 桌面应用；AC8、AC9、AC10 的最终落盘与重启行为保留给人工桌面验证。
- `resumeSession` GitNexus 修改前影响分析为 LOW；直接影响 `HistoryWorkspace`、`requestResume`，SSH 分支已确认原本携带明确 ID，仅修复本地/WSL 创建边界。
- `node --test scripts/historyResumeProject.test.mjs scripts/terminalCliSession.test.mjs scripts/resumeCliArgs.test.mjs scripts/terminalNewlineShortcut.test.mjs`：19/19 通过；随后单独复跑历史恢复测试 4/4 通过。
- 最新 `npx tsc --noEmit` 与 `git diff --check` 通过；仅有工作树 LF/CRLF 提示。
- 最新 GitNexus `detect_changes` 报告 HIGH，来源是本任务累计修改触及 `XTermTerminal` 与 `HistoryWorkspace` 两个总入口；本轮 `resumeSession` 单符号修改前影响仍为 LOW，未新增后端、IPC、数据库或依赖变化。
