# 修复 Codex CLI 输出中断导致终端提前显示结束（Issue #245）

## Goal

修复 CLI-Manager 在 Codex CLI 持续输出期间，终端 UI 看起来已经结束/停止刷新、但 Codex 进程仍在执行的问题。窗口重新回到前台后，积压输出应能继续显示，且现有会话回放、ACK、退出状态和重连行为不回归。

目标版本：`V1.3.9`。

## Root-cause lane

这是行为性、跨前端 WebView 与 Rust daemon 边界的时序 bug，按根因修复处理。

根因陈述：当 Tauri WebView 进入 hidden/background 状态时，前端全局终端写入调度器仅依赖 `requestAnimationFrame`，浏览器会暂停或显著延迟 rAF；因此 xterm `terminal.write` 的完成回调没有执行，`TerminalProcessManager` 无法提交帧并发送 ACK。daemon 的 `CLIENT_OUTPUT_HIGH_WATERMARK=100_000` 又让 PTY 输出 worker 在等待 ACK 时阻塞，最终反压到 `DaemonPtyEventSink` 的有界通道和 PTY reader。后续 Codex 仍可完成并写入自身 rollout/history，但输出链路卡在 PTY/daemon 与前端提交之间，造成“终端显示结束、任务实际仍在执行”。

发现清单：

1. Issue #245 的现场为 Codex CLI、内置终端、macOS；历史记录完整，问题集中在实时显示链路。
2. `src/hooks/useTerminalDisplay.ts` 的全局 scheduler 只用 rAF 调度 `flushPendingWrites`；每个 queued chunk 只有在 xterm 写入回调中才 `commit`。
3. `src/terminal/core/TerminalProcessManager.ts` 的 `drainCommittedOutput` 只在 commit 后调用 `ptyHostSocket.acknowledge`，ACK 时机本身符合“渲染完成后确认”的契约。
4. `src-tauri/src/daemon/server.rs` 当前在 `emit_daemon_output` 中先写入会话 buffer，再调用 `wait_for_output_capacity`；该等待位于 daemon PTY 输出 worker，能够阻塞 PTY reader 的有界事件通道。
5. daemon 已有按完整帧保存的 session ring/spool（内存 2 MiB、spool 10 MiB）和 replay 机制，可作为暂停客户端投递期间的持久化缓冲。
6. 现场约 100,671 个 UTF-16 字符与 100,000 高水位精确吻合；回到窗口后 backlog 清零并恢复 ACK，证明不是 Codex 进程提前退出或单纯渲染文案问题。

外部相似案例与结论：

1. Debian `gnome-terminal` Bug #1068339 报告了几乎相同的用户症状：终端最小化/不可见后，`ffmpeg` 最终阻塞在 PTY `write`；切回前台后输出恢复并追上进度。该问题最终定位到 VTE，并在上游修复。它证明“不可见终端消费停止，最终反压到正在运行的进程”是已知终端类故障。
2. VS Code Bug #322582 报告最小化主窗口后终端仍接收输入，但文本直到窗口恢复才显示；oh-my-pi Bug #1534 也报告 WSL 流式输出在最小化/恢复或 resize 前不可见。两者与本 issue 的“进程/通道继续工作、渲染/刷新滞后”表象一致，但具体实现原因不完全相同。
3. MDN、Chrome 和 WebKit 文档均说明后台/hidden 页面通常停止 rAF，并对 timer 做节流；WebKit 还明确提到 macOS App Nap。Tauri 当前 WebView API 文档进一步说明默认策略可能节流 timer，约数分钟后暂停甚至卸载 hidden view，且 `backgroundThrottling` 并非 Windows/Linux 通用能力。因此 timer fallback 是前端减缓方案，不能替代 daemon 侧解除 PTY producer 阻塞。
4. xterm.js 官方 flow-control 指南确认应使用 xterm `write` 完成回调作为 ACK/水位提交，并警告 WebSocket 层需自行维护一致的 ACK 计数，否则流控最终可能永久阻塞；这与本项目现场的 UTF-16 ACK + daemon 高水位链路吻合。

检索结论：没有找到“CLI-Manager + Codex CLI + 当前这组源码”已公开报告的完全相同案例；但已找到多个独立项目复现的同一类跨层模式，足以支持当前根因判断和“双保险”修复方向。

## Requirements

### Frontend scheduling

1. 文档可见时保留现有全局公平 scheduler 语义：多终端共享调度、可见终端优先但隐藏终端不饿死、每帧最多启动一个 xterm 写入。
2. 文档 hidden/background 时，为待处理的终端输出提供基于 timer 的 fallback（目标间隔约 250 ms）；不得让待处理写入永远依赖 rAF。
3. `visibilitychange` 时迁移/唤醒待处理调度，避免已经排队的 rAF 或 timer 成为悬挂句柄；卸载/取消时清理 rAF、timer 和监听器。
4. 保持现有 FIFO、replay/reset 边界以及“xterm 写入完成回调后才 commit/ACK”的契约，不提前 ACK。

### Daemon flow control

1. 高水位只暂停向单个慢客户端继续投递，不得阻塞 PTY reader、daemon 输出聚合 worker 或其他会话的输入/输出处理。
2. 客户端暂停期间，每个完整输出帧仍按现有 session buffer/spool 规则保存；已投递帧的 sequence/UTF-16 未确认数量只在实际入客户端 writer 队列时更新。
3. 客户端 ACK 下降到低水位后，按 sequence 顺序补发该客户端 `last_sent_sequence` 之后仍保留的输出，不重复已发送帧，不改变 daemon→前端现有协议格式。
4. 补发必须尊重现有 writer 队列上限、session buffer/spool 上限和客户端断开清理逻辑；超过保留窗口时沿用现有 replay/truncated 语义，不能以无限内存换取不阻塞。
5. 退出通知、attach barrier、replay/reset、resize 帧和 UTF-16 `char_count` 语义保持兼容。

### Scope and constraints

- 仅修复实时终端输出调度与 daemon 背压链路；不修改 Codex CLI、历史日志解析、数据库 schema 或协议版本。
- 不新增用户可见文案，因此本次无需新增 i18n key；若实现产生诊断/UX 文案，必须同步 `zh-CN` 与 `en-US`。
- 保留用户当前对 `AGENTS.md`、`CLAUDE.md` 的未提交修改。

## Scenario matrix

| 维度 | 必须覆盖的场景 | 期望 |
| --- | --- | --- |
| WebView 状态 | 前台可见、窗口失焦、最小化/隐藏、`document.visibilityState=hidden` | 输出持续可达；可见场景保持原有吞吐与公平性 |
| 终端拓扑 | 单会话、可见+隐藏多会话、全部终端均 hidden | 不重复、不乱序；隐藏会话不永久饿死 |
| 背压状态 | 低于高水位、跨过 100,000、ACK 降至 5,000、持续无 ACK | PTY 不被客户端 ACK 阻塞；恢复后补发 |
| 输出类型 | UTF-8/UTF-16 计数、ANSI 连续输出、空帧、resize、replay/reset | 边界与 `char_count` 正确，现有终端状态不回归 |
| 生命周期 | Codex 正常退出、输出积压后退出、detach/close、断线重连、重新 attach | 退出状态最终可见，重连能按现有机制恢复 |
| 运行环境 | PowerShell、本地 shell、WSL/SSH/worktree 启动的 CLI | 输出通道不依赖具体 shell、hook 或工作树 |
| hook 状态 | hook 已安装、未安装、仅实时 PTY 输出无 hook | hook 只影响状态上报，不改变 PTY 输出保障 |
| 资源上限 | session ring/spool 未超限、达到截断边界、writer 队列满 | 有界内存；沿用断开/截断保护，不死锁 |

## Acceptance Criteria

- [ ] 在 `document.visibilityState=hidden` 下持续产生大于 100,000 UTF-16 字符的 Codex/PTY 输出，daemon 输出 worker 和 PTY reader 不因 ACK 等待而停滞；前端通过 timer 持续消费，任务完成后无需重新打开窗口即可看到后续输出/退出状态。
- [ ] 客户端短暂无法消费时，恢复 ACK 到低水位后能按顺序补发 session buffer 中未发送帧；无重复、无乱序，超过保留窗口仍受现有上限保护。
- [ ] 保留 xterm 写入完成回调才 commit/ACK 的时序；现有 replay/reset、attach barrier、重连和 resize 测试通过。
- [ ] 新增前端 hidden-document 调度回归测试和 Rust daemon “背压只暂停客户端投递、不阻塞 PTY 输出”回归测试。
- [ ] `npx tsc --noEmit`、前端终端相关 Node 测试、`cargo fmt --check`、`cargo check`、相关 `cargo test` 通过。
- [ ] 更新 `CHANGELOG.md` 的 `V1.3.9` 条目和 `docs/功能清单.md` 的终端/PTY 功能板块；运行 GitNexus `detect_changes()` 确认变更范围。
- [ ] 不能把“timer 一定运行”作为验收前提；在 WebView 被操作系统彻底挂起时，以 daemon 有界缓存、退出状态和恢复后的 replay 作为最终保障。

## Out of scope

- 不承诺在操作系统彻底冻结 WebView/进程时仍以固定延迟刷新；daemon 侧会保持有界缓存并在客户端恢复后 replay。
- 不扩大 session replay buffer 或移除既有高水位/队列上限。
