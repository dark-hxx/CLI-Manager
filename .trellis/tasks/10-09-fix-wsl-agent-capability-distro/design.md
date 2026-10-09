# Design

## Root cause

WSL → Windows interop 丢失 guest 发行版身份：`settings::hook_exe_for_dir` 将 Hook 指向 `/mnt/.../cli-manager.exe`，但 `PtyManager::apply_wsl_env_forwarding` 只转发宿主提供的变量，未声明 `WSL_DISTRO_NAME/w`。`hook_client::try_notify` 读取到空值，Windows 盘符项目又无法通过 UNC 推断，最终诊断入口拒绝缺失发行版的请求。之前 c573a657 修复了消费端，但未验证跨进程来源。

## Discovery list

- [x] `src-tauri/src/infrastructure/pty/manager.rs:317`：在既有 WSL 启动环境合并器添加 guest → Windows 单向 `WSL_DISTRO_NAME/w`，去重并规范该受管字段的旧方向/路径标志；保留其他 WSLENV 项。
- [x] `src-tauri/src/features/hooks/settings/mod.rs:1945`：确认 WSL Hook 调 Windows exe；命令格式/所有权无需改动。
- [x] `src-tauri/src/features/hooks/client.rs:116`：已有发行版读取与序列化，无需改动。
- [x] `src-tauri/src/features/hooks/settings/pi.rs:57`：Pi 原生 HTTP producer 遗漏字段，补取自身运行环境。
- [x] `src-tauri/resources/opencode/cli-manager-hook.js`：OpenCode 原生 HTTP producer 同样补字段。
- [x] `src-tauri/src/features/hooks/claude.rs`：请求/事件已有字段，无需变更协议。
- [x] `src/features/terminal/store/terminalRuntime.ts:599`：带 sessionId 的生命周期事件已有发行版存储；本修复保持精确 Tab 绑定。
- [x] `src/features/agents/api/agentCapabilities.ts:132` 与 `useAgentCapabilities.ts:80`：已有路径转换、会话发行版和缓存 scope，无需改动。
- [x] `src-tauri/src/features/agents/commands.rs:755`：缺失身份拒绝是正确边界，保留。
- [x] SSH/本机启动、持久化 schema、UI 文案：确认无需改动。

## Contracts and scenarios

- 不写入宿主猜测的发行版、不选系统默认发行版；身份由当前 WSL 自身产生。
- WSLENV 中只规范 `WSL_DISTRO_NAME`；不改 callback、COLORTERM、DSH 或用户其他项。
- Claude/Codex/Grok（及共享 Hook 的 Kimi）经 Windows exe；Pi/OpenCode 在 guest 内直接上报。
- Windows 盘符、UNC、guest cwd、OSC 主机前缀、Worktree 复用原有路径归一化。
- 多发行版分别继承各自 WSL_DISTRO_NAME；多会话、分屏、Workspan、前后台/托盘不改变 producer 身份或 Tab 绑定。
- hook 未安装时仍保持未绑定；旧已运行 PTY/daemon 进程需更新后完全重启并新建终端。Pi/OpenCode 已安装扩展需重新安装/加载新源码。
- 不增加依赖、IPC 字段或迁移；回滚代码即可，扩展通过既有所有权安装流程替换。

## 2026-10-09 客户日志续查

- 客户 cli-manager.log 第 2199 行（11:11:14）：Codex 查询的 CLI session ID 与返回详情 ID 相同，文件在 Ubuntu 的扩展 WSL UNC 路径，cwd 已为 /mnt/e/...。
- 第 2248/2255 行（11:14:14、11:20:33）是项目扩展启动的环境不可识别告警；它发生在启动前，不能用来证明运行后的 Hook 串流。10:45–11:30 没有 Hook 收包或能力诊断请求日志。
- 续查根因：useAgentCapabilities 只把绑定历史用于 MCP 证据，发行版解析遗漏了同一详情的 file_path。Windows 盘符项目配合旧 Hook 时，已知的会话来源在请求组装边界被丢弃。
- 保留 producer 修复；在既有 resolveWslCapabilityLocation 中增加精确历史文件路径输入，仅在既有 Hook/终端/项目/config-root 身份均缺失时取其 UNC 发行版。历史文件不是 cwd，不从文件目录构造扫描目标。
- useAgentCapabilities 统一按非空 cliSessionId 与 Agent source 筛选 boundSession，并将同一筛选结果用于历史路径和 MCP 证据；未绑定、旧页签残留、不同 Agent 均不借用。
- WSL 身份变化继续进入现有 scopeKey；本机/SSH 不进入 WSL 解析。Worktree 保留调用方 projectPath 作为 cwd；窗口焦点、分屏、托盘和 Workspan 不参与身份选择。
- 已有 d1c0689e 修复当前实例 callback 注入及 Codex --no-daemon；共享 Hook exe 路径不等于接收实例。本次只回归相关行为，不重写客户 Hook 配置或更改发送策略。

### 新增触点清单

- src/features/agents/api/agentCapabilities.ts：增加精确历史 UNC 来源解析，复用 parseWslPath。
- src/features/agents/api/useAgentCapabilities.ts：统一精确绑定筛选并把来源接入 inspect/probe 请求。
- scripts/agentCapabilities.test.mjs：执行真实解析器和 React Hook 的请求构造；覆盖来源/会话隔离与平台分支。
- TerminalStatsPanel、historyRequests、wslPaths：已核对传入详情和扩展 UNC 支持，无需改动。
- terminalLaunch、Hook client、后端诊断验证：已核对已有隔离与拒绝缺失身份契约，无需改动。
- GitNexus impact 两个目标均 UNKNOWN/not found；FTS repair 因本机缺少 LadybugDB FTS 扩展失败。用精确引用确认解析器 → Hook → TerminalStatsPanel 唯一生产调用链。

## Validation limits

本机 `wsl.exe --list --quiet` 表明 WSL 未安装。以 Rust 变量合并回归、执行生成的 JS/TS producer 并捕获 HTTP payload、现有路径/绑定回归覆盖自动验证；真实 interop/桌面检查由 WSL 环境人工执行。
