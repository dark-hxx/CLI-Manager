# Bug Analysis: SSH AskPass MFA 输入循环

## 1. Root Cause Category

- **Category**: E - Implicit Assumption（主因），B - Cross-Layer Contract、D - Test Coverage Gap（放大因素）
- **Specific Cause**: 实现假设 `SSH_ASKPASS_REQUIRE=force` 只影响普通密码提示，但 OpenSSH 10.1p1 的 keyboard-interactive 每轮 challenge 同样经过 AskPass。helper 对未知提示直接退出，真实 PTY 输入链路因此没有读取者，OpenSSH 继续重试挑战。

## 2. Why Fixes Failed

1. 原实现只验证一次性 broker 能返回保存密码，没有模拟 MFA/OTP、多轮挑战和 broker 已消费路径。
2. 如果只修前端 xterm 输入或 PTY writer，会停留在症状层；输入链路本来完整，真正缺失的是 AskPass 到所属控制终端的读取路径。
3. 初版提示分类若只检查 `password`，会把 `One-time password` 错当普通密码；代码审查后补充了 OTP/MFA 优先排除和回归用例。
4. 二次审查发现“未设置”不等于“明确关闭”：子进程会继承父环境，后台 one-shot 必须显式写 `0`。
5. PTY 环境合并原先让用户环境后写入，Windows 又大小写不敏感，可能覆盖 AskPass 内部凭据通道变量。
6. loopback broker 的 token 使用无界 `read_line`，且错误连接会直接消耗 broker；服务端 prompt 原样写终端，分别存在本地内存/拒绝服务和终端控制序列注入边界缺口。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | 交互 SSH launch 显式设置 `CLI_MANAGER_SSH_ASKPASS_TTY_FALLBACK=1`；one-shot 显式设置 `0`，不根据继承状态猜测可否阻塞 | DONE |
| P0 | Secret Boundary | SSH launch 内部环境键覆盖用户环境的所有大小写变体 | DONE |
| P0 | Input Boundary | broker token 有界读取且错误连接不消费；终端 prompt 过滤控制字符并限制长度 | DONE |
| P0 | Test Coverage | 注入伪 broker/TTY，覆盖普通密码、MFA、OTP、broker 消费、无 TTY、输出分流、限长与恢复守卫 | DONE |
| P0 | Documentation | 在 SSH 远程终端契约中固化提示路由、内部环境键、错误矩阵和 Wrong/Correct | DONE |
| P1 | Cross-platform | Windows 编译检查通过；发布前在 macOS/Linux PTY 做真实控制终端冒烟 | TODO（发布验证） |
| P1 | Signal Recovery | RAII 覆盖成功、EOF、普通错误和 panic；强制进程终止可能绕过 `Drop`。本次不引入全局 signal handler，避免扩大多平台进程风险；发布冒烟需覆盖认证中断后的回显状态 | TODO（发布验证） |

## 4. Systematic Expansion

- **Similar Issues**: 所有设置 `SSH_ASKPASS_REQUIRE=force` 的后台 probe、目录查询、Agent bridge 都可能收到多轮 challenge，必须显式保持 TTY fallback 为 `0`；所有本地 broker/终端输出都应有输入长度与控制字符边界。
- **Design Improvement**: launch mode 决定是否允许阻塞式人工输入；prompt classifier 只决定保存凭据是否可用。两者不能混成“有 TTY 就读取”的隐式判断。
- **Process Improvement**: SSH 认证变更的测试矩阵必须包含普通密码、keyboard-interactive 首轮密码、MFA/OTP 后续轮、错误密码重试和无交互 one-shot。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/backend/ssh-remote-terminal-contracts.md`。
- [x] 更新 `CHANGELOG.md` 与 `docs/功能清单.md` 的 `[TEMP]`。
- [x] 记录 Issue #195 自动化回归结果。
- [x] 检查模板同步路径；仓库不存在 `src/templates/markdown/spec/`，无需同步。
