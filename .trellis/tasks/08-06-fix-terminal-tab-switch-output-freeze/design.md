# 多会话持续输出时切换 Tab 卡死：修复设计

## 背景

CLI-Manager 同时打开多个聊天会话时，如果其中一个会话正在持续输出，切换到另一个会话 Tab 可能使整个 App 长时间无响应。该问题在 Claude/Codex 等高频刷新终端界面中更容易出现。

这里的“会话”指 Manager 中的聊天终端会话，不是绘画窗口，也不是窗口大小变化导致的滚动问题。

## 根因

这是前端 WebView 主线程的输出调度缺陷，不是用户操作不当，也不是会话游标不一致。

1. `TerminalTabs` 保持所有会话的 `XTermTerminal` 挂载，隐藏 Tab 只设置 `display: none`；这是为了保留 xterm buffer 和 PTY 输出连续性。
2. `useTerminalDisplay.flushPendingWrites()` 会把当前所有连续 live frame 无上限合并为一个字符串，再交给一次 `terminal.write()`。持续输出时，这个字符串可以不断变大。
3. xterm.js 的内部时间片只在不同 write buffer 项之间让出主线程；一个超大 `terminal.write()` 仍可能在单次解析中长时间占用主线程。
4. 每个会话都有独立的动画帧队列；写入完成后，`XTermTerminal` 还会执行 TUI 颜色/背景扫描并重新排帧。隐藏会话也会执行这些后处理。
5. 多会话叠加后，React 的 Tab 切换、布局和输入事件得不到及时调度，表现为 App 卡死。

PTY ACK 仍必须等待 xterm `write` callback，不能提前 ACK；隐藏会话也不能停止解析或丢弃输出，否则会破坏 daemon 背压、Replay 和重连语义。

## 目标

- 持续输出会话存在时，切换其他会话 Tab 保持响应。
- 限制单次 xterm 解析任务的大小，并在批次之间让出主线程。
- 隐藏会话继续维护完整 xterm buffer，不丢失、不重复、不乱序。
- 保持 Replay、Reset、断线重连、ACK 和 daemon 背压契约不变。
- 会话重新可见时，TUI 颜色和背景显示正确。

## 非目标

- 不暂停隐藏会话的 xterm 解析。
- 不提前发送 PTY ACK。
- 不修改 daemon 协议、PTY 边界、ConPTY 或 xterm 版本。
- 不引入跨所有终端的全局调度器；先用局部有界调度解决已确认的无界批处理根因。

## 方案

### 1. Live 输出有界批处理

在 `useTerminalDisplay` 的 live 输出队列中增加批次预算，按完整 PTY frame 边界合并，目标预算约为 `64 KiB` 原始输出字节。达到预算后立即结束当前批次，不再继续清空队列。

单个 frame 即使超过预算也独立处理，避免在前端再次切割 daemon 已保证 ANSI/UTF-8 安全的 frame。每次 `terminal.write()` callback 完成后，按原有顺序提交该批次 frame 的 ACK，再通过下一动画帧继续处理剩余队列。

Replay 和 Reset 仍然是批处理屏障：它们不会与普通 live frame 合并，且保持现有尺寸恢复和提交顺序。

### 2. 隐藏会话降低 TUI 后处理优先级

隐藏会话仍然写入 xterm 并维护 buffer，但不在每次写入或 xterm render/scroll 事件后执行 TUI 颜色扫描。会话切换为可见时，沿用可见性恢复 effect 做一次同步和刷新。

这样不会改变隐藏会话的内容，只减少不可见状态下的重复 cell 扫描；可见会话仍保持当前颜色修正行为。

### 3. 保持输出契约

- 每个 frame 继续通过现有 `TerminalOutputDelivery.commit()` 提交。
- 只有 xterm write callback 完成后才 ACK。
- 队列仍按 sequence/FIFO 顺序消费。
- worktree、分屏、历史会话重挂载继续由 `TerminalProcessManager` 保留未提交 frame。

## 数据流

```text
PTY daemon output frame
  -> PtyHostSocket / TerminalProcessManager
  -> useTerminalDisplay pending queue
  -> bounded live batch (frame boundary, 64 KiB target)
  -> xterm.write(batch)
  -> write callback
  -> commit frames + ordered ACK
  -> next animation frame / hidden low-priority turn
```

## 场景矩阵

| 场景 | 预期行为 |
|---|---|
| 单会话持续输出 | 维持现有输出顺序和吞吐，不出现无界单次 write |
| 多会话，仅一个会话输出 | 输出会话继续解析，切换 Tab 可及时响应 |
| 多会话同时输出 | 各会话批次有界，不因单个会话清空全部队列而阻塞 UI |
| 普通 shell / Claude / Codex TUI | 均保持完整输出；TUI 颜色在可见时正确 |
| 前台 Tab / 后台 Tab | 前台正常后处理；后台保留 buffer 并降低 TUI 扫描 |
| 分屏 / Workspan / 历史会话重挂载 | 未提交 frame 不丢失，新 Display 可继续接管 |
| Replay / Reset / 断线重连 | 保持屏障、尺寸恢复、ACK 和 sequence 语义 |
| UTF-8 / ANSI 边界 | 不在 daemon frame 内切割，不产生乱码或控制序列污染 |

## 验证策略

先添加失败测试证明现状会把连续 live frame 无界合并；再实现最小有界批处理并验证：

- 每批不超过目标预算（单个超预算 frame 除外）。
- 多批按顺序 write，前一批 callback 前不启动下一批。
- 每个 frame 只提交和 ACK 一次，顺序不变。
- Replay、Reset 和 live 输出屏障不变。
- 隐藏会话跳过 TUI 后处理，可见时补做一次同步。

静态验证包括 `npx tsc --noEmit`、`npm run build`、`git diff --check`；手动验证包括多会话高频输出、Tab/分屏/Workspan 切换和断线重连。
