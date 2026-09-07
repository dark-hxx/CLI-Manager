# 多终端输出公平调度设计

## 数据流

PTY reader 安全块 → daemon 64 KiB 有界聚合 → WebSocket frame → TerminalProcessManager → 全局前端调度器 → xterm write callback → delivery commit/ACK。

## 后端

将 daemon live 输出聚合预算收紧为 64 KiB。聚合器在接收下一安全块前判断 `pending.len() + next.len()`：若会超限，先发送当前 pending，再把 next 作为下一批起点。这样不会切割 reader 已保证安全的块，也不会因“先追加、后判断”越过预算。

## 前端

在 `useTerminalDisplay.ts` 模块内维护轻量全局调度队列：

- 每个 display 使用稳定 token 去重排队。
- 每个动画帧只选择一个 display 执行一次现有 `flushPendingWrites()`。
- 可见与隐藏请求分别 FIFO；最多连续执行 3 个可见批次，随后若有隐藏请求必须执行 1 个隐藏批次。
- xterm write callback 完成后，该 display 如仍有队列数据，再次进入队尾。
- dispose/reset 取消 token，防止卸载终端继续执行。

## 契约

- 调度器只决定“哪个 display 何时开始一次 write”，不改变 frame 内容和 commit 所有权。
- Replay/Reset 仍由 `flushPendingWrites()` 处理，调度器不识别协议语义。
- ACK 仍只发生在 write callback 后。
- 单个异常超长安全块不被强行拆分，避免破坏既有 ANSI/UTF-8 边界契约。

## 风险

- 全局单批/帧会降低峰值后台吞吐；通过 64 KiB × 刷新率的有界吞吐换取 UI 响应。
- 可见优先可能饿死后台；3:1 配额避免饥饿。
- 模块级状态必须在 dispose/reset 时清理；新增多 display 测试锁定。
