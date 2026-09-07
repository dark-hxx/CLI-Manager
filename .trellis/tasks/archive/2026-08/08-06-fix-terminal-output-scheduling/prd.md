# 彻底修复多会话持续输出卡死

## Goal

在 PR #197 已合并的基础上，消除多终端同时持续输出时 WebView 主线程被连续 xterm 写入长期占用的问题，同时保持 PTY 帧顺序、Replay/Reset 屏障和 write callback 后 ACK 契约。

## Requirements

- Changelog Target: `[TEMP]`。
- daemon 按完整 PTY 安全块聚合 live 输出，正常输出帧严格控制在 64 KiB 预算内，禁止因追加下一块而越过预算。
- 前端所有终端共享公平调度器，每个动画帧只启动一个 xterm live write；可见终端优先，但隐藏终端不得饥饿。
- 单终端内继续按完整 frame、FIFO 顺序消费；Replay、Reset、重连和 ACK 时序不变。
- 隐藏终端继续维护完整 xterm buffer，并沿用 PR #197 的隐藏 TUI 扫描抑制和重新可见时补同步。
- 不新增依赖，不修改 PTY/WebSocket 协议字段，不改变用户可见文案。

## Acceptance Criteria

- [ ] daemon 的 40 KiB + 40 KiB 安全块被发送为两个输出帧，不再聚合为约 80 KiB。
- [ ] 两个终端同时有待写数据时，同一动画帧只启动一个 `terminal.write()`。
- [ ] 连续可见输出存在时，隐藏终端仍按有界轮询获得执行机会。
- [ ] 每个 delivery 仅在对应 xterm write callback 后 commit 一次，且 sequence/FIFO 顺序不变。
- [ ] Replay、Reset、resize、visibility 和 TUI 颜色同步回归测试通过。
- [ ] `npx tsc --noEmit`、相关 Node 测试、Rust 定向测试、`cargo fmt -- --check`、`cargo check` 通过。
- [ ] `CHANGELOG.md` 的 `[TEMP]` 记录本次行为修复。

## Root-Cause Statement

问题位于 daemon 输出聚合与前端多终端写入调度边界：daemon 可生成显著大于前端预算的 live frame，且每个终端独立 RAF 会在同一浏览器帧内集中执行，因此修复必须同时落在上游帧聚合和跨终端调度层。

## Scenario Matrix

- 单会话 / 多会话 / 多 Workspan：均保持输出顺序，多会话采用公平轮询。
- 当前 Tab / 隐藏 Tab / 分屏可见终端：可见终端优先，隐藏终端不丢输出且不饥饿。
- 本地 PowerShell、CMD、Pwsh、WSL、Bash：共用 PTY 输出链路，不按 shell 分支处理。
- Replay、Reset、断线重连、重挂载：继续作为现有屏障处理。
- 正常窗口、失焦、最小化：调度只依赖终端可见性，不依赖窗口焦点。

## Discovery List

- `src-tauri/src/pty/manager.rs`：确认 reader 以 ANSI/UTF-8 安全边界交付；本次不改。
- `src-tauri/src/daemon/server.rs`：修改 live 输出聚合预算和跨块携带逻辑。
- `src/terminal/transport/PtyHostSocket.ts`：确认二进制 frame 解码与队列；协议不改。
- `src/terminal/core/TerminalProcessManager.ts`：确认 commit/ACK 顺序；本次不改。
- `src/hooks/useTerminalDisplay.ts`：修改多终端 RAF 调度，保留单终端 FIFO 与屏障。
- `src/components/XTermTerminal.tsx`、`src/lib/terminalTuiColorSync.ts`：PR #197 已处理隐藏扫描；确认无需继续修改。
- `scripts/terminalReplay.test.mjs`、Rust `daemon::server::tests`：补充回归覆盖。

## Out of Scope

- 修改 xterm、ConPTY、daemon 协议版本或依赖。
- 暂停隐藏终端解析、丢弃后台输出或提前 ACK。
- 对异常超长且没有中间 ANSI 安全边界的单个控制序列强行切割。
