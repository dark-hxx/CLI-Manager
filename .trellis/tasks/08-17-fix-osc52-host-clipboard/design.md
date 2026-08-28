# 设计：OSC 52 宿主剪贴板

## 数据流

```
PTY live frame
  -> useTerminalDisplay.normalize(..., applyOsc52: true)
  -> unwrap tmux DCS
  -> parse OSC 52
  -> strip from visible output
  -> onOsc52Write -> copyTextToClipboard   (if write setting on)
  -> onOsc52Query -> bounded queue -> readClipboard -> recheck permission -> PTY write formatOsc52Reply (if explicit query setting remains on and reply is within the payload limit)
Replay/reset uses applyOsc52: false.
```

## 决策

- 解析放在已有纯函数层 `terminalOscParse.ts`，副作用留在 hook / XTermTerminal；回复格式化在纯函数层拒绝超过 2,000,000 个 Base64 字符的 payload。
- 读写剪贴板共享最多 32 个待执行操作的队列；查询在原生读取完成后再次确认授权，读取授权不参与备份/同步。
- 颜色查询契约改为：OSC 52 由前端剪贴板宿主消费；OSC 10/11 仍禁止 React 写 PTY。
- 鼠标默认 `mouseEventsRequireAlt: true`，恢复 V1.3.2 与 #211 的宿主选区优先。
- DevTools 检查元素只在 `.xterm` 内捕获 `Ctrl+Shift+C` 并 `preventDefault`；终端处理器负责复制。
