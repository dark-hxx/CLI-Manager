# Fix Grok Build Alt+Enter follow-up

## Goal

修复 Issue #236 的未覆盖场景：用户在 CLI-Manager 的普通 Shell 终端中手动输入并启动 `grok` 后，按 `Alt + Enter` 必须向 Grok Build 发送“换行但不提交”的字节序列，不需要额外按 `Shift`。

上一版 V1.3.9 修复只覆盖了项目/会话/启动命令等静态元数据可识别的 Grok 会话；用户反馈仍无法使用，说明实际复现路径包含“普通 Shell 中手动启动 Grok”或终端事件路径未被回归测试覆盖。本次按根因修复并补齐该运行时边界。

## Root-Cause Statement

根因在前端键盘事件到 PTY 字节编码边界：`XTermTerminal` 的自定义 Enter 处理器会拦截宿主管理的组合键，而普通 Shell 内手动启动 `grok` 不会更新 `TerminalSession` 的 CLI 元数据，导致 Grok 的原生 `Alt + Enter` 被吞掉或被错误编码为 `LF`，无法到达其所需的 `ESC + CR`。因此修复必须同时补齐运行时 CLI 识别和未匹配原生 `Alt + Enter` 的事件放行，不能只扩展静态分类器。

## Discovery List

- [x] `XTermTerminal`：自定义键盘处理器决定组合键是否拦截及发送 `LF` / `ESC + CR`。
- [x] `TerminalCliContext`：静态项目、会话、启动命令、标题分类已支持 Grok，但无法识别普通 Shell 内后来启动的 CLI。
- [x] `useTerminalInput.attachInputForwarding`：拥有当前 Shell 输入缓冲，并在提交 `\r` 前可提供“刚提交的命令”运行时证据；当前没有把该证据通知终端组件。
- [x] `TerminalProcessManager` / PTY host：写入链路字节透明，无需改变 IPC、WebSocket 或 Rust 契约。
- [x] 设置 Store/UI：三种终端换行键位已存在，本次不新增文案或设置字段。
- [x] 官方 Grok Build 键位文档与更新记录：确认 `Alt + Enter` 是 Grok Build 的多行输入路径；本任务仍以 CLI-Manager 的 PTY 字节协议为实现依据。

## Requirements

- R1：静态元数据可识别的 Grok Build 会话继续对选中的 `Shift + Enter`、`Ctrl + Enter`、`Alt + Enter` 发送 `ESC + CR`。
- R2：普通 Shell 中提交一个明确的 Grok 启动命令（至少覆盖 `grok`、可执行文件后缀和带参数形式）后，当前终端实例能够识别 Grok，并让选中的换行组合键发送 `ESC + CR`。
- R3：手动运行时识别只接受命令级证据，不得因 `echo grok`、`grok-helper` 等普通命令误判；识别状态只保存在当前终端组件运行态，不写入 `TerminalSession`、项目设置或持久化快照。
- R4：运行时识别必须受当前可见终端状态约束；当前 viewport 不再显示 TUI 输入提示、终端会话切换/销毁或 PTY 完整退出时，应清除手动 Grok 运行态，避免退出 Grok 后普通 Shell 继续收到 `ESC + CR`。
- R5：普通 Shell、Claude、其他 CLI 及单按 Enter 的提交行为保持不变；Codex 现有 `ESC + CR` 行为保持不变。
- R6：回归测试必须覆盖“命令提交 → 运行时识别 → 换行字节选择”的关键接线，而不是只检查静态源码片段；同时覆盖误判排除和运行态清除条件。
- R7：不修改 Grok Build、xterm.js、PTY/Rust、IPC 契约、终端设置选项或新增用户可见文案。
- R8：当当前会话已确认是 Grok Build 或 Codex 时，即使应用设置选择了其他换行组合键，原生 `Alt + Enter` 也不得被宿主处理器吞掉，必须继续交由 xterm/CLI 处理；普通 Shell 和其他 CLI 仍保持未匹配组合键拦截规则。

## Scenario Matrix

| 维度 | 必须覆盖的场景 | 预期 |
|---|---|---|
| CLI 来源 | 项目/会话已配置 Grok；普通 Shell 手动提交 `grok`；手动提交 `grok --continue` / 后缀可执行文件 | 均可使用配置中的换行组合键发送 `ESC + CR` |
| 误判 | `echo grok`、`grok-helper`、普通 Shell 未提交 Grok、普通 CLI 文本包含 `grok` | 保持普通 Shell `LF` |
| 键位设置 | Shift+Enter、Ctrl+Enter、Alt+Enter，以及 Grok/Codex 的原生 Alt+Enter | 选中的组合键生效；Grok/Codex 未选中的原生 Alt+Enter 仍放行；单 Enter 仍提交 |
| TUI 生命周期 | Grok TUI 输入提示可见；滚动到非输入 viewport；Grok 退出回 Shell；终端组件重新挂载 | 只在当前可见 TUI 证据成立时使用 Grok 字节；离开后恢复 Shell 行为 |
| 焦点/分屏 | 当前活动 Grok pane、同窗其他 pane、切换 pane、Workspan/分屏重挂载 | 只影响当前 `sessionId`，不串写其他 PTY |
| 环境 | PowerShell/CMD/Pwsh、WSL、Bash、SSH PTY、Worktree | 复用现有透明写入链路，不新增环境分支 |
| Hook/设置 | Hook 已装/未装；终端三种键位已迁移或默认值 | Hook 不参与分类；现有设置状态不变 |
| UI 状态 | 窗口失焦、最小化/托盘、终端隐藏后恢复 | 不产生伪写入；恢复后按当前终端上下文判断 |

## Scope

### In Scope

- 在终端输入转发层暴露当前命令提交事件。
- 增加精确的手动 Grok 启动命令识别。
- 在 `XTermTerminal` 中接入组件级、受当前 viewport 约束的运行时识别与清除。
- 补充真实输入路径的纯函数/接线回归测试，更新终端契约、CHANGELOG 和功能清单。

### Out of Scope

- 修改 Grok Build 本身的键位、TUI 或版本。
- 修改 xterm.js、Rust PTY daemon、WebSocket/IPC、数据库和设置迁移。
- 通过前台进程查询或新增 IPC 推断子进程名称。
- 修改鼠标指针样式、鼠标报告或全局快捷键；截图中的十字指针不是本次字节编码根因。
- 将手动推断出的 Grok 身份写入 session/project 持久化数据。

## Acceptance Criteria

- [x] 静态配置 Grok 和普通 Shell 手动启动 `grok` 两条路径中，设置为 `Alt + Enter` 时均可换行且不提交。
- [x] `Shift + Enter`、`Ctrl + Enter` 在 Grok 中同样发送 `ESC + CR`；未选中的原生 `Alt + Enter` 仍可由 Grok/Codex 接收；单按 Enter 仍按原有规则提交。
- [x] `echo grok`、`grok-helper`、退出 Grok 后的普通 Shell 不会被误判为 Grok。
- [x] 分屏、切换会话、重新挂载、WSL/SSH/Worktree 不改变当前会话隔离和 PTY 写入契约。
- [x] `node --test scripts/terminalNewlineShortcut.test.mjs` 与 `npx tsc --noEmit` 通过；回归测试覆盖运行时命令识别、TUI 提示门控和 `ESC + CR` 路由接线。
- [x] `CHANGELOG.md` 和 `docs/功能清单.md` 在 `V1.3.9` 对本次跟进修复有准确记录；无新增界面文案，因此中英文设置无需新增翻译键。

## Verification Note

- 未启动桌面 GUI 或 PTY 服务做手工 smoke test；需在 V1.3.9 构建中手动启动普通 Shell，输入 `grok` 后分别验证三种设置及退出回 Shell 后的行为。

## Open Questions

无。实现边界已确定：采用命令提交证据 + 当前 viewport TUI 输入提示的组件级运行时识别，不引入进程查询 IPC。
