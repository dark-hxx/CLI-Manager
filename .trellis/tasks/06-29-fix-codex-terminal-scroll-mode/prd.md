## 背景

CLI-Manager 当前会为内置终端中的 Codex 启动命令和历史恢复命令默认追加 `--no-alt-screen`。
这会让 Codex TUI 的重绘内容进入外层终端 scrollback，导致用户既看到 Codex 自身内部滚动，又能在外层终端看到历史消息。

## 目标

- 内置终端中的 Codex 恢复使用默认 alternate screen 行为
- 避免外层 xterm 持续积累 Codex TUI 的重绘历史
- 保持 Claude 和普通 shell 行为不变

## 非目标

- 不新增设置项
- 不修改 xterm scrollback 配置
- 不调整 PTY/ConPTY 实现

## 实现范围

- 移除 `src/lib/projectStartupCommand.ts` 中对 Codex 默认追加的 `--no-alt-screen`
- 移除 `src/components/HistoryWorkspace.tsx` 中 `codex resume` 默认追加的 `--no-alt-screen`

## 验收标准

- 新开 Codex 会话时，不再默认带 `--no-alt-screen`
- 恢复 Codex 历史会话时，不再默认带 `--no-alt-screen`
- `npx tsc --noEmit` 通过
- 手动验证项明确列出
