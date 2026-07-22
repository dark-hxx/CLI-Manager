# 增强 PTY daemon 断连诊断与重连提示

Changelog Target: `V1.3.1`

## Goal

保留 `pty-daemon` 作为终端主链路不变，只补强断连诊断、重连日志和前端提示，减少用户看到裸 `PtyHost WebSocket disconnected` 时的误判。

## Background

- 用户确认：`pty-daemon` 是终端主链路，正常使用也要启动；不是只有“转入后台继续”才启动。
- 本机日志显示：`pty-daemon` 曾非正常退出，随后 WebSocket 断开，前端写入时报 `PtyHost WebSocket disconnected`。
- `src-tauri/src/lib.rs:791` 已说明 `PtyHost` 是唯一生产终端路径，启动时后台线程会 `connect_or_spawn` daemon。
- `src/App.tsx:1276` 附近的后台模式只是退出行为分流，不是 daemon 启动开关。
- GitNexus 索引过期，`npx gitnexus analyze` 因缺 `tree-sitter-kotlin` 无法刷新；本任务使用现有 GitNexus 局部结果、契约文档和源码搜索降级完成发现。

## Root Cause

问题发生在 `PtyHostSocket` 的 daemon/WebSocket 边界：真正的故障先出现在 daemon 退出或连接断开，前端写入失败只是症状，所以修复落在连接生命周期诊断和断连提示上，而不是改 daemon 启动策略。

## Requirements

- 终端主链路仍然走 `pty-daemon`，不改成“只有后台启动才起 daemon”。
- daemon/WebSocket 断连时要记录可定位的诊断信息，至少包含关闭原因、认证状态、挂起请求数、挂起 checkpoint 数和是否已有会话在重连。
- 心跳超时、断连重试、重连成功/失败都要有日志。
- 前端在可恢复的断连场景下要给出更准确的重连提示，不再只暴露裸错误字符串。
- 新增或修改的用户可见文案必须同步 `zh-CN` 和 `en-US`。
- 变更只落在终端传输/提示层，不改 daemon 启动模型或 PTY 创建契约。

## Discovery List

- `src/terminal/transport/PtyHostSocket.ts`：连接、心跳、断连、重连日志与错误分类。
- `src/components/XTermTerminal.tsx`：断连类写入失败提示。
- `src/lib/i18n.ts`：新增中英文提示文案。
- `CHANGELOG.md`：记录 `V1.3.1`。
- `src-tauri/src/lib.rs`：确认 daemon 正常启动模型，不修改。
- `src/App.tsx`：确认后台模式只是退出行为，不修改。

## Out of Scope

- 不修改 daemon 是否启动的模型。
- 不把 PTY 切回进程内实现。
- 不新增依赖。
- 不修改 Rust daemon 服务端日志体系。

## Acceptance Criteria

- [x] 终端断连时，日志里能直接看出是 close / error / heartbeat timeout 哪一类。
- [x] 重连尝试、重连成功、重连失败都能在日志中追踪。
- [x] 用户再次操作终端时，断连类错误提示会显示“正在重连/连接已断开”之类的明确状态，而不是只给出裸 WebSocket 错误。
- [x] `V1.3.1` changelog 记录这次修复。
