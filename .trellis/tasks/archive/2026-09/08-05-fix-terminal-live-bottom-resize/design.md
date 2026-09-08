# 终端横向缩放后实时底部恢复设计

## 背景

CLI-Manager 在 Windows 窗口最大化、还原，或打开和关闭统计、Git 等右侧面板时，会改变 xterm 容器宽度。若用户在小窗口中位于会话实时底部，横向 reflow 与随后到达的 Codex 全屏重绘可能使公开的 `viewportY` 与 xterm 内部滚动意图失配，最终让视口停在会话顶部。用户手动滚到底部后，后续缩放通常恢复正常。

现有 `TERM-F05` 只为正在查看历史的视口注册 marker，并假定实时底部由 xterm 自动跟随。当前缺陷位于这一未覆盖的实时底部分支。

## 目标

- 横向缩放前位于实时底部的 normal buffer，在 reflow 和后续终端输出后继续跟随最新内容。
- 正在查看历史时继续使用现有 marker 保持原逻辑行，不被强制拉到底部。
- alternate buffer、仅纵向 resize 和尺寸未变化时不增加滚动干预。
- 不访问或修改 xterm 的 `_core`、`isUserScrolling` 等私有 API。

## 方案

在 `useTerminalDisplay.resizeTerminal()` 调用 `terminal.resize()` 前记录用户的滚动意图：

- `buffer.type === "normal" && buffer.viewportY === buffer.baseY` 表示实时底部。
- `buffer.type === "normal" && buffer.viewportY < buffer.baseY` 表示正在查看历史。

历史分支保留现有 marker 逻辑。实时底部分支在 resize 后立即调用一次公开的 `terminal.scrollToBottom()`，并复用双 `requestAnimationFrame` 的异步恢复周期，在 xterm 完成 DOM viewport 同步后再次调用。第一次调用尽快恢复内部跟随意图；第二次调用覆盖 resize 引起的延迟 scroll 事件。

待执行的恢复任务必须与当前 terminal 实例绑定。后续 resize、组件卸载或 display 状态重置会取消旧任务，避免过期任务修改新实例。

## 数据流

```text
ResizeObserver / 面板开关 / 窗口缩放
  -> FitAddon.proposeDimensions()
  -> TerminalResizeDebouncer
  -> resizeTerminal()
     -> 记录 live-bottom 或 history 意图
     -> terminal.resize()
     -> live-bottom: 立即 + 双帧 scrollToBottom()
     -> history: 双帧 scrollToLine(marker.line)
  -> onResize
  -> PTY resize
  -> Codex/ConPTY redraw
```

## 边界与错误处理

- marker 或 terminal 已失效时静默取消恢复，并释放 marker。
- 连续 resize 只保留最新恢复任务。
- `scrollToBottom()` 使用 xterm 公共 API；即使公开坐标已经在底部，也能重新建立实时跟随状态。
- 不改变 PTY resize、daemon replay、输入转发或 alternate buffer 行为。

## 测试策略

- 先增加失败测试：实时底部横向 resize 后模拟异步 viewport 停在顶部，再确认双帧恢复回到新 `baseY`。
- 保留并验证历史 marker 测试，防止实时底部修复破坏历史阅读位置。
- 增加 alternate buffer、纵向 resize、连续 resize 取消旧任务的边界测试。
- 修正 fake terminal 中“resize 必然自动跟随底部”的写死前提，使测试能够表达真实回归。
- 执行 `node --test scripts/terminalReplay.test.mjs`、`npx tsc --noEmit`，并在可用时通过真实 Vite/Tauri 窗口复测最大化、还原和右侧面板开关。

## 非目标

- 不升级 xterm 版本。
- 不修改 daemon 或 ConPTY 协议。
- 不重构终端输出队列或渲染屏障。
