# 技术设计

## 方案

在 `src/features/terminal/browser/` 增加 Pi 输出过滤器，由现有 `TerminalPiCompatibility` 在 Pi 上下文激活时调用。过滤器只识别 `pi-mcp-adapter` 的完整直连工具 advisory：数量为数字，正文和结尾句式必须全部匹配；匹配成功后丢弃该 advisory，其他字节原样返回。

过滤器保留一个有上限的 `MCP:` 候选残尾。每次转换先把残尾与新帧拼接，删除其中已经完整的 advisory，再把末尾可能跨帧的候选继续暂存。候选超过上限或不再符合候选形状时立即按普通输出释放，避免无界缓存和普通终端输出长时间等待。`reset()` 清理候选残尾。

## 输出链路

```text
PTY bytes
  -> useTerminalDisplay 解码 / OSC 规范化
  -> TerminalPiCompatibility.onFrame
  -> TerminalPiCompatibility.transformOutput
       -> Pi advisory filter（仅 Pi）
       -> 现有 Pi ANSI 兼容转换
  -> xterm.write
```

`transformOutput` 已被实时写入、回放和恢复路径共同使用，因此过滤器放在该兼容层可以覆盖三种来源，并保持 PTY 管理器的 ACK、帧顺序和 stdout/stderr 传输契约不变。

## 匹配边界

- 支持 `MCP: <number> direct tools resolved.` 开头和固定 advisory 正文、`75+ direct tools would be registered.` 结尾。
- 允许 PTY 常见的 `\r\n` 行尾；不依赖一次收到完整帧。
- 不使用宽泛的 `MCP:` 或 `console.warn` 过滤，避免误删 MCP 连接状态、错误信息和用户命令输出。
- 只由 Pi 上下文启用；普通 Shell 和其他 CLI 直接返回原字符串。
- 激活/重置时清理过滤器状态，避免旧会话残尾进入新会话。

## 取舍

应用侧精确过滤能保留用户已配置的直连工具功能，也不需要修改外部 Pi 配置或引入跨平台配置写入。将过滤放在已有 Pi 兼容层，能复用既有 CLI 上下文判定和统一输出转换路径。代价是依赖上游 advisory 的稳定格式；匹配器会保持严格，格式变化时宁可保留提示并避免误删正常内容。

## 验证策略

单元回归测试直接验证过滤器的分帧行为和兼容层的 Pi/非 Pi 边界；源代码契约测试继续确认实时、回放、恢复都经过 `transformOutput`。交付前执行定向 Node 测试、TypeScript 检查、架构检查，并按终端规范列出人工在真实 Windows/WSL 全屏 Pi TUI 中验证的场景。
