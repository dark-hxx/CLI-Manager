# fix-grok-build-alt-enter

## Goal

修复 Issue #236：在 CLI-Manager 的 Grok Build 终端中，用户按 `Alt + Enter` 时必须触发 Grok Build 的“换行但不提交”，无需额外按 `Shift`。

## Background / Confirmed Facts

- 当前终端键位设置已经提供 `Shift + Enter`、`Ctrl + Enter`、`Alt + Enter` 三种选项，设置存储、迁移和 UI 均已存在；本任务不新增设置项。
- `src/components/XTermTerminal.tsx:1516-1589` 的 xterm 自定义键盘处理器会拦截三种受管理组合键，并通过 `terminalProcessManager.write()` 直接向 PTY 写入换行数据。
- 该处理器当前只通过 `isCodexSession()` 为 Codex 选择 `ESC + CR`（`\x1b\r`）；其余 CLI 发送 `LF`（`\n`）。
- xterm 的原生键盘映射在 `node_modules/@xterm/xterm/src/common/input/Keyboard.ts` 的 Enter 分支中将 Alt+Enter 编码为 `ESC + CR`。因此 Grok Build 经 CLI-Manager 自定义处理后收到的字节与原生 Alt+Enter 不一致。
- `src/terminal/browser/TerminalCliContext.ts:36-57` 已集中读取会话 CLI、项目 CLI、启动命令和标题中的 CLI 身份，但目前没有 Grok Build 分类器。
- `TerminalProcessManager.write()`、`PtyHostSocket.write()` 以及 Rust PTY 数据通道已经可以透传任意字符串；本 Bug 不需要修改 IPC/PTY 契约。

## Root-Cause Statement

根因位于前端键盘事件到 PTY 字节编码边界：`XTermTerminal` 的换行拦截只识别 Codex，导致 Grok Build 会话收到 `LF` 而不是其 Alt+Enter 所需的 `ESC + CR`；修复应补齐会话分类并在该编码源头选择正确序列，而不是在 Grok 的表现层增加兜底。

## Requirements

- R1：对 Grok Build 会话，当前设置选中的三种 `* + Enter` 组合键都发送 Grok Build 可识别的 `ESC + CR`，其中选择 `Alt + Enter` 时直接满足 Issue #236 的预期。
- R2：普通 Shell、Claude 及其他未识别 CLI 继续使用现有 `LF` 行为；Codex 现有 `ESC + CR` 行为不变。
- R3：Grok Build 会话识别复用现有会话上下文来源，覆盖项目/会话 CLI 元数据、启动命令和标题信息，并保持普通终端不误识别。
- R4：不修改终端设置选项、持久化字段、PTY/IPC 接口或单按 Enter 的提交行为。
- R5：增加回归验证，覆盖 Grok Build 识别、普通终端排除，以及自定义换行路径使用 `ESC + CR` 的代码接线。

## Scope

### In Scope

- 扩展终端 CLI 上下文的 Grok Build 识别。
- 将 Grok Build 纳入现有换行字节选择逻辑。
- 更新终端换行回归测试、相关契约说明和交付记录。

### Out of Scope

- 修改 Grok Build 本身的键位或 CLI 行为。
- 修改 xterm.js、Rust PTY daemon、WebSocket/IPC 协议。
- 调整鼠标指针样式、鼠标交互或全局快捷键；Issue 中出现的十字指针是伴随现象，本任务只修复 Alt+Enter 的输入字节。
- 为无项目/无启动命令且运行时手动输入 `grok` 的普通 Shell 添加新的 Grok 输出探测机制；现有任务只保证可由终端元数据确认的 Grok Build 会话。

## Scenario Matrix

由于根因陈述包含“Grok Build 会话”这一状态限定，按修复闸机要求检查以下运行场景：

| 维度 | 覆盖结论 |
|---|---|
| 窗口焦点 | 当前窗口且目标终端获得焦点：必须发送；其他窗口或应用未聚焦：浏览器/操作系统不应被应用逻辑误处理，确认不改变现有焦点边界 |
| 分屏 | 当前 pane、同窗口其他 pane、深层 split 节点：只对实际获得焦点的 Grok pane 生效 |
| 最小化/托盘 | 正常窗口验证输入；最小化/托盘不产生伪输入，恢复后仍按当前活动会话判断 |
| UI 展示模式 | 展开、折叠、紧凑嵌入：键盘处理器归属于终端实例，行为一致 |
| 多会话/Workspan | 单会话、多会话切换、Workspan 切换：使用当前 sessionId 与当前会话元数据，不串写其他 PTY |
| Focus mode | 开启/关闭：不改变终端组合键到 PTY 的编码 |
| 运行环境 | Windows PowerShell/CMD/Pwsh、WSL、Bash 及 SSH PTY：共用同一写入契约，均透传 `ESC + CR`；环境差异不在本次代码分支中新增 |
| Worktree | 主仓库、Worktree、缺失目录、`.git` 文件型 linked worktree：与键位编码无关，确认项目/会话元数据仍是唯一分类输入 |
| CLI Hook | Claude/Codex/Grok Hook 已安装、未安装、仅安装一种：Hook 安装状态不参与键位分类，行为不应变化 |

## Discovery List

- [x] `src/components/XTermTerminal.tsx:1516-1589`：组合键拦截与 PTY 写入源头，需修改。
- [x] `src/terminal/browser/TerminalCliContext.ts:3-57`：CLI 会话上下文分类，需增加 Grok Build 分类器。
- [x] `src/terminal/core/TerminalProcessManager.ts`：确认 `write(sessionId, data)` 契约无需修改。
- [x] `src/terminal/transport/PtyHostSocket.ts`：确认 PTY/WebSocket 写入链路无需修改。
- [x] `src/stores/settingsStore.ts:201,393,554,1712-1718`：确认三种设置、默认值与迁移已存在且无需修改。
- [x] `src/components/settings/pages/ShortcutSettingsPage.tsx:27-31,145-164`：确认设置 UI 已存在且无需修改。
- [x] `src/stores/terminalStore.ts:2071-2119`、`src/lib/agentTerminal.ts`：确认创建会话时保留项目 CLI 到 `TerminalSession.cliTool`，无需修改。
- [x] `src/lib/agentCapabilities.ts:89-98`：已有较宽泛的 Grok 运行时分类，但服务能力/远程交接场景；确认不复用到终端输入，以免扩大其影响面，终端继续使用专用上下文分类。
- [x] `scripts/terminalNewlineShortcut.test.mjs`：现有终端换行/Codex 检查入口，需补充 Grok 回归断言。
- [x] `.trellis/spec/frontend/component-guidelines.md`：已有 Codex `ESC + CR` 契约，需同步扩展为 Codex/Grok Build。
- [x] `src-tauri/src/`：无 PTY/Rust 代码触点需要修改；数据已经由前端传至现有写入通道。

## Acceptance Criteria

- [ ] 在项目 CLI 为 Grok Build 的终端中，设置为 `Alt + Enter` 时按下 `Alt + Enter`，Grok Build 进入下一输入行且不提交当前消息。
- [ ] 设置为 `Shift + Enter` 或 `Ctrl + Enter` 时，Grok Build 仍使用同一逻辑换行序列；三种设置均不再要求额外按 `Shift`。
- [ ] 普通 Shell、Claude 和 Codex 的既有换行/提交行为保持不变；单按 Enter 仍提交。
- [ ] 项目/会话元数据、启动命令或标题能识别 Grok Build；普通 Shell 不被识别为 Grok。
- [ ] `node --test scripts/terminalNewlineShortcut.test.mjs` 通过，且 `npx tsc --noEmit` 通过。
- [ ] 中英文设置页面无需新增文案，现有三种终端键位在两种语言下保持可用。

## Open Questions

无。用户已确认允许创建 Trellis task，并指定交付版本 `V1.3.9`。
