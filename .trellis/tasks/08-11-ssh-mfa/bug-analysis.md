# Bug Analysis: Windows ConPTY 中 SSH MFA 输入后连接关闭

## 1. Root Cause Category

- **Category**：E - Implicit Assumption，B - Cross-Layer Contract，D - Test Coverage Gap
- **Specific Cause**：上一修复假设 Windows AskPass helper 可以通过重新打开 `CONIN$`/`CONOUT$` 取得当前 SSH 终端，但 OpenSSH 启动 helper 时已经继承了所属 SSH/ConPTY 的标准输入与错误输出；重新绑定全局控制台句柄可能使 OTP 响应脱离当前认证会话，OpenSSH 收到无效响应后服务器关闭连接。

## 2. Why the Previous Fix Was Incomplete

1. 上一修复正确解决了“未知 MFA prompt 无读取者”的循环，但只测试了抽象的 terminal reader，没有验证 Windows ConPTY 下 helper 进程级句柄归属。
2. `CONIN$`/`CONOUT$` 在普通控制台中看似等价于标准句柄，但 ConPTY 的输入输出属于创建该伪终端的特定 pipe 会话，不能把全局控制台路径当作当前 PTY 的别名。
3. 反馈截图显示 MFA prompt 后立即断开且没有远程 Shell prompt，说明故障仍在认证响应边界，而不是远端启动命令或 Shell 初始化。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Cross-platform contract | Windows AskPass 复用继承 stdin/stderr；Unix 复用 `/dev/tty`；不得未经证明重新打开全局控制台设备 | DONE |
| P0 | Test coverage | 保留提示分流、stdout/stderr 分离、输入长度和终端恢复测试；Windows 至少执行目标平台编译检查 | DONE |
| P1 | Integration validation | 发布前用真实 Windows ConPTY + MFA 主机验证“输入 OTP 后远程 Shell 保持打开” | TODO（缺少用户测试主机） |
| P1 | Process observability | 若再次失败，补充不泄露凭据的 AskPass/SSH exit reason 诊断，区分 helper 非零退出与服务器拒绝 | TODO |

## 4. Systematic Expansion

- **Similar Issues**：所有需要 helper 与 PTY 交互的 Windows 认证、确认和密码恢复路径都必须检查标准句柄归属；不能只验证普通控制台。
- **Design Improvement**：把“提示输出句柄、人工输入句柄、OpenSSH 响应 stdout”作为显式的 AskPass 三路契约，禁止使用同一输出流混写。
- **Test Gap**：当前自动化测试无法模拟真实 ConPTY 和远端 MFA challenge，必须把真实 Windows PTY 冒烟列入发布验证矩阵。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/backend/ssh-remote-terminal-contracts.md`。
- [x] 更新 `CHANGELOG.md` 与 `docs/功能清单.md`。
- [x] 保留 Issue #195 的根因与验证边界。
- [ ] 真实 MFA 主机平台验收。
