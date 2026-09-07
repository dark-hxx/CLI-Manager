# 修复 SSH MFA 输入循环

## Goal

修复 Issue #195：使用“用户名 / 密码”保存凭据连接需要 keyboard-interactive/MFA 的 SSH 主机时，保留登录密码自动填写，同时让 MFA 等后续挑战在当前真实 PTY 中由用户输入，不再循环提示。

## Changelog Target

- `[TEMP]`

## Background

- Issue #195 复现于 CLI-Manager `1.3.4`、macOS、内置终端。
- 用户看到 `Please Enter MFA Code.` 持续重复，键盘输入无法完成认证。
- 既有 SSH 设计契约要求：保存密码通过一次性 AskPass 注入；未知提示不得自动回答；Keyboard-interactive/MFA 必须保留真实 PTY 人工输入。

## Root Cause

`credential_ref` 在 AskPass 边界设置 `SSH_ASKPASS_REQUIRE=force`，导致 OpenSSH 10.1p1 的 password 与 keyboard-interactive 挑战全部进入 AskPass helper；helper 仅识别 `password/passphrase`，遇到 MFA 提示直接失败，因此 OpenSSH 重试挑战，而用户写入 PTY 的输入没有任何读取者。

## Confirmed Facts

- `src-tauri/src/ssh_askpass.rs:11-42`：AskPass helper 对非 `password/passphrase` 提示直接退出。
- `src-tauri/src/ssh_askpass.rs:53-99`：保存密码通过一次性 loopback broker 提供，并设置 `SSH_ASKPASS_REQUIRE=force`。
- `src-tauri/src/ssh_transport.rs:145-160`：交互 SSH 使用 `ssh -tt`，本地 OpenSSH 运行在真实 PTY 中。
- `src-tauri/src/ssh_transport.rs:246-270`：`credential_ref` 同时允许 `password` 与 `keyboard-interactive`。
- `src/hooks/useTerminalInput.ts:744-824`、`src-tauri/src/daemon/server.rs:1865-1877`、`src-tauri/src/pty/manager.rs:900-927`：xterm 输入到 PTY writer 的链路完整，症状层没有丢弃 MFA 输入。
- OpenSSH 10.1p1 `readpass.c`：`SSH_ASKPASS_REQUIRE=force` 强制所有 `read_passphrase` 调用使用 AskPass。
- OpenSSH 10.1p1 `sshconnect2.c:1940-1990`：keyboard-interactive 的每个 challenge 也通过 `read_passphrase` 获取响应。
- `.trellis/tasks/07-16-ssh-remote-project-terminal/implement.md:172-182`：原设计要求未知提示拒绝自动回答、MFA 保持人工输入。
- `.trellis/spec/backend/ssh-remote-terminal-contracts.md:109-150`：保存凭据、AskPass、交互终端和后台 one-shot 行为已有明确契约。

## Requirements

- R1：`password/passphrase` 提示优先从一次性 broker 获取保存密码。
- R2：MFA、OTP、验证码、PIN 或其他 keyboard-interactive 提示必须转交当前 SSH 控制终端读取。
- R3：保存密码 broker 已失效、已消费或不可连接时，交互 SSH 终端应降级为人工密码输入，不得进入无输入者的重试循环。
- R4：人工输入不得写入日志、SQLite、Store、WebDAV、会话快照或普通环境变量。
- R5：后台 one-shot SSH 没有控制终端时仍应快速失败并返回既有交互认证错误，不得弹出新 UI 或无限等待。
- R6：Windows、macOS、Linux 使用同一提示路由契约；不新增第三方依赖。
- R7：不修改 xterm 输入转发、PTY daemon 协议、SSH 参数优先级或认证方式 UI。
- R8：用户没有可用于人工验收的 MFA SSH 主机，交付必须包含不依赖真实服务器的自动化回归测试，模拟 OpenSSH AskPass 的保存密码、MFA、broker 失效和无控制终端路径。
- R9：交互式 SSH PTY 显式设置 `CLI_MANAGER_SSH_ASKPASS_TTY_FALLBACK=1`；后台 one-shot 显式设置 `0`，覆盖父进程可能遗留的 `1`，且 helper 只接受精确值 `1`。
- R10：broker token 必须有界读取，错误/超长 token 不得消耗 broker；服务端控制的 AskPass prompt 在写入本地终端前必须过滤控制字符、规范化换行并限制显示长度。
- R11：SSH launch 生成的 AskPass 内部环境变量必须优先于项目/会话环境，Windows 大小写变体也不能覆盖内部值。

## Scenario Matrix

| 维度 | 场景 | 期望 |
|---|---|---|
| 窗口焦点 | 当前窗口 / 其他窗口 / 未聚焦 | 挑战在所属 PTY 阻塞等待；聚焦对应终端后可输入，不自动重试 |
| 分屏 | 当前 Pane / 其他 Pane / 深层分屏 | 仅激活所属 Pane 后输入，sessionId 与 PTY 不串线 |
| 最小化/托盘 | 正常 / 最小化 / 托盘 | 认证保持等待；恢复窗口后继续输入 |
| 多会话/Workspan | 单会话 / 多 SSH 会话 / 跨 Workspan | 每个 AskPass helper 只读取自己的控制终端 |
| Focus Mode | 开 / 关 | 不改变认证提示路由 |
| 运行平台 | Windows / macOS / Linux / WSL | 有控制终端则人工输入；无控制终端则保持既有失败语义 |
| Worktree | 主仓库 / Worktree | SSH Worktree 仍按既有能力矩阵处理，与本修复无关 |
| CLI Hook | 已安装 / 未安装 | 与认证输入无关，确认不修改 |
| 认证方式 | credential_ref / password_prompt / interactive / agent / identity_file / ssh_config | 仅 credential_ref 的混合自动密码 + 人工后续挑战路径变化；其他模式不回归 |

## Discovery List

- `src-tauri/src/ssh_askpass.rs`：根因位置；计划修改提示分流和控制终端读取，并增加单元测试。
- `src-tauri/src/ssh_transport.rs`：交互 launch 显式开启 AskPass 控制终端降级；one-shot 保持关闭。
- `src-tauri/src/ssh_launch.rs`：确认交互 SSH 进入 PTY；预计不修改。
- `src-tauri/src/pty/platform/unix.rs`、`src-tauri/src/pty/platform/windows.rs`：确认 SSH 子进程具备控制终端；预计不修改。
- `src-tauri/src/pty/manager.rs`：修改 SSH 本地启动环境合并，保护 AskPass 内部键不被项目/会话环境覆盖。
- `src-tauri/src/daemon/server.rs`：确认复用 `PtyManager::create_with_launch`，无需修改。
- `src/hooks/useTerminalInput.ts`、`src/lib/terminalIme.ts`：确认前端输入没有被连接状态或 IME 路径阻断；预计不修改。
- `src-tauri/src/main.rs`、`src-tauri/src/bin/cli-manager-daemon.rs`、`src-tauri/src/bin/cli-manager-codex-proxy.rs`：AskPass helper 入口调用方；签名不变，确认无需修改。
- `.trellis/spec/backend/ssh-remote-terminal-contracts.md`：补充 AskPass 未知/多轮提示必须转交控制终端的可执行契约。
- `CHANGELOG.md`：在 `[TEMP]` 目标下记录 Issue #195 修复。

## Impact Assessment

- GitNexus 已刷新到当前提交，但本机 LadybugDB FTS 扩展不可用，Rust 函数节点名称为空；精确 `impact` 返回 `UNKNOWN`，无法生成可靠符号级风险。
- 已按分诊指南降级到 SSH 契约文档 + 精确搜索确认调用方。
- 人工评估：代码触点小，但属于认证和秘密输入边界，风险等级为中等；主要风险是终端回显未恢复、后台 one-shot 意外阻塞、不同会话读取串线。
- 二次审查确认三个加固点：后台 one-shot 继承父环境、用户环境覆盖内部 AskPass 键、broker/prompt 输入未完全有界。修复继续落在 SSH launch、AskPass 和 PTY 环境边界，不扩散到前端。

## Acceptance Criteria

- [x] AC1：保存凭据连接普通密码主机时，密码仍由 broker 自动提供。
- [x] AC2：保存凭据连接“密码 + MFA”主机时，MFA 提示只出现正常认证轮次，用户可在当前终端输入并继续登录。
- [x] AC3：broker 不可用或保存密码错误后，交互终端允许人工重新输入密码。
- [x] AC4：后台测试、目录浏览和 Agent one-shot 遇到 MFA 时保持既有 `authenticationRequired`/稳定错误，不等待终端输入。
- [x] AC5：人工输入默认关闭回显，并在成功、EOF、错误路径都恢复终端模式。
- [x] AC6：不同 SSH 会话、分屏和 Workspan 之间不串输入（每个 helper 只打开所属进程控制终端）。
- [x] AC7：密码/MFA 内容不进入日志、持久化、同步或错误文本。
- [x] AC8：AskPass 提示分类、broker 优先级、broker 失败降级、MFA 跳过 broker 均有 Rust 单元测试。
- [x] AC9：SSH 相关定向 Rust 测试与 `cargo check` 通过。
- [x] AC10：自动化回归能够证明保存密码只用于密码提示，MFA 必须读取交互输入，且 broker 失败后不会形成无输入者循环。
- [x] AC11：后台 one-shot 显式设置 TTY fallback 为 `0` 时，MFA 和 broker 失败路径均不调用控制终端读取并快速失败。
- [x] AC12：父进程遗留 `CLI_MANAGER_SSH_ASKPASS_TTY_FALLBACK=1` 时，one-shot launch 的显式 `0` 仍保持非交互。
- [x] AC13：项目/会话环境无法通过大小写变体覆盖 SSH 内部 AskPass helper、broker token 或 TTY 策略。
- [x] AC14：错误/超长 broker token 被拒绝且不消耗正确客户端的机会；ANSI/OSC/控制字符 prompt 不会在本地终端执行，显示长度受限。

## Out of Scope

- 自研 SSH 协议栈或替换系统 OpenSSH。
- 新增应用内 MFA 弹窗。
- 消除服务器的 post-quantum key exchange 警告。
- 让后台目录浏览、探测或 Hook 安装支持人工 MFA。

## Decision

- 已确认保留“保存密码自动填写，MFA/后续挑战在终端人工输入”的混合模式。
- 验收以自动化回归为主，不依赖用户提供真实 MFA 主机。
