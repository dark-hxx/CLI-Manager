# 技术设计

## 边界

修复限定在前端终端类型识别。快捷键配置仍是唯一开关，PTY 写入契约不变。

会话精确恢复覆盖两个身份入口：历史继续对话创建 Tab 时直接绑定所选 ID，以及 Hook 绑定后对账工作区快照。恢复命令格式、`sessionStore` 数据结构和 PTY 恢复链路不变。

## 数据流

1. `XTermTerminal` 收到受管 Enter 组合键。
2. 读取当前 `terminalNewlineShortcut` 并做严格组合键匹配。
3. 统一判断当前是否为 Codex：
   - 会话固化 `cliTool`；
   - 当前项目 `cli_tool`；
   - Tab 标题；
   - 启动命令；
   - 当前 xterm viewport 的 Codex TUI 可见签名。
4. Codex 写入 `ESC + CR`，其他终端保持写入 `LF`。

会话恢复数据流有两条入口：历史继续对话的 `session.session_id` → `createSession(..., cliSessionId)`；或运行中 `Hook payload.sessionId` → 更新 `TerminalSession.cliSessionId` → 与 `sessionStore.sessions` 对账。二者随后都进入完整快照保存 → 启动读取快照 → `buildCliResumeStartupCommand` 使用各 Tab 的明确 ID。

## 关键取舍

- 不把 Codex 状态永久写回 Store：手动 Codex 退出后容易遗留错误状态。
- 不新增前台进程探测 IPC：Windows/WSL/SSH 的进程边界复杂，超出本修复需要。
- 对手动启动场景在 xterm normal/alternate buffer 中使用当前 viewport 只读识别：Codex 是否使用 alternate buffer 受 CLI 版本、参数和用户配置影响，不能作为识别前提。
- 复用已有 TUI 签名，不复制正则。
- 复用现有 SSH 会话快照串行队列，避免新增并发写入机制；本地会话只在持久化快照的 `cliSessionId` 与 Hook ID 不一致时进入该队列。
- 保留无 ID 时的 `--last` 兜底，只修复上游 ID 丢失。
- 历史继续对话直接复用已经校验并用于 resume 命令的 `session.session_id`，不新增第二套身份推断。

## 兼容性

- 普通 Shell、Claude 继续使用 `LF`。
- `Shift+Enter`、`Ctrl+Enter`、`Alt+Enter` 的配置匹配规则不变。
- 无数据迁移、无依赖变更、无后端变更。
- SSH 原有 Hook 身份持久化条件保持兼容。

## 风险与回滚

- 风险：Codex TUI 文案变化导致实时签名失效；项目直启仍由固化元数据覆盖。
- 风险：normal buffer 退出 Codex 后若 TUI 签名仍留在当前 viewport，短时间内仍可能按 Codex 处理；Shell 运行监控默认关闭，无法用其作为必备退出信号。离屏后不会继续命中。
- 回滚点：撤销 `terminalTuiDisplay` 的只读识别导出与 `XTermTerminal` 的识别扩展即可。
