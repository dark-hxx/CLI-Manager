# 修复 SSH MFA 输入后连接被关闭

## Goal

修复 Issue #195 的后续回归：在 Windows 内置 ConPTY 终端中，保存用户名/密码连接需要 Keyboard-interactive/MFA 的 SSH 主机时，用户输入 MFA Code 后 SSH 会话被关闭；输入应完成认证并保持远程终端可交互。

## Changelog Target

- `V1.3.6`

## Background

- 上一任务 `08-07-fix-ssh-mfa-input-loop` 已将 MFA/OTP 等非普通密码提示从保存密码 broker 转移到当前 SSH 控制终端读取，并显式区分交互 PTY 与后台 one-shot。
- 当前代码的 Windows AskPass 路径通过 `CONIN$`/`CONOUT$` 读取和显示 MFA 提示；CLI-Manager 的 Windows 终端由 ConPTY 的输入/输出 pipe 驱动，子进程标准句柄由伪终端接管。
- 现象是用户已能输入 MFA Code，但输入后连接关闭；这是 SSH AskPass、Windows ConPTY 控制终端和认证后远程 Shell 生命周期之间的跨边界行为问题，必须定位根因后修复。
- 上一任务的历史记忆 CLI 因本机 Trellis 安装缺少 `figlet` 依赖不可用；已改用归档任务、提交 `a46051a7`、当前源码与 GitHub issue 原文复核。

## Confirmed Facts

- `src-tauri/src/ssh_askpass.rs`：MFA 提示跳过 broker，在 Windows `read_control_terminal` 中关闭 `ENABLE_ECHO_INPUT`，从 `CONIN$` 读取一行，再把响应写入 AskPass stdout。
- `src-tauri/src/ssh_transport.rs`：交互式 `credential_ref` 使用 `-tt` 并设置 `CLI_MANAGER_SSH_ASKPASS_TTY_FALLBACK=1`；后台 one-shot 使用 `-T` 并设置 `0`。
- `src-tauri/src/pty/platform/windows.rs`：CLI-Manager 使用 `CreatePseudoConsole`，子进程标准输入/输出句柄为 `INVALID_HANDLE_VALUE`，输入输出由 ConPTY pipe 提供。
- 上一任务的自动化测试覆盖了提示分流和抽象输入函数，但没有覆盖 Windows ConPTY 中真实 `CONIN$`/`CONOUT$` 与 AskPass helper 的进程级行为，也没有覆盖 MFA 认证完成后的远程 Shell 保活。
- GitNexus 当前索引缺少 LadybugDB FTS 扩展，`analyze --repair-fts` 无法修复；后续影响分析需记录为 `UNKNOWN` 并结合精确源码搜索与契约核对。
- 用户补充截图显示：`Please Enter MFA Code.` 后出现 `(user@host) [OTP Code]:`，随后直接显示 `Connection to host closed.`，没有出现远程 Shell 提示符；因此可排除“认证成功后 Shell 初始化失败”作为首要方向。

## Root-Cause Hypothesis

最可能的根因是：AskPass helper 已由 OpenSSH 继承了所属 SSH 进程的 ConPTY 标准输入/错误输出，但 Windows 实现又打开进程外部的 `CONIN$`/`CONOUT$`；在 ConPTY 下这不保证与当前 SSH 会话的输入队列一致，导致 OTP 响应没有按预期交给 OpenSSH，服务器随即关闭认证连接。修复应复用 helper 自身继承的 stdin/stderr，并保留终端模式恢复；不能在前端连接关闭提示处重连或吞错。

## Requirements

- R1：保存密码仍只自动填写普通 `password`/`passphrase` 提示，MFA/OTP/verification/PIN 等后续 challenge 由当前 SSH 交互终端输入。
- R2：输入 MFA Code 后认证成功时，SSH 会话继续保持远程 Shell 交互，不被 AskPass helper、ConPTY 或终端状态恢复逻辑提前关闭。
- R3：Windows ConPTY、macOS/Linux PTY 的既有认证路径不回归；后台 one-shot 继续禁止人工输入并快速失败。
- R4：MFA 输入不进入日志、环境变量、持久化或错误消息；终端回显/模式在成功、EOF、错误路径均恢复。
- R5：新增不依赖真实 MFA 主机的自动化回归，至少覆盖 MFA 响应交付、helper 生命周期、认证完成后会话保活相关的可测试边界。
- R6：不新增依赖，不修改前端 xterm 输入转发，除非证据证明输入确实在该层丢失。
- R7：Windows AskPass 人工输入必须读取 OpenSSH helper 继承的当前 ConPTY stdin，并将提示写入继承的 stderr；不得依赖全局 `CONIN$`/`CONOUT$` 重新绑定会话。

## Acceptance Criteria

- [ ] AC1：真实 Windows ConPTY + MFA 主机验收；当前无可用目标主机，需发布前人工验证。
- [x] AC2：普通保存密码 SSH 主机仍可自动登录；MFA challenge 不会再次收到保存的登录密码（既有 13 项 AskPass 测试通过）。
- [x] AC3：后台连接测试、目录浏览和 Agent one-shot 遇到 MFA 时不读取交互终端、不无限等待（既有 11 项 SSH transport 测试通过）。
- [x] AC4：MFA 输入成功、认证失败、EOF、helper 异常和终端关闭路径均不会留下明文回显或错误终端模式（既有恢复、边界和输出分离测试通过）。
- [x] AC5：定向 Rust 测试、`cargo check`、`cargo fmt --check` 与 `npx tsc --noEmit` 通过；真实 MFA 主机验证边界已记录。
- [x] AC6：`CHANGELOG.md` 在 `V1.3.6` 下记录本次行为修复，并关联 Issue #195。
- [x] AC7：Windows 实现不再通过 `CONIN$`/`CONOUT$` 获取 MFA 输入输出；终端模式修改和恢复作用于 AskPass 继承的 stdin。

## Notes

- Issue 原文已通过 GitHub API 读取，原始复现平台为 macOS；本次用户反馈的复现环境按当前工作区为 Windows 11 内置终端处理。
- 复杂任务在 `task.py start` 前补齐 `design.md` 与 `implement.md`。
