# 技术设计：复用 AskPass 继承的 Windows ConPTY 句柄

## 根因陈述

问题位于 Windows AskPass 与 ConPTY 的输入边界：helper 已由 OpenSSH 继承当前 SSH 进程的伪终端标准输入/错误输出，但旧实现重新打开 `CONIN$`/`CONOUT$`，可能脱离所属 ConPTY 的会话句柄，导致 OTP 响应未被 OpenSSH 正确接收，服务器关闭认证连接。

## 目标数据流

```text
CLI xterm -> daemon/PTy writer -> ConPTY input
                               -> ssh stdin
                               -> AskPass helper inherited stdin
AskPass prompt -> inherited stderr -> ConPTY output -> CLI xterm
AskPass response -> inherited stdout pipe -> OpenSSH -> keyboard-interactive response
```

## 实现边界

- 只修改 `src-tauri/src/ssh_askpass.rs` 的 Windows `read_control_terminal` 实现及必要的测试辅助函数。
- Windows 输入使用 `std::io::stdin()` 的继承句柄读取；输出使用 `std::io::stderr()`，避免污染 OpenSSH 通过 stdout pipe 读取的答案。
- 使用继承 stdin 的 raw handle 调用 `GetConsoleMode`/`SetConsoleMode`，仅关闭 `ENABLE_ECHO_INPUT`，读取结束、EOF、错误时恢复原模式。
- 保留现有 prompt 清洗、响应长度限制、broker 分流和显式 TTY fallback 策略。
- Unix 与非 Windows 路径不变；不新增依赖，不修改 PTY daemon、前端输入转发和 SSH 参数。

## 兼容性与风险

- 普通密码 broker 自动填写行为不变。
- MFA/OTP 仅改变 Windows helper 的终端句柄来源；macOS/Linux 继续使用 `/dev/tty`。
- 若 Windows helper 没有有效控制台 stdin，读取会返回既有错误并让 AskPass 非零退出，不会进入无限重试或阻塞后台 one-shot。
- 最高风险是 stdout/stderr 选错导致 OpenSSH 收到污染答案；实现必须保持“提示走 stderr、答案走 stdout”。

## 发现清单

- `src-tauri/src/ssh_askpass.rs::read_control_terminal`：根因与唯一实现触点，修改 Windows 分支。
- `src-tauri/src/ssh_askpass.rs::answer_prompt_with`：已确认提示分流和 stdout 协议正确，不修改。
- `src-tauri/src/ssh_transport.rs::build_interactive_launch/build_one_shot_launch`：已确认 `-tt` 与 fallback=1/0 策略正确，不修改。
- `src-tauri/src/pty/platform/windows.rs::spawn`：已确认 ConPTY 通过子进程标准句柄提供输入输出，不修改。
- `src-tauri/src/pty/manager.rs`、`src-tauri/src/daemon/server.rs`、`src/hooks/useTerminalInput.ts`：输入链路已确认完整，与本次句柄修复无关。
- `.trellis/spec/backend/ssh-remote-terminal-contracts.md`：补充 Windows AskPass 必须复用继承句柄的契约。
- `CHANGELOG.md`：在 `V1.3.6` 记录 Issue #195 后续修复。

## 回滚

无数据迁移。回滚 `ssh_askpass.rs`、契约文档和变更日志即可。
