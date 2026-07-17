# VS Code 终端替换第二轮正确性加固

## Goal

在不恢复旧 Tauri PTY 输出链路、不新增依赖的前提下，将当前 VS Code 风格 PtyHost/WebSocket 终端架构补齐到可证明的顺序、所有权、流控和重连正确性，保证活跃会话输出不丢失、不重复、不乱序。

## Root-Cause Statement

问题位于 xterm Display、WebSocket 客户端与 daemon PTY 三层之间的异步所有权边界：帧接收、回放、live 转发、xterm 提交和 ACK 没有统一的顺序屏障与生命周期协议，因此修复必须落在跨层协议和队列所有权处，而不能只在组件卸载、resize 或重连症状处加兜底。

## Discovery List

- [x] 前端传输：`src/terminal/transport/PtyHostSocket.ts`
- [x] 前端进程编排：`src/terminal/core/TerminalProcessManager.ts`
- [x] 前端 resize：`src/terminal/browser/TerminalResizeDebouncer.ts`
- [x] Display/xterm 生命周期：`src/hooks/useTerminalDisplay.ts`、`src/components/XTermTerminal.tsx`
- [x] 会话关闭与恢复：`src/stores/terminalStore.ts`
- [x] 协议定义：`src-tauri/src/daemon/protocol.rs`
- [x] daemon attach、writer、ACK、流控：`src-tauri/src/daemon/server.rs`
- [x] daemon 客户端与发现：`src-tauri/src/daemon/client.rs`、`src-tauri/src/daemon/discovery.rs`
- [x] PTY 生命周期与 reader：`src-tauri/src/pty/manager.rs`、`src-tauri/src/pty/platform/*`
- [x] Tauri 启动/命令注册：`src-tauri/src/lib.rs`、`src-tauri/src/commands/terminal.rs`
- [x] hook 路径：确认仅需在同步冲突中保留 daemon 收口契约，不恢复旧 app-local PTY 输出路径

## Requirements

- Attach 必须严格按 replay → attached → live 顺序交付；注册订阅到完成 attached 交接期间产生的 live 帧必须暂存。
- output 帧由进程管理层持有，直到 xterm `write` callback 完成才 ACK；Display 卸载、Pane 移动或重挂不得清空未提交帧。
- replay 中的历史 resize 只恢复 xterm 状态，不得转发给 live PTY；回放完成后按当前容器尺寸强制 fit/resize。
- resize 使用独立递增 sequence，重连按各自 sequence 去重，不得因 output sequence 过滤而遗漏尺寸变化。
- close/closeAll 建立 tombstone；失败或断线后不得把 UI 已关闭会话重新 attach。
- WebSocket auth、request、心跳均有有界超时；5 秒心跳、15 秒无 Pong 失联，重连后按 sequence 去重 attach。
- daemon Socket IO 不得持全局 clients 锁；慢客户端只能阻塞自身 writer queue。
- 活跃会话输出不得因固定 2 MiB 内存 ring 静默裁剪；内存阈值后落磁盘 spool，并受总量/清理策略约束。
- create 的检查、预留和插入必须原子；重复 session id 不得创建两个 PTY。
- PTY reader 即使持续读满缓冲区也须在最多 5ms 内 flush。
- reconcile 不得依据当前 UI active list 误杀 daemon 后台会话；只有显式关闭或明确孤儿条件才能终止。
- 保留上游 cc-connect、单实例和现有 hook 能力；生产依赖中不恢复 `portable-pty`。
- 用户可见文案如有变化，必须同步 `zh-CN`/`en-US`；本任务原则上不新增文案。
- Changelog 记录写入 `[TEMP]`。

## Scenario Matrix

- 窗口：前台、失焦、最小化、托盘、应用退出后重启 attach。
- Pane：普通 Tab、同窗口分屏、深层 split、Pane 移动导致 XTerm 卸载重挂。
- 会话：单会话、多会话、Workspan 切换、隐藏 Tab 持续输出。
- 环境：PowerShell/CMD/pwsh、Git Bash、WSL；Unix PTY 契约由 Rust 测试和真实平台 CI 覆盖。
- 生命周期：create 响应丢失、attach 中持续输出、close 断线、daemon 断线重连、后台会话 reconcile。
- hook：Claude/Codex hook 均安装、仅一个安装、均未安装；终端传输行为保持一致。

## Acceptance Criteria

- [x] Attach 并发输出测试证明 replay/live 无丢失、重复或乱序。
- [x] xterm ACK 只在 write callback 后发出，卸载重挂后未提交帧仍可继续写入和 ACK。
- [x] replay resize 不触发 live PTY resize，回放结束恢复当前容器尺寸。
- [x] close/closeAll 失败与重连测试证明 tombstone 会话不再 attach。
- [x] auth/request/heartbeat 超时和自动重连测试通过。
- [x] daemon 慢客户端不会阻塞其他客户端；流控和 spool 测试证明活跃输出不静默裁剪。
- [x] create 原子预留、reader 5ms flush、后台 reconcile 回归测试通过。
- [x] `node --test scripts/ptyHostSocket.test.mjs scripts/terminalProcessManager.test.mjs scripts/terminalReplay.test.mjs scripts/terminalVisibility.test.mjs scripts/terminalWorkspan.test.mjs` 通过（30 项）。
- [x] `npx tsc --noEmit`、`cargo check`、`cargo test` 通过（Rust 全量 447 项）；Unix 平台构建仍需真实 macOS/Linux CI。
- [x] GitNexus 索引已重建；最终 `detect_changes(scope=unstaged)` 显示本轮 12 个文件、77 个符号、5 条受影响流程，风险 MEDIUM，均属于预期终端/daemon/测试触点。共享工作树 staged 汇总仍为 CRITICAL（37 个文件、217 个符号），包含进入本任务前已有的终端替换与 WSL 子 Agent 改动，已明确保留并向用户报告。
- [x] `[TEMP]` CHANGELOG、功能清单和相关 Trellis 契约同步更新。
