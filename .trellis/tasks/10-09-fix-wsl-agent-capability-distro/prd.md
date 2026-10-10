# 修复 WSL Agent 能力诊断缺少发行版参数

## Goal

修复 WSL 终端实时统计面板的 Agent 能力诊断 `agent_capability_wsl_distro_required` 错误，确保诊断使用当前会话的真实发行版。

## Requirements

- 追踪终端启动、Hook 上报、会话状态、诊断请求与后端验证之间的发行版身份传递。
- 保持精确会话绑定，不猜测默认发行版、不把 WSL 请求降级到宿主机。
- 覆盖 Windows 路径项目、WSL UNC 项目、worktree、多会话切换与旧 Hook 兼容场景。
- 按用户指定 V1.4.3 更新 CHANGELOG.md 与 docs/功能清单.md。

## Acceptance Criteria

- [x] 可识别发行版的 WSL 会话诊断携带正确发行版与 Linux cwd（生产者与路径测试通过；真实 WSL 待人工验证）。
- [x] 不可识别的身份仍由既有后端拒绝，不增加默认环境兜底。
- [x] 回归测试覆盖确认的根因及相邻场景；本地/SSH 路由保持有效。
- [x] 定向测试、类型/编译检查与严格架构检查通过。

## Scope

补齐 WSL 启动与原生 Hook 的发行版来源，并让精确绑定会话的历史文件来源参与诊断身份解析；不调整能力扫描策略、UI、IPC schema 或其他环境的会话绑定。真实 WSL/桌面验证需要安装 WSL 的机器。

## 客户日志续查验收

- [x] 旧 Hook 未上报发行版时，已绑定的同来源、同 CLI session ID 的 WSL 历史文件可补全诊断发行版。
- [x] 不接受其他 Agent、其他会话或未绑定历史；已有 Hook/终端/项目身份优先级保持不变。
- [x] 覆盖扩展 UNC、Ubuntu/Debian、Worktree、缺少历史及本机/SSH 场景；请求使用 Linux cwd。
- [x] 已有开发版 Hook 回调隔离与新建 WSL producer 修复一并回归。
